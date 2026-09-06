// Short native input/save baseline on a disposable copy, never the input file.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const originalPath = process.env.MEO_PERF_DOCUMENT;
  const output = process.env.MEO_PERF_OUTPUT;
  assert.ok(originalPath && path.isAbsolute(originalPath) && output && path.isAbsolute(output));
  const workspace = path.join(output, 'workspace');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), workspace.toLowerCase());
  const original = fs.readFileSync(originalPath);
  const file = path.join(workspace, 'interaction-copy.md');
  assert.notEqual(path.resolve(file).toLowerCase(), path.resolve(originalPath).toLowerCase());
  let expected = [
    '# Native interaction baseline', '', 'BENCH_PARAGRAPH', '',
    '| Name | Value |', '| --- | --- |', '| probe | BENCH_CELL |', '',
    '```mermaid', 'flowchart LR', '  A --> B', '```', '',
    original.toString('utf8').replaceAll('\r\n', '\n')
  ].join('\n');
  fs.writeFileSync(file, expected);
  const uri = vscode.Uri.file(file);
  const report = { vscode: vscode.version, sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length, visible: process.env.MEO_PERF_VISIBLE === '1', autoSaveDelayMs: 1000, runs: [] };
  let browser;
  let traceSession;
  const coldInput = process.env.MEO_PERF_COLD_INPUT === '1';
  report.coldInput = coldInput;
  report.traced = process.env.MEO_PERF_TRACE === '1';
  const waitFor = async (predicate, label) => {
    const deadline = performance.now() + 15000;
    while (!await predicate()) {
      if (performance.now() > deadline) throw Error(`Timed out: ${label}`);
      await wait(20);
    }
  };
  try {
    await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    browser = await puppeteer.connect({ browserURL: process.env.MEO_PERF_BROWSER_URL, defaultViewport: null });
    if (report.traced) {
      assert.ok(coldInput, 'Interaction tracing requires ColdInput');
      traceSession = await browser.target().createCDPSession();
      await traceSession.send('Tracing.start', {
        categories: 'devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',
        transferMode: 'ReturnAsStream'
      });
    }
    const openedAt = performance.now();
    let openError;
    const opening = vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor').catch(error => { openError = error; });
    if (!coldInput) await opening;
    let frame;
    await waitFor(async () => {
      if (openError) throw openError;
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        try {
          if (await candidate.evaluate(() => !!document.querySelector('.editor-host .cm-content'))) { frame = candidate; return true; }
        } catch (error) {
          if (!/detached|Execution context was destroyed|Cannot find context/i.test(String(error))) throw error;
        }
      }
      return false;
    }, 'editor');
    const detectedAt = performance.now();
    report.openToEditorMs = detectedAt - openedAt;
    if (coldInput) {
      // Type at the editor's default first-line-end caret without replacing its
      // selection or waiting for layout/selection synchronization to settle.
      await frame.evaluate(traced => {
        const content = document.querySelector('.editor-host .cm-content');
        if (!content) throw Error('Missing cold-input editor');
        content.focus({ preventScroll: true });
        window.__coldPaint = null;
        const setupAt = performance.now();
        if (traced) performance.mark('meo-cold-setup');
        content.addEventListener('input', event => {
          const start = performance.now();
          if (traced) performance.mark('meo-cold-input');
          requestAnimationFrame(() => {
            const firstFrameAt = performance.now();
            if (traced) performance.mark('meo-cold-frame1');
            requestAnimationFrame(() => {
              const secondFrameAt = performance.now();
              if (traced) performance.mark('meo-cold-frame2');
              window.__coldPaint = { inputToPaintMs: secondFrameAt - start,
                inputToFirstFrameMs: firstFrameAt - start,
                betweenFramesMs: secondFrameAt - firstFrameAt,
                setupToInputEventMs: start - setupAt, trusted: event.isTrusted,
                textVisible: [...document.querySelectorAll('.editor-host .cm-line')].some(e => e.textContent === '# Native interaction baselinex') };
            });
          });
        }, { once: true, capture: true });
      }, report.traced);
      const issuedAt = performance.now();
      await frame.page().keyboard.type('x');
      await frame.waitForFunction(() => window.__coldPaint !== null);
      const paint = await frame.evaluate(() => window.__coldPaint);
      assert.ok(paint.textVisible, 'Cold input must be visible');
      assert.ok(paint.trusted, 'Cold input must use a browser input event');
      expected = expected.replace('# Native interaction baseline', '# Native interaction baselinex');
      report.runs.push({ phase: 'cold-input', detectedToInputCommandMs: issuedAt - detectedAt,
        commandToResultMs: performance.now() - issuedAt, ...paint });
      const scroller = await frame.$('.editor-host .cm-scroller');
      const box = await scroller.boundingBox();
      assert.ok(box);
      await frame.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const scrollStart = performance.now();
      const before = await frame.$eval('.editor-host .cm-scroller', e => e.scrollTop);
      await frame.page().mouse.wheel({ deltaY: 180 });
      await frame.waitForFunction(before => document.querySelector('.editor-host .cm-scroller').scrollTop !== before, {}, before);
      report.runs.push({ phase: 'cold-scroll', commandToObservedScrollMs: performance.now() - scrollStart });
      for (const mode of ['source', 'preview', 'live']) {
        const start = performance.now();
        await frame.click(`button[data-mode="${mode}"]`);
        await frame.waitForFunction(mode => {
          if (document.getElementById('app').dataset.mode !== mode) return false;
          return mode === 'preview'
            ? !document.querySelector('.editor-host').hasAttribute('data-preview-cover') && !!document.querySelector('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc')
            : !document.querySelector('.editor-host').hidden && !!document.querySelector('.editor-host .cm-content');
        }, { timeout: 30000 }, mode);
        report.runs.push({ phase: `cold-switch-${mode}`, readyMs: performance.now() - start });
      }
    }
    await opening;
    if (openError) throw openError;
    if (report.visible) await frame.page().bringToFront();
    report.environment = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, font: getComputedStyle(document.querySelector('.cm-content')).font, userAgent: navigator.userAgent }));
    const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
    report.extensionVersion = extension?.packageJSON.version;
    report.webviewEntrySha256 = createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'webview/dist/index.js'))).digest('hex');
    const doc = await vscode.workspace.openTextDocument(uri);
    const jump = async line => {
      await frame.$eval('.line-jump-input', (input, line) => { input.value = String(line); }, line);
      await frame.focus('.line-jump-input');
      await frame.page().keyboard.press('Enter');
      await wait(150);
    };
    await wait(1500);
    for (const phase of ['prose', 'table', 'mermaid']) {
      if (phase === 'prose') {
        await jump(3);
        await frame.evaluate(() => {
          const line = [...document.querySelectorAll('.editor-host .cm-line')].find(e => e.textContent === 'BENCH_PARAGRAPH');
          if (!line) throw Error('Missing probe paragraph');
          const range = document.createRange(); range.selectNodeContents(line); range.collapse(false);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          line.closest('.cm-content').focus({ preventScroll: true });
        });
        expected = expected.replace('BENCH_PARAGRAPH', 'BENCH_PARAGRAPHx');
      } else if (phase === 'table') {
        await jump(5);
        const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]';
        await frame.waitForSelector(selector);
        await frame.click(selector);
        await frame.$eval(selector, input => input.select());
        expected = expected.replace('BENCH_CELL', 'x');
      } else {
        await jump(8);
        const button = '.meo-mermaid-mode-btn';
        await frame.waitForSelector(button);
        await frame.click(button);
        await frame.waitForSelector('.meo-mermaid-editing-block .cm-content');
        await frame.click('.meo-mermaid-editing-block .cm-content');
        await frame.page().keyboard.down('Control');
        await frame.page().keyboard.press('End');
        await frame.page().keyboard.up('Control');
        expected = expected.replace('  A --> B', '  A --> Bx');
      }
      await frame.evaluate(() => {
        window.__inputPaint = null;
        document.addEventListener('input', () => {
          const start = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__inputPaint = { inputToPaintMs: performance.now() - start, foreground: document.hasFocus() && document.visibilityState === 'visible' };
          }));
        }, { once: true, capture: true });
      });
      await frame.page().keyboard.type('x');
      await frame.waitForFunction(() => window.__inputPaint !== null);
      const input = await frame.evaluate(() => window.__inputPaint);
      const saveStart = performance.now();
      await vscode.commands.executeCommand('workbench.action.files.save');
      await waitFor(() => !doc.isDirty && fs.readFileSync(file, 'utf8') === expected, 'manual save including embedded input');
      assert.equal(doc.getText(), expected);
      report.runs.push({ phase, ...input, manualSaveMs: performance.now() - saveStart });
    }
    await vscode.workspace.getConfiguration('files').update('autoSaveDelay', report.autoSaveDelayMs, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    await frame.click('button[data-mode="source"]');
    await frame.click('.editor-host .cm-content');
    await frame.page().keyboard.down('Control');
    await frame.page().keyboard.press('End');
    await frame.page().keyboard.up('Control');
    const autoStart = performance.now();
    await frame.page().keyboard.type('x');
    expected += 'x';
    await waitFor(() => !doc.isDirty && fs.readFileSync(file, 'utf8') === expected, 'delayed auto-save');
    assert.equal(doc.getText(), expected);
    report.runs.push({ phase: 'auto-save', inputToDiskMs: performance.now() - autoStart });
    report.passed = true;
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    if (traceSession) {
      let timer;
      let descriptor;
      let stream;
      try {
        const complete = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Trace completion timed out')), 15000);
          traceSession.once('Tracing.tracingComplete', event => { clearTimeout(timer); resolve(event); });
        });
        const [event] = await Promise.all([complete, traceSession.send('Tracing.end')]);
        stream = event.stream;
        descriptor = fs.openSync(path.join(output, 'interaction.trace.json'), 'w');
        while (true) {
          const chunk = await traceSession.send('IO.read', { handle: stream });
          fs.writeSync(descriptor, Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
          if (chunk.eof) break;
        }
      } catch (error) { report.traceError = String(error.stack || error); }
      finally {
        clearTimeout(timer);
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch (error) { report.traceError ??= String(error); }
        }
        if (stream) {
          try { await traceSession.send('IO.close', { handle: stream }); } catch (error) { report.traceError ??= String(error); }
        }
      }
    }
    browser?.disconnect();
    report.originalUnchanged = original.equals(fs.readFileSync(originalPath));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    assert.ok(report.originalUnchanged, 'Original document changed');
    if (report.traceError && !report.error) throw Error(report.traceError);
  }
};
