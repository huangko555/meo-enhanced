// Native saved-mode startup and directed-transition probe. Uses only disposable profiles.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

exports.run = async () => {
  const config = JSON.parse(fs.readFileSync(process.env.MEO_MODES_CASE, 'utf8'));
  const output = process.env.MEO_PERF_OUTPUT;
  const phase = process.env.MEO_MODES_PHASE;
  assert.ok(['seed', 'measure'].includes(phase));
  assert.equal(typeof config.optimization, 'boolean');
  assert.equal(typeof config.restore, 'boolean');
  assert.ok(path.isAbsolute(config.document) && path.isAbsolute(output));
  const original = fs.readFileSync(config.document);
  const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
  const result = {
    phase, case: config, vscode: vscode.version, node: process.version,
    documentUri: vscode.Uri.file(config.document).toString(), documentSha256: hash(original), driverSha256: hash(fs.readFileSync(__filename)),
    extensionAlreadyActiveAtHarnessEntry: extension?.isActive,
    launchToHarnessMs: Date.now() - Number(process.env.MEO_MODES_LAUNCHED_AT),
    scope: 'Native development window with a persisted isolated profile; hidden launch is requested, actual focus/visibility are recorded. Launch includes VS Code and test harness overhead; open readiness is polled, not exact first paint. OS cache is not cleared. Startup does not imply all rich resources settled.',
    opens: [], switches: [], splitEnables: []
  };
  let browser;
  let lastFrame;
  try {
    assert.ok(extension);
    result.builds = Object.fromEntries(['dist/extension.js', 'dist/export-runtime.js', 'webview/dist/index.js', 'webview/dist/index.css', 'webview/dist/mermaid.min.js']
      .map(file => [file, hash(fs.readFileSync(path.join(extension.extensionPath, file)))]));
    browser = await puppeteer.connect({ browserURL: process.env.MEO_PERF_BROWSER_URL, defaultViewport: null });
    const uri = vscode.Uri.file(config.document);
    const ready = async (frame, mode) => frame.waitForFunction(({mode, empty}) => {
      const app = document.getElementById('app');
      if (!app || (mode && app.dataset.mode !== mode)) return false;
      const selected = app.dataset.mode;
      if (document.querySelector(`button[data-mode="${selected}"]`)?.getAttribute('aria-selected') !== 'true') return false;
      const host = document.querySelector('.editor-host');
      if (!host || host.hasAttribute('data-preview-cover') || document.querySelector('.editor-surface')?.hasAttribute('data-source-preview-preparing')) return false;
      if (selected === 'preview') return document.querySelector('.preview-host')?.hidden === false
        && document.querySelector('.preview-status')?.hidden === true
        && !!document.querySelector('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc');
      const content = host.querySelector('.cm-content');
      return !host.hidden && !!content && (empty || !!content.textContent.trim());
    }, { timeout: 60000 }, { mode, empty: original.toString('utf8').trim().length === 0 });
    const snapshot = frame => frame.evaluate(() => {
      const mode = document.getElementById('app').dataset.mode;
      const preview = document.querySelector('.preview-frame')?.contentDocument;
      const scroller = mode === 'preview' ? preview?.scrollingElement : document.querySelector('.cm-scroller');
      const candidates = mode === 'preview' ? [...preview.querySelectorAll('[data-source-line]')]
        : [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')];
      const top = mode === 'preview' ? 0 : scroller.getBoundingClientRect().top;
      const first = candidates.find(element => element.getBoundingClientRect().bottom > top + 2);
      return {
        mode, width: innerWidth, height: innerHeight, scale: devicePixelRatio,
        foreground: document.hasFocus(), visibility: document.visibilityState,
        font: getComputedStyle(document.querySelector('.cm-content') ?? document.body).font,
        scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight, clientHeight: scroller?.clientHeight,
        firstContentTop: preview?.querySelector('[data-source-line]')?.getBoundingClientRect().top,
        approximateTopLine: Number(mode === 'preview' ? first?.getAttribute('data-source-line') : first?.textContent) || null,
        split: document.querySelector('.source-preview-button')?.getAttribute('aria-pressed') === 'true',
        liveSvgCount: document.querySelectorAll('.meo-mermaid-block svg').length,
        previewSvgCount: preview?.querySelectorAll('.meo-export-mermaid svg').length ?? 0
      };
    });
    const open = async (kind, expected) => {
      const started = performance.now();
      let failure;
      const opening = vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor', { preview: false })
        .catch(error => { failure = error; });
      let frame;
      const lookupErrors = new Set();
      const deadline = performance.now() + 60000;
      while (!frame && performance.now() < deadline) {
        if (failure) throw failure;
        for (const page of await browser.pages()) for (const candidate of page.frames()) {
          if (candidate === lastFrame || candidate.detached) continue;
          try { if (await candidate.evaluate(() => !!document.querySelector('#app[data-mode] .cm-content'))) { frame = candidate; break; } } catch (error) { lookupErrors.add(String(error)); }
        }
        if (!frame) await wait(25);
      }
      if (!frame) result.frameLookupErrors = [...lookupErrors];
      assert.ok(frame, 'No editor frame');
      lastFrame = frame;
      await ready(frame, expected);
      const openToReadyMs = performance.now() - started;
      const launchToReadyMs = Date.now() - Number(process.env.MEO_MODES_LAUNCHED_AT);
      await opening;
      if (failure) throw failure;
      const initial = await snapshot(frame);
      assert.equal(initial.split, false, 'A fresh Webview must start with Source split disabled');
      let readingPositionReadyMs = null;
      let minimumRestoreScrollTop = null;
      if (phase === 'measure') {
        const seed = JSON.parse(fs.readFileSync(path.join(output, 'seed.json'), 'utf8'));
        if (config.restore && seed.restorationCoverage === 'non-top') {
          minimumRestoreScrollTop = seed.minimumRestoreScrollTop;
          await frame.waitForFunction(minimum => {
            const mode = document.getElementById('app').dataset.mode;
            const scroller = mode === 'preview' ? document.querySelector('.preview-frame').contentDocument.scrollingElement : document.querySelector('.cm-scroller');
            return scroller.scrollTop > minimum;
          }, {timeout:10000}, minimumRestoreScrollTop);
          readingPositionReadyMs = performance.now() - started;
        }
      }
      await wait(600);
      const settled = await snapshot(frame);
      if (minimumRestoreScrollTop !== null) {
        assert.ok(settled.scrollTop > minimumRestoreScrollTop, 'Restored position must survive the settled snapshot');
      }
      // Preview may align the first block by removing page-top whitespace.
      // Require the first content to remain fully visible, not an exact margin.
      const atStart = settled.scrollTop <= 2
        || (settled.mode === 'preview' && settled.firstContentTop >= -2);
      if (!config.restore && !atStart) result.failedOpen = { initial, settled };
      if (!config.restore) assert.ok(atStart, 'Restore disabled must keep the first content visible');
      result.opens.push({ kind, expected, openToReadyMs, readingPositionReadyMs, launchToReadyMs: kind === 'process-open' ? launchToReadyMs : undefined, initial, settled,
        resources: await frame.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\.(js|css)(\?|$)/.test(entry.name)).map(entry => ({
          name: entry.name.split('/').pop(), startTime: entry.startTime, duration: entry.duration, transferSize: entry.transferSize
        }))) });
      lastFrame = frame;
      return frame;
    };
    const close = async () => {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
      assert.equal(tabs.length, 1);
      assert.ok(await vscode.window.tabGroups.close(tabs));
      await wait(250);
    };
    // VS Code replaces the inner Webview document during bootstrap. Query its
    // current document instead of Puppeteer's cached document ElementHandle.
    const click = async (frame, selector) => {
      const handle = await frame.evaluateHandle(selector => document.querySelector(selector), selector);
      try {
        assert.ok(handle.asElement(), `Missing control: ${selector}`);
        await handle.asElement().click();
      } finally { await handle.dispose(); }
    };
    const select = async (frame, mode) => {
      await click(frame, `button[data-mode="${mode}"]`);
      await ready(frame, mode);
    };
    const scroll = async frame => {
      // Mode projection can finish after ready. Seed with trusted wheel input,
      // which cancels pending viewport projection just like an actual reader.
      await wait(600);
      const amount = await frame.evaluate(() => {
        const mode = document.getElementById('app').dataset.mode;
        const scroller = mode === 'preview' ? document.querySelector('.preview-frame').contentDocument.scrollingElement : document.querySelector('.cm-scroller');
        return Math.max(0, scroller.scrollHeight - scroller.clientHeight) * .4;
      });
      const surface = await frame.evaluateHandle(() => document.querySelector(
        document.getElementById('app').dataset.mode === 'preview' ? '.preview-frame' : '.cm-scroller'
      ));
      try {
        assert.ok(surface.asElement(), 'Missing scroll surface');
        await surface.asElement().hover();
        await frame.page().mouse.wheel({ deltaY: amount });
      } finally { await surface.dispose(); }
      // Setup is outside the measured interval. The launcher verifies that the
      // production idle writer actually persisted this position before restart.
      await wait(5000);
      return snapshot(frame);
    };
    let frame = await open('process-open', phase === 'seed' ? null : config.expectedMode);
    if (phase === 'seed') {
      await select(frame, config.savedMode);
      result.seedPosition = await scroll(frame);
      await close();
    } else {
      assert.equal(result.opens[0].initial.mode, config.expectedMode, 'Saved/default initial mode');
      result.restoredPosition = result.opens[0].settled;
      // Same-process reopen exercises fresh Webview state with an already active Host.
      await close();
      frame = await open('warm-reopen', config.expectedMode);
      const modes = ['live', 'source', 'preview'];
      for (const split of [false, true]) {
        if (split) {
          await select(frame, 'source');
          const started = performance.now();
          await click(frame, '.source-preview-button');
          await frame.waitForFunction(() => document.querySelector('.source-preview-button')?.getAttribute('aria-pressed') === 'true'
            && !document.querySelector('.editor-surface')?.hasAttribute('data-source-preview-preparing')
            && document.querySelector('.preview-status')?.hidden === true
            && !!document.querySelector('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'), {timeout:60000});
          result.splitEnables.push({ readyMs: performance.now() - started });
        }
        const startMode = config.expectedMode;
        await select(frame, startMode);
        const others = modes.filter(mode => mode !== startMode);
        let from = startMode;
        // Euler tour covers all six directed edges exactly once per split state.
        for (const to of [others[0], others[1], startMode, others[1], others[0], startMode]) {
          await wait(200);
          if (from === 'source') assert.equal((await snapshot(frame)).split, split, 'Source split before transition');
          const started = performance.now();
          await select(frame, to);
          const readyMs = performance.now() - started;
          const state = await snapshot(frame);
          if (to === 'source') assert.equal(state.split, split, 'Source split after transition');
          result.switches.push({ from, to, split, readyMs, state });
          from = to;
        }
      }
      await select(frame, config.savedMode);
      await scroll(frame);
      await close();
    }
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    result.failureViews = [];
    result.extensionActiveAtFailure = extension?.isActive;
    result.tabsAtFailure = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({
      active: tab.isActive, kind: tab.input?.constructor?.name
    }));
    if (browser) for (const page of await browser.pages()) for (const candidate of page.frames()) {
      try {
        result.failureViews.push(await candidate.evaluate(() => ({
          title: document.title, url: location.href, mode: document.getElementById('app')?.dataset.mode,
          app: !!document.getElementById('app'), editor: !!document.querySelector('.cm-content'), selectorMatches: !!document.querySelector('#app[data-mode] .cm-content'),
          readyState: document.readyState, text: document.body?.innerText.slice(0,600)
        })));
      } catch (inspectionError) { result.failureViews.push({ unavailable: String(inspectionError) }); }
    }
    if (lastFrame) result.failureState = await lastFrame.evaluate(() => ({
      top: document.querySelector('.preview-frame')?.contentDocument?.scrollingElement?.scrollTop,
      mode: document.getElementById('app')?.dataset.mode
    })).catch(() => null);
    throw error;
  }
  finally {
    browser?.disconnect();
    result.originalUnchanged = original.equals(fs.readFileSync(config.document));
    fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify(result, null, 2));
    assert.ok(result.originalUnchanged, 'Probe must not edit the original');
  }
};
