const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const { createPointerDriver } = require('./native-input-delivery.cjs');

exports.run = async () => {
  const output = process.env.MEO_RESOURCE_OUTPUT;
  assert.ok(output && path.isAbsolute(output));
  const result = { passed: false, vscode: vscode.version, cases: [], errors: [] };
  const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
  assert.ok(extension);
  result.builds = Object.fromEntries(['dist/extension.js', 'webview/dist/index.js', 'webview/dist/shiki-highlight-worker.js', 'webview/dist/onig.wasm']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, file))).digest('hex')]));
  const browser = await puppeteer.connect({ browserURL: process.env.MEO_RESOURCE_BROWSER_URL, defaultViewport: null });
  let activeFrame;
  try {
    for (const page of await browser.pages()) {
      page.on('pageerror', error => result.errors.push(String(error)));
      page.on('console', async message => {
        if (message.type() !== 'error' || !message.text().includes('[MEO webview]')) return;
        const args = await Promise.all(message.args().map(arg => arg.evaluate(value => value instanceof Error ? value.stack
          : value && typeof value === 'object' ? JSON.stringify(value, (_key, item) => item instanceof Error ? { message: item.message, stack: item.stack } : item)
          : String(value)).catch(() => message.text())));
        result.errors.push(args.join(' '));
      });
    }
    await vscode.workspace.getConfiguration('meoEnhanced').update('performance.largeDocumentOptimization', true, vscode.ConfigurationTarget.Global);
    const colorsReady = () => {
      const colors = [...document.querySelectorAll('.editor-host span[style]')]
        .filter(span => ['const', 'fixtureAlpha', '"fixture value"'].includes(span.textContent))
        .map(span => getComputedStyle(span).color);
      return colors.length >= 3 && new Set(colors).size >= 3;
    };
    const sourceReady = () => document.getElementById('app')?.dataset.mode === 'source'
      && !!document.querySelector('.editor-host .cm-editor.meo-mode-source .cm-line span[class]')
      && document.querySelector('.editor-loading')?.hidden === true
      && document.querySelector('.editor-host')?.inert === false;
    const previewReady = () => {
      const doc = document.querySelector('.preview-frame')?.contentDocument;
      return !!doc?.querySelector('.meo-export-code-line-source[data-meo-shiki] span[style]')
        && document.querySelector('.preview-loading')?.hidden === true
        && document.querySelector('.preview-host')?.hidden === false && doc.documentElement.inert === false;
    };
    const documentLength = () => document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.length;
    for (const large of [false, true]) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const code = 'const fixtureAlpha = "fixture value";\n'
        + (large ? Array.from({ length: 8500 }, (_, index) => `const row${index} = { value: "${'content'.repeat(16)}", count: ${index} };\n`).join('') : 'console.log(fixtureAlpha);\n');
      const original = '# Resource integration\n\n```typescript\n' + code + '```\n\n'
        + '$$\\frac{x^2}{2}+\\alpha$$\n\n```mermaid\nflowchart LR; A[Start]-->B[Finish]\n```\n';
      if (large) assert.ok(original.length > 1_048_576, 'large case must cross the production optimization budget');
      const file = path.join(output, 'workspace', large ? 'large.md' : 'ordinary.md');
      fs.writeFileSync(file, original);
      const record = { large, bytes: Buffer.byteLength(original), switches: {} };
      result.cases.push(record);
      const started = performance.now();
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor', { preview: false });
      let frame;
      const deadline = Date.now() + 30000;
      while (!frame && Date.now() < deadline) {
        for (const page of await browser.pages()) for (const candidate of page.frames()) {
          if (candidate.detached) continue;
          try { if (await candidate.evaluate(length => {
            const content = document.querySelector('#app[data-mode] .editor-host .cm-content');
            return content?.cmTile?.root?.view?.state?.doc?.length === length;
          }, original.length)) { frame = candidate; break; } } catch {}
        }
        if (!frame) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(frame, 'the production editor must open');
      activeFrame = frame;
      frame.page().setDefaultTimeout(30000);
      await frame.waitForFunction(() => !document.querySelector('.meo-preload-toolbar,.meo-preload-editor-shell'));
      await frame.page().bringToFront();
      const pointer = await createPointerDriver({frame,page:frame.page()});
      record.inputs = [];
      const click = async selector => {record.inputs.push({selector,receipt:await pointer.click(selector)});};
      await frame.evaluate(() => {
        globalThis.__resourceModeClicks = [];
        document.addEventListener('click', event => {
          const mode = event.target.closest?.('button[data-mode]')?.dataset.mode;
          if (mode) globalThis.__resourceModeClicks.push(mode);
        }, true);
      });
      record.initialMode = await frame.evaluate(() => document.getElementById('app')?.dataset.mode);
      if (record.initialMode === 'source') {
        await frame.waitForFunction(sourceReady);
        record.initialSourceMs = performance.now() - started;
        await click('button[data-mode="live"]');
      } else if (record.initialMode === 'preview') {
        await frame.waitForFunction(() => document.querySelector('.preview-host')?.hidden === false
          && document.querySelector('.preview-loading')?.hidden === true
          && document.querySelector('.preview-frame')?.contentDocument?.documentElement.inert === false);
        record.initialPreviewMs = performance.now() - started;
        await click('button[data-mode="live"]');
      }
      await frame.waitForFunction(colorsReady);
      await frame.waitForFunction(() => document.getElementById('app')?.dataset.mode === 'live'
        && document.querySelector('.editor-loading')?.hidden === true && document.querySelector('.editor-host')?.inert === false);
      record.liveReadyMs = performance.now() - started;
      if (!large) await frame.waitForFunction(() => !!document.querySelector('.meo-mermaid-block svg') && !!document.querySelector('.katex'));
      await frame.page().screenshot({ path: path.join(output, large ? 'large-live.png' : 'ordinary-live.png') });
      let modeStarted = performance.now();
      await click('button[data-mode="source"]');
      await frame.waitForFunction(sourceReady);
      record.switches.sourceMs = performance.now() - modeStarted;
      const source = await frame.evaluate(() => {
        const view = document.querySelector('.editor-host .cm-content').cmTile.root.view;
        return { mountedLines: view.dom.querySelectorAll('.cm-line').length, lines: view.state.doc.lines, length: view.state.doc.length };
      });
      assert.equal(source.length, original.length);
      if (large) assert.ok(source.mountedLines < source.lines / 4, 'large Source must actually use bounded presentation');
      record.source = source;
      await frame.evaluate(() => {
        const view = document.querySelector('.editor-host .cm-content').cmTile.root.view;
        view.dispatch({ selection: { anchor: view.state.doc.line(1).to }, scrollIntoView: true });
        view.focus();
      });
      const marker = ' native edit';
      const page = frame.page();
      await frame.evaluate(() => {
        globalThis.__resourceExplicitSaveResults = [];
        window.addEventListener('message', event => {
          if (event.data?.type !== 'saveDocumentRevisionResult') return;
          globalThis.__resourceExplicitSaveResults.push({ ok: event.data.result?.ok === true,
            code: event.data.result?.error?.code ?? null });
        });
      });
      const assertExplicitSave = async (method, expectedText) => {
        const before = await frame.evaluate(() => globalThis.__resourceExplicitSaveResults.length);
        if (method === 'toolbar') {
          await frame.waitForFunction(() => {
            const button = document.querySelector('button[data-action="save"]');
            return button && !button.disabled;
          });
          await click('button[data-action="save"]');
        }
        else await control('s');
        await frame.waitForFunction(count => globalThis.__resourceExplicitSaveResults.length > count, {}, before);
        const receipt = await frame.evaluate(index => globalThis.__resourceExplicitSaveResults[index], before);
        assert.equal(receipt.ok, true, method + ': MEO must acknowledge explicit save even when its optional comparison baseline is too large');
        assert.equal(fs.readFileSync(file, 'utf8'), expectedText, method + ': exact saved contents');
        (record.explicitSaves ??= []).push({ method, ...receipt });
      };
      await page.keyboard.sendCharacter(marker);
      await frame.waitForFunction(length => document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.length === length, {}, original.length + marker.length);
      const control = async key => {
        await page.keyboard.down('Control');
        try { await page.keyboard.press(key); } finally { await page.keyboard.up('Control'); }
      };
      await control('z');
      await frame.waitForFunction(length => document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.length === length, {}, original.length);
      assert.equal(await frame.evaluate(documentLength), original.length, 'Source undo restores the original document');
      await control('y');
      await frame.waitForFunction(length => document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.length === length, {}, original.length + marker.length);
      const firstLineEnd = original.indexOf('\n');
      const edited = original.slice(0, firstLineEnd) + marker + original.slice(firstLineEnd);
      await assertExplicitSave('toolbar', edited);
      await control('z');
      await frame.waitForFunction(length => document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.length === length, {}, original.length);
      await assertExplicitSave('keyboard', original);
      await vscode.commands.executeCommand('workbench.action.files.save');
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'typing and history preserve the complete saved source');
      modeStarted = performance.now();
      await click('button[data-mode="preview"]');
      await frame.waitForFunction(previewReady);
      record.switches.previewMs = performance.now() - modeStarted;
      if (!large) await frame.waitForFunction(() => {
        const doc = document.querySelector('.preview-frame')?.contentDocument;
        return !!doc?.querySelector('.meo-export-mermaid.is-rendered svg') && !!doc?.querySelector('.katex');
      });
      modeStarted = performance.now();
      await click('button[data-mode="source"]');
      await frame.waitForFunction(sourceReady);
      record.switches.warmSourceMs = performance.now() - modeStarted;
      await click('.source-preview-button');
      await frame.waitForFunction(previewReady);
      await click('.source-preview-button');
      await click('button[data-mode="live"]');
      await frame.waitForFunction(colorsReady);
      record.wasmLoads = await frame.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/onig.wasm')).length);
      assert.equal(record.wasmLoads, 1, 'Live, Source, full Preview and side Preview share one Webview binary load');
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      record.passed = true;
    }
    assert.deepEqual(result.errors, [], 'native resource loading and mode changes must not report render errors');
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    if (error.code === 'native-input-unavailable') result.inputFailure = {stage:error.stage,evidence:error.evidence};
    if (activeFrame && !activeFrame.detached) result.state = await activeFrame.evaluate(() => ({ mode: document.getElementById('app')?.dataset.mode,
      loading: document.querySelector('.editor-loading')?.hidden, sourceTokens: document.querySelectorAll('.meo-source-token').length,
      hostHidden: document.querySelector('.editor-host')?.hidden,
      markup: document.querySelector('.editor-host .cm-content')?.innerHTML.slice(0, 1200),
      visible: document.visibilityState, focused: document.hasFocus(),
      textLength: document.querySelector('.editor-host .cm-content')?.cmTile?.root?.view?.state?.doc?.length,
      notices: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })).catch(() => null);
    if (activeFrame && !activeFrame.detached) result.modeClicks = await activeFrame.evaluate(() => globalThis.__resourceModeClicks).catch(() => null);
    if (activeFrame && !activeFrame.detached) await activeFrame.page().screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    browser.disconnect();
  }
};
