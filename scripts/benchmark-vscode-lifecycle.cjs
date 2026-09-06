// Native lifecycle samples; the optional guarded campaign adds a final GC diagnostic.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { execFileSync } = require('node:child_process');

exports.run = async () => {
  const file = process.env.MEO_PERF_DOCUMENT;
  const output = process.env.MEO_PERF_OUTPUT;
  const campaign = process.env.MEO_PERF_RESOURCE_CAMPAIGN === '1';
  if (campaign && (process.env.MEO_PERF_CONFIRM_LONG_RUN !== '1' || !path.isAbsolute(process.env.MEO_PERF_IMAGE || ''))) {
    throw Error('The resource campaign requires explicit long-run authorization and an absolute image path');
  }
  if (!file || !path.isAbsolute(file) || !output || !path.isAbsolute(output)) {
    throw Error('Absolute document/output paths are required');
  }
  const original = fs.readFileSync(file);
  const result = {
    vscode: vscode.version, sha256: hash(original), bytes: original.length,
    visible: process.env.MEO_PERF_VISIBLE === '1', campaign, runs: [],
    scope: 'One rich editor and one plain control editor; diagnostic, not endurance or a total-memory budget.',
    memoryScope: 'CDP heap and DOM counters belong to a target/isolate, not exclusively to a document; native/GPU memory is not measured.'
  };
  let browser;
  const clients = new Map();
  const frames = new Map();
  const uriLabels = new Map();
  let browserClient;
  try {
    browser = await puppeteer.connect({browserURL: process.env.MEO_PERF_BROWSER_URL, defaultViewport: null});
    if (campaign) browserClient = await browser.target().createCDPSession();
    const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
    result.extensionVersion = extension?.packageJSON.version;
    if (extension) result.builds = Object.fromEntries(['webview/dist/index.js', 'dist/extension.js', 'dist/export-runtime.js']
      .map(relative => [relative, hash(fs.readFileSync(path.join(extension.extensionPath, relative)))]));

    const snapshot = async phase => {
      const sample = {phase, at: performance.now(), editors: {}, targets: [], isolates: []};
      sample.tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
        active: tab.isActive, groupActive: group.isActive,
        label: tab.input instanceof vscode.TabInputCustom ? uriLabels.get(tab.input.uri.toString()) : undefined,
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
      if (browserClient) {
        const {processInfo} = await browserClient.send('SystemInfo.getProcessInfo');
        const ids = processInfo.map(process => Number(process.id));
        if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('Invalid process IDs from CDP');
        // IDs come from this isolated browser, never from a global name match.
        const values = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`],
          {encoding: 'utf8', windowsHide: true, timeout: 10000}).trim() || '[]');
        sample.processes = (Array.isArray(values) ? values : [values]).map(value => ({
          ...value, type: processInfo.find(process => Number(process.id) === value.Id)?.type
        }));
      }
      result.runs.push(sample);
      if (campaign && (!sample.isolates.length || !sample.processes.length
        || sample.targets.some(target => target.unavailable)
        || Object.values(sample.editors).some(editor => editor.unavailable))) {
        throw Error(`Incomplete resource sample: ${phase}`);
      }
    };
    const open = async (uri, label) => {
      uriLabels.set(uri.toString(), label);
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
            if (await candidate.evaluate(() => !!document.querySelector('.cm-content'))) {
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
    if (campaign) {
      await runResourceCampaign({output, result, frames, clients, open, snapshot});
      result.passed = true;
      return;
    }
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

async function runResourceCampaign({output, result, frames, clients, open, snapshot}) {
  result.scope = 'Eight rounds, three deterministic rich fixtures and one retained plain control; no network assets.';
  result.memoryScope = 'Heap deduplicated by isolate; Windows process private bytes and working set sampled separately. Shared working sets must not be summed as unique memory.';
  const workspace = path.join(output, 'workspace');
  const imageOriginal = fs.readFileSync(process.env.MEO_PERF_IMAGE);
  fs.copyFileSync(process.env.MEO_PERF_IMAGE, path.join(workspace, 'large' + path.extname(process.env.MEO_PERF_IMAGE)));
  fs.writeFileSync(path.join(workspace, 'small.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#437eb1"/></svg>');
  const prose = Array.from({length: 100}, (_, i) => `Paragraph ${i + 1}: stable text for resource lifecycle observation.\n`).join('\n');
  const sources = {
    control: '# Resource control\n\nRetained observer document.\n',
    prose: '# Small images\n\n' + Array.from({length: 4}, () => '![small](small.svg)\n').join('\n') + prose,
    diagrams: '# Diagrams\n\n' + Array.from({length: 12}, (_, i) => '```mermaid\nflowchart LR\n' +
      Array.from({length: 20}, (_, j) => `N${i}_${j} --> N${i}_${j + 1}`).join('\n') + '\n```\n').join('\n'),
    images: '# Large image\n\n![large](large' + path.extname(process.env.MEO_PERF_IMAGE) + ')\n\n' + prose
  };
  const uris = Object.fromEntries(Object.entries(sources).map(([label, source]) => {
    const name = path.join(workspace, `${label}.md`);
    fs.writeFileSync(name, source);
    return [label, vscode.Uri.file(name)];
  }));
  result.fixtures = Object.fromEntries(Object.entries(sources).map(([label, source]) => [label, {bytes: Buffer.byteLength(source), sha256: hash(source)}]));
  result.image = {bytes: imageOriginal.length, sha256: hash(imageOriginal)};
  result.rounds = [];
  const control = await open(uris.control, 'control');
  result.environment = await control.evaluate(() => ({width: innerWidth, height: innerHeight, scale: devicePixelRatio,
    font: getComputedStyle(document.querySelector('.cm-content')).font, userAgent: navigator.userAgent, foreground: document.hasFocus()}));
  const {targetInfo: controlTarget} = await control.client.send('Target.getTargetInfo');
  const labels = ['prose', 'diagrams', 'images'];
  await wait(2000);
  await snapshot('campaign-baseline');
  for (let round = 1; round <= 8; round++) {
    const record = {round, opens: [], returns: []};
    result.rounds.push(record);
    for (const label of labels) {
      const frame = await open(uris[label], label);
      const readyAt = performance.now();
      await frame.click('button[data-mode="preview"]');
      await frame.waitForFunction(() => document.getElementById('app')?.dataset.mode === 'preview'
        && !document.querySelector('.editor-host').hasAttribute('data-preview-cover')
        && !!document.querySelector('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc'), {timeout: 30000});
      await frame.waitForFunction(label => {
        const doc = document.querySelector('.preview-frame').contentDocument;
        if (label === 'diagrams') return doc.querySelectorAll('.meo-export-mermaid svg').length === 12;
        const images = [...doc.images];
        return images.length === (label === 'prose' ? 4 : 1)
          && images.every(img => img.complete && img.naturalWidth > 1 && !img.hasAttribute('data-meo-deferred-image-src'));
      }, {timeout: 45000}, label);
      record.opens.push({label, openToEditorMs: result[`${label}OpenToEditorMs`], previewContentReadyMs: performance.now() - readyAt});
    }
    await snapshot(`round-${round}-loaded`);
    for (const label of ['prose', 'diagrams', 'images', 'control']) {
      const started = performance.now();
      await vscode.commands.executeCommand('vscode.openWith', uris[label], 'meoEnhanced.editor', {preview: false});
      if (vscode.window.tabGroups.activeTabGroup.activeTab?.input.uri?.toString() !== uris[label].toString()) throw Error('Wrong tab activated');
      record.returns.push({label, commandMs: performance.now() - started});
    }
    await snapshot(`round-${round}-hidden-start`);
    await wait(5000);
    await snapshot(`round-${round}-hidden-end`);
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputCustom && labels.some(label => tab.input.uri.toString() === uris[label].toString()));
    if (tabs.length !== 3 || tabs.some(tab => tab.isDirty)) throw Error('Unexpected rich tab count or dirty document');
    const closingAt = performance.now();
    if (!await vscode.window.tabGroups.close(tabs)) throw Error('Rich tabs did not close');
    // Host close completion precedes Chromium's asynchronous frame teardown.
    for (let attempt = 0; attempt < 50 && labels.some(label => !frames.get(label).detached); attempt++) await wait(100);
    record.closeToDetachedMs = performance.now() - closingAt;
    for (const label of labels) {
      if (!frames.get(label).detached) throw Error(`Frame ${label} survived close`);
      frames.delete(label);
    }
    for (const id of clients.keys()) if (id !== controlTarget.targetId) clients.delete(id);
    await wait(5000);
    await snapshot(`round-${round}-closed`);
    for (const [label, source] of Object.entries(sources)) if (fs.readFileSync(uris[label].fsPath, 'utf8') !== source) throw Error('Fixture unexpectedly changed');
    fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify({completedRound: round, record, last: result.runs.at(-1)}, null, 2));
  }
  // This last diagnostic is outside every normal timing/cycle measurement.
  await snapshot('diagnostic-before-gc');
  await control.client.send('HeapProfiler.collectGarbage');
  await wait(2000);
  await snapshot('diagnostic-after-gc');
  result.imageUnchanged = imageOriginal.equals(fs.readFileSync(process.env.MEO_PERF_IMAGE));
  if (!result.imageUnchanged) throw Error('Original image changed');
}
