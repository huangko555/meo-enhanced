import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const large = process.argv.includes('--large');
const narrow = process.argv.includes('--narrow');
const appearance = narrow ? 'light' : 'dark';
const language = narrow ? 'zh-CN' : 'en';
const shellOnly = process.argv.includes('--shell-only');
const extensionSource = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const shellTemplate = (name: string): string => {
  const declaration = extensionSource.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  const value = declaration?.body?.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(value && ts.isNoSubstitutionTemplateLiteral(value), `${name} must supply the production shell template`);
  return value.text;
};
const markdown = 'Reference[^note].\n\n' + Array.from({ length: large ? 1600 : 30 }, (_, index) =>
  `## Section ${index + 1}\n\n` + 'Reading content for toolbar stability. '.repeat(8)
).join('\n\n') + '\n\n[^note]: Footnote destination.\n';
assert.equal(assessLargeDocument(markdown).windowedPreview, large);
const build = shellOnly ? null : await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser', format: 'iife' });
if (build && !build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = build ? await build.outputs[0]!.text() : '';
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const stage of ['preload', 'stylesheet'] as const) {
    const shell = await browser.newPage();
    await shell.setViewport({ width: 800, height: 520 });
    const css = stage === 'preload' ? shellTemplate('getWebviewPreloadShellCss') : readFileSync('webview/src/styles.css', 'utf8');
    await shell.setContent(`<!doctype html><style>${css}</style><div id="app" class="editor-root">${shellTemplate('getWebviewPreloadShellMarkup')}</div>`);
    const shellResult = await shell.evaluate(async () => {
      const toolbar = document.querySelector('.mode-toolbar')!;
      const before = toolbar.getBoundingClientRect();
      const input = document.createElement('input');
      input.style.cssText = 'position:absolute;top:200vh;left:150vw';
      document.querySelector('.editor-host')!.append(input);
      input.focus();
      input.scrollIntoView({ block: 'end', inline: 'end' });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const after = toolbar.getBoundingClientRect();
      const root = document.getElementById('app')!.getBoundingClientRect();
      const overflow = document.createElement('div');
      overflow.style.cssText = 'position:absolute;top:200vh;left:150vw;width:400px;height:800px';
      document.body.append(overflow);
      document.scrollingElement!.scrollTop = 40;
      document.body.scrollTop = 40;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const forced = toolbar.getBoundingClientRect();
      return { before: { top: before.top, left: before.left, height: before.height },
        focused: document.activeElement === input,
        after: { top: after.top, left: after.left, height: after.height },
        forced: { top: forced.top, left: forced.left, height: forced.height },
        root: { top: root.top, left: root.left, width: root.width, height: root.height } };
    });
    assert.equal(shellResult.focused, true, `${stage} must exercise a real native focus target`);
    assert.deepEqual(shellResult.after, shellResult.before, `${stage} focus/reveal moved the menu: ${JSON.stringify(shellResult)}`);
    assert.deepEqual(shellResult.forced, shellResult.before, `${stage} ancestor scrolling moved the menu`);
    assert.deepEqual(shellResult.root, { top: 0, left: 0, width: 800, height: 520 }, `${stage} shell must stay in the window`);
    await shell.close();
    console.log(`PASS ${stage} shell focus, reveal and ancestor scroll isolation`);
  }
  if (!shellOnly) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.setViewport({ width: narrow ? 420 : 1200, height: narrow ? 520 : 760 });
    await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${appearance}"><div id="app"></div></body>`);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
    let windowRequests = 0;
    let windowedRender = false;
    await page.exposeFunction('__toolbarStabilityHost', async (message: any) => {
      if (message.type === 'requestPreviewDocument') {
        windowRequests++;
        return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
          result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
      }
      if (message.type !== 'requestPreviewRender') return null;
      const options = { markdownText: message.text, sourceDocumentPath: 'C:/tmp/toolbar-stability.md',
        uiLanguage: message.uiLanguage, styleEnvironment: message.environment, preset: message.preset };
      windowedRender = Boolean(message.window);
      const parsed = message.window ? createPreviewDocument(message.requestId, options) : undefined;
      if (parsed) documents.set(message.requestId, parsed);
      return { type: 'previewRenderResult', requestId: message.requestId,
        result: { ok: true, value: parsed ? parsed.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options) } };
    });
    await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__toolbarStabilityHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(({ text, appearance, language }) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///toolbar-stability.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: language,
      sourceLineNumbers: 'on', previewAppearance: appearance, previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: appearance, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false,
      vscodeTheme: null
    } })), { text: markdown, appearance, language });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true
      && Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[id="fnref-1"]')));
    // A late or offscreen child must not turn the window shell into a second
    // document scroller. Keep the real Preview and trusted footnote navigation.
    await page.addStyleTag({ content: 'body::after,.editor-root::after{content:"";position:absolute;top:100%;width:1px;height:32px;pointer-events:none}' });
    assert.equal(windowedRender, large, 'production Preview must select the assessed rendering path');
    await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.mode-toolbar')!;
      const baseline = toolbar.getBoundingClientRect();
      const trace = (window as any).__toolbarStability = {
        baseline: { top: baseline.top, left: baseline.left, height: baseline.height },
        phase: 'footnotes',
        samples: [] as Array<{ phase: string; top: number; left: number; height: number; rootError: number;
          outerScroll: number; bodyScroll: number; rootScroll: number; wrapperScroll: number }>,
        stopped: false
      };
      const sample = () => {
        const box = toolbar.getBoundingClientRect();
        const root = document.getElementById('app')!.getBoundingClientRect();
        trace.samples.push({ phase: trace.phase, top: box.top, left: box.left, height: box.height,
          rootError: Math.max(Math.abs(root.top), Math.abs(root.left), Math.abs(box.right - root.right)),
          outerScroll: document.scrollingElement!.scrollTop, bodyScroll: document.body.scrollTop,
          rootScroll: document.getElementById('app')!.scrollTop,
          wrapperScroll: document.querySelector('.editor-wrapper')!.scrollTop });
        if (!trace.stopped) requestAnimationFrame(sample);
      };
      sample();
    });
    const frame = await (await page.$('.preview-frame'))!.contentFrame();
    assert.ok(frame);
    const phase = (name: string) => page.evaluate(name => { (window as any).__toolbarStability.phase = name; }, name);
    const painted = () => page.evaluate(async () => {
      for (let index = 0; index < 4; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    for (const selector of ['[id="fnref-1"]', '.footnote-index', '[id="fnref-1"]', '.footnote-backref']) {
      await frame.waitForSelector(selector, { visible: true });
      await frame.click(selector);
      const targetSelector = selector === '[id="fnref-1"]' ? '.footnote-item' : '[id="fnref-1"]';
      await page.waitForFunction(targetSelector => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const target = doc.querySelector(targetSelector);
        const rect = target?.getBoundingClientRect();
        return rect && rect.bottom > 0 && rect.top < doc.documentElement.clientHeight;
      }, {}, targetSelector);
      await page.evaluate(async () => {
        for (let index = 0; index < 12; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    }
    await phase('forced ancestor scroll');
    await page.evaluate(() => {
      document.scrollingElement!.scrollTop = 24;
      document.body.scrollTop = 24;
      document.getElementById('app')!.scrollTo(24, 24);
    });
    await painted();
    await page.evaluate(() => { document.scrollingElement!.scrollTop = 0; document.body.scrollTop = 0; });
    await phase('late overflow and native focus');
    await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const input = document.createElement('input');
      input.id = 'shell-focus-probe';
      input.style.cssText = 'position:absolute;top:200vh;left:150vw;width:400px;height:800px';
      document.querySelector('.editor-surface')!.append(input);
      input.focus();
      input.scrollIntoView({ block: 'end', inline: 'end' });
    });
    await painted();
    assert.equal(await page.$eval('#shell-focus-probe', element => document.activeElement === element), true,
      'the offscreen native control must receive focus without moving chrome');
    await page.$eval('#shell-focus-probe', element => element.remove());
    await phase('window resize');
    for (const viewport of [{ width: 600, height: 360 }, { width: 1000, height: 640 }]) {
      await page.setViewport(viewport);
      await painted();
      // CDP viewport metrics can precede or follow a resize's layout frame;
      // retain every-frame menu positions, then verify the accepted viewport size.
      assert.deepEqual(await page.$eval('#app', root => ({ width: root.getBoundingClientRect().width,
        height: root.getBoundingClientRect().height })), viewport);
    }
    const selectMode = async (mode: 'source' | 'live' | 'preview') => {
      await phase(`mode ${mode}`);
      await page.click(`[data-mode="${mode}"]`);
      await page.waitForFunction(mode => {
        const host = document.querySelector<HTMLElement>('.editor-host');
        return document.getElementById('app')?.dataset.mode === mode && (mode === 'preview'
          ? document.querySelector<HTMLElement>('.preview-status')?.hidden === true && host?.inert
          : !host?.inert && !host?.hidden && Boolean(host?.querySelector(`.cm-editor.meo-mode-${mode}`))
            && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);
      }, {}, mode);
      await painted();
    };
    for (const mode of ['source', 'live'] as const) {
      await selectMode(mode);
      await page.waitForFunction(expected => {
        const harness = (window as any).EditingSettingsHarness;
        const view = harness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        return harness.usesLargeDocumentDerivedWorkBudget(view.state) === expected;
      }, {}, large);
      await phase(`${mode} keyboard, focus and find`);
      await page.focus('.editor-host > .cm-editor .cm-content');
      await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
      await painted();
      await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
      await painted();
      const scroller = await page.$('.editor-host > .cm-editor .cm-scroller');
      const wheelPoint = await scroller!.boundingBox();
      assert.ok(wheelPoint);
      const beforeWheel = await scroller!.evaluate(element => element.scrollTop);
      await page.mouse.move(wheelPoint.x + wheelPoint.width / 2, wheelPoint.y + wheelPoint.height / 2);
      await page.mouse.wheel({ deltaY: 240 });
      await page.waitForFunction(before => document.querySelector('.editor-host > .cm-editor .cm-scroller')!.scrollTop > before, {}, beforeWheel);
      await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
      await page.waitForSelector('.find-panel .find-input', { visible: true });
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.type('.find-input', 'Section 20');
      await page.keyboard.press('Enter');
      await painted();
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
      await painted();
      assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView
        .findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), markdown,
      `${mode}: shell operations must preserve the document`);
    }
    await phase('menus and settings focus');
    await page.click('.more-tools-wrapper > .format-button');
    await page.click('.more-tools-settings-button');
    await page.waitForSelector('.settings-window[open]');
    await page.click('.settings-search');
    await page.keyboard.type('font');
    await painted();
    await page.click('.settings-close');
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('.settings-window')!.open);
    await selectMode('source');
    await phase('Source side Preview');
    await page.click('.source-preview-button');
    await page.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && document.querySelector<HTMLElement>('.preview-host')?.hidden === false);
    await painted();
    await page.click('.source-preview-button');
    await selectMode('preview');
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView
      .findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), markdown,
    'menus, settings and mode transitions must preserve the document');
    const trace = await page.evaluate(() => {
      const trace = (window as any).__toolbarStability;
      trace.stopped = true;
      return trace;
    });
    assert.equal(trace.baseline.top, 0, 'the menu starts at the window top');
    assert.ok(trace.samples.every((sample: any) => Math.abs(sample.top - trace.baseline.top) < 0.5
      && Math.abs(sample.left - trace.baseline.left) < 0.5 && Math.abs(sample.height - trace.baseline.height) < 0.5 && sample.rootError < 0.5),
    `editor operation moved the toolbar: ${JSON.stringify({ baseline: trace.baseline,
      changed: trace.samples.filter((sample: any) => sample.top !== trace.baseline.top || sample.rootError >= .5).slice(0, 4) })}`);
    assert.ok(trace.samples.every((sample: any) => sample.rootScroll === 0 && sample.wrapperScroll === 0
      && (sample.phase === 'forced ancestor scroll' || (sample.outerScroll === 0 && sample.bodyScroll === 0))),
      `native operations must keep scrolling inside their document viewport: ${JSON.stringify(trace.samples.filter((sample: any) => sample.rootScroll || sample.wrapperScroll || sample.outerScroll || sample.bodyScroll).slice(0, 4))}`);
    if (large) assert.ok(windowRequests > 0, 'distant footnote navigation must request a production Preview window');
    mkdirSync('tmp/toolbar-stability', { recursive: true });
    await page.screenshot({ path: `tmp/toolbar-stability/${large ? 'windowed' : 'ordinary'}.png` });
    console.log(`PASS ${large ? 'windowed' : 'ordinary'} ${language}/${appearance} shell stability across ${new Set(trace.samples.map((sample: any) => sample.phase)).size} phases (${trace.samples.length} frames)`);
  }
} catch (error) {
  primaryError = error;
  const page = (await browser.pages()).at(-1);
  if (page) console.error('Toolbar stability state', await page.evaluate(() => {
    const harness = (window as any).EditingSettingsHarness;
    const view = harness?.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    return { phase: (window as any).__toolbarStability?.phase, mode: document.getElementById('app')?.dataset.mode,
      budget: view ? harness.usesLargeDocumentDerivedWorkBudget(view.state) : null,
      scroll: view?.scrollDOM.scrollTop, settings: document.querySelector<HTMLDialogElement>('.settings-window')?.open };
  }));
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
