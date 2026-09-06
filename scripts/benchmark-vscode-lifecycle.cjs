// One read-only rich document, one disposable control tab, no forced GC.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

exports.run = async () => {
  const file = process.env.MEO_PERF_DOCUMENT;
  const output = process.env.MEO_PERF_OUTPUT;
  if (!file || !path.isAbsolute(file) || !output || !path.isAbsolute(output)) {
    throw Error('Absolute document/output paths are required');
  }
  const original = fs.readFileSync(file);
  const result = {
    vscode: vscode.version, sha256: hash(original), bytes: original.length,
    visible: process.env.MEO_PERF_VISIBLE === '1', runs: [],
    scope: 'One rich editor and one plain control editor; diagnostic, not endurance or a total-memory budget.',
    memoryScope: 'CDP heap and DOM counters belong to a target/isolate, not exclusively to a document; native/GPU memory is not measured.'
  };
  let browser;
  const clients = new Map();
  const frames = new Map();
  try {
    browser = await puppeteer.connect({browserURL: process.env.MEO_PERF_BROWSER_URL, defaultViewport: null});
    const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
    result.extensionVersion = extension?.packageJSON.version;
    if (extension) result.builds = Object.fromEntries(['webview/dist/index.js', 'dist/extension.js', 'dist/export-runtime.js']
      .map(relative => [relative, hash(fs.readFileSync(path.join(extension.extensionPath, relative)))]));

    const snapshot = async phase => {
      const sample = {phase, at: performance.now(), editors: {}, targets: [], isolates: []};
      sample.tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
        active: tab.isActive, groupActive: group.isActive,
        rich: tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === vscode.Uri.file(file).toString()
      })));
      for (const [label, frame] of frames) {
        if (frame.detached) { sample.editors[label] = {detached: true}; continue; }
        sample.editors[label] = await frame.evaluate(() => {
          const probe = window.__lifecycleProbe;
          const preview = document.querySelector('.preview-frame')?.contentDocument;
          const images = [...document.images, ...(preview ? preview.images : [])];
          return {
            visibility: document.visibilityState, focused: document.hasFocus(),
            mode: document.getElementById('app')?.dataset.mode,
            ticks: probe.ticks, events: probe.events.slice(),
            longTasks: probe.longTasks.slice(),
            previewHidden: document.querySelector('.preview-host')?.hidden,
            images: images.map(img => ({complete: img.complete, width: img.naturalWidth, height: img.naturalHeight,
              deferred: img.hasAttribute('data-meo-deferred-image-src')})),
            mermaidSvgs: document.querySelectorAll('.meo-mermaid-svg-wrapper svg').length + (preview?.querySelectorAll('.meo-export-mermaid svg').length || 0),
            mermaidRuntimeLoaded: typeof window.mermaid?.render === 'function'
          };
        }).catch(error => ({unavailable: String(error)}));
      }
      // Different webview targets can share an isolate. Never sum their heaps.
      const isolates = new Set();
      for (const [targetId, client] of clients) {
        try {
          const {id: isolateId} = await client.send('Runtime.getIsolateId');
          if (!isolates.has(isolateId)) {
            isolates.add(isolateId);
            sample.isolates.push({isolateId, heap: await client.send('Runtime.getHeapUsage'),
              dom: await client.send('Memory.getDOMCounters')});
          }
          const {metrics} = await client.send('Performance.getMetrics');
          sample.targets.push({targetId, isolateId, metrics: Object.fromEntries(metrics
            .filter(({name}) => ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','Timestamp'].includes(name))
            .map(({name, value}) => [name, value]))});
        } catch (error) { sample.targets.push({targetId, unavailable: String(error)}); }
      }
      result.runs.push(sample);
    };
    const open = async (uri, label) => {
      const started = performance.now();
      let openError;
      const opening = vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor', {preview: false})
        .catch(error => {openError = error;});
      let frame;
      for (let attempt = 0; attempt < 200 && !frame; attempt++) {
        if (openError) throw openError;
        candidates: for (const page of await browser.pages()) for (const candidate of page.frames()) {
          if (candidate.detached || [...frames.values()].includes(candidate)) continue;
          // VS Code can replace a bootstrap frame between enumeration and use;
          // Puppeteer's detached-frame guard may throw before returning a promise.
          try {
            const content = await candidate.$('.cm-content');
            if (content) {
              await content.dispose();
              frame = candidate;
              break candidates;
            }
          } catch (error) {
            if (!candidate.detached && !String(error).includes('Execution context was destroyed')) throw error;
          }
        }
        if (!frame) await wait(50);
      }
      if (!frame) throw Error(`No editor for ${label}`);
      frames.set(label, frame);
      result[`${label}OpenToEditorMs`] = performance.now() - started;
      const client = frame.client;
      const {targetInfo} = await client.send('Target.getTargetInfo');
      if (!clients.has(targetInfo.targetId)) {
        await client.send('Performance.enable');
        clients.set(targetInfo.targetId, client);
      }
      if (result.visible) await frame.page().bringToFront();
      await frame.evaluate(() => {
        const probe = window.__lifecycleProbe = {ticks: 0, events: [], longTasks: []};
        // Buffered entries include earlier document tasks when the browser supports them.
        const observer = new PerformanceObserver(list => probe.longTasks.push(...list.getEntries()
          .map(entry => ({at: entry.startTime, ms: entry.duration}))));
        observer.observe({type: 'longtask', buffered: true});
        setInterval(() => probe.ticks++, 100);
        document.addEventListener('visibilitychange', () => probe.events.push({at: performance.now(), visibility: document.visibilityState}));
      });
      await snapshot(`${label}-detected`);
      await opening;
      if (openError) throw openError;
      return frame;
    };
    const richUri = vscode.Uri.file(file);
    const rich = await open(richUri, 'rich');
    result.environment = await rich.evaluate(() => ({width: innerWidth, height: innerHeight,
      scale: devicePixelRatio, font: getComputedStyle(document.querySelector('.cm-content')).font,
      userAgent: navigator.userAgent, foreground: document.hasFocus()}));
    await wait(1500);
    await snapshot('rich-settled');
    const controlPath = path.join(output, 'workspace', 'lifecycle-control.md');
    fs.writeFileSync(controlPath, '# Lifecycle control\n\nA plain second editor used to hide and restore the rich document.\n');
    await open(vscode.Uri.file(controlPath), 'control');
    const groups = vscode.window.tabGroups.all;
    if (groups.length !== 1 || groups[0].tabs.length !== 2
      || groups[0].activeTab?.input.uri?.toString() !== vscode.Uri.file(controlPath).toString()) {
      throw Error('The control must replace the rich editor in the same tab group');
    }
    await snapshot('rich-hidden-start');
    await wait(1500);
    await snapshot('rich-hidden-end');
    const returnedAt = performance.now();
    await vscode.commands.executeCommand('vscode.openWith', richUri, 'meoEnhanced.editor', {preview: false});
    result.returnCommandMs = performance.now() - returnedAt;
    // document.visibilityState can stay visible while the Host tab is hidden.
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input.uri?.toString() !== richUri.toString()) {
      throw Error('Return command did not activate the rich editor');
    }
    await snapshot('rich-returned');
    const richTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === richUri.toString());
    if (!richTab) throw Error('Rich custom editor tab was not found');
    if (richTab.isDirty) throw Error('Read-only probe unexpectedly dirtied the rich document');
    if (!await vscode.window.tabGroups.close(richTab)) throw Error('Rich tab did not close');
    await wait(1500);
    await snapshot('rich-closed');
    result.richFrameDetached = rich.detached;
    if (!result.richFrameDetached) throw Error('Rich webview remained attached after its tab closed');
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); throw error; }
  finally {
    browser?.disconnect();
    result.originalUnchanged = original.equals(fs.readFileSync(file));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    if (!result.originalUnchanged) throw Error('Original document changed during the read-only lifecycle probe');
  }
};
