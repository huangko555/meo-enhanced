import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { saveClipboardImageFile } from '../src/host/clipboardImageSave';
import { createImageStorageHost, type ImageStorageContext } from '../src/host/imageStorage';
import type { ImageLocationRequest } from '../src/protocol/imageStorage';
import { defaultInputAssistance, editorCommandIds, insertCurrentTimeExampleId, insertCurrentTimeExampleName, type CustomShortcutAction } from '../src/foundation/editingPreferences';
import { createEditingPreferencesHost } from '../src/host/editingPreferences';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { version as productVersion } from '../package.json';
import { renderPreviewDocument } from '../src/export/runtime';
import type { PreviewPresetId } from '../src/foundation/previewPresets';
import { darkDefaultLiveStrongForeground } from '../src/shared/markdownContentStyles';
const logoDataUrl = 'data:image/png;base64,' + (await fs.readFile('logo.png')).toString('base64');
const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let page = await browser.newPage();
let imagePasteRoot: string | null = null;
const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
const channels = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
const luminance = (color: string) => channels(color).reduce((total, value, index) => {
  const channel = value / 255;
  const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return total + linear * [0.2126, 0.7152, 0.0722][index];
}, 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

async function clickImageMode(mode: string) {
  const selector = '.image-location-modes input[value="' + mode + '"]';
  await page.evaluate(selector => {
    const scope = window as any, events: unknown[] = [];
    let pressed: EventTarget | null = null;
    const record = (event: Event) => {
      if (event.type === 'pointerdown') pressed = event.target;
      events.push({ type: event.type, trusted: event.isTrusted,
        target: event.target === document.querySelector(selector), samePress: event.target === pressed });
    };
    for (const type of ['pointerdown', 'pointerup', 'click']) window.addEventListener(type, record, true);
    scope.__imageModeDelivery = { events, stop() {
      for (const type of ['pointerdown', 'pointerup', 'click']) window.removeEventListener(type, record, true);
    } };
  }, selector);
  try {
    // Viewport changes and path feedback can move this radio by one text line.
    // The locator waits for visible, stable geometry before its single gesture.
    await page.locator(selector).click();
    const events = await page.evaluate(() => (window as any).__imageModeDelivery.events);
    assert.deepEqual(events, ['pointerdown', 'pointerup', 'click'].map(type =>
      ({ type, trusted: true, target: true, samePress: true })), 'The mode radio must receive the complete trusted click');
    assert.equal(await page.$eval(selector, element => (element as HTMLInputElement).checked), true,
      'The delivered mode click must immediately select its input');
  } finally {
    await page.evaluate(() => { const scope = window as any; scope.__imageModeDelivery?.stop(); delete scope.__imageModeDelivery; }).catch(() => {});
  }
}
try {
  let imageContext: ImageStorageContext = { documentFsPath: path.join(os.tmpdir(), 'meo-image-notes', 'draft.md'), workspaceFsPath: path.join(os.tmpdir(), 'unrelated-workspace') };
  let imageWriteFailure = false;
  let imageChosenFolder: string | null = null;
  const imageHost = createImageStorageHost({
    read: () => imageContext,
    write: async (_resource, preferences) => {
      if (imageWriteFailure) throw new Error('fixture image write failure');
      imageContext = { ...imageContext, imageStorage: preferences };
    },
    selectFolder: async () => imageChosenFolder
  });
  const imagePages = new WeakSet<object>();
  const chord = async (key: string) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
  const openFixture = async (text = 'hello\n\n# Heading\n\ntext', mode: 'source' | 'live' = 'source', stubMermaid = false, outline: 'left' | 'right' | 'hidden' = 'hidden', legacyStrongColoring = false, largeDocumentOptimizationEnabled = false) => {
    if (!imagePages.has(page)) {
      await page.exposeFunction('__imageLocationHost', (request: ImageLocationRequest) => imageHost.handle(request, 'settings-document'));
      await page.exposeFunction('__imageSaveHost', async (request: {requestId: string; imageData: string; extension: string}) => {
        try {
          if (!imageContext.documentFsPath) throw new Error('Save the document as a local Markdown file before pasting images.');
          const saved = await saveClipboardImageFile({
            ...imageContext, documentFsPath: imageContext.documentFsPath,
            extension: request.extension, contents: Buffer.from(request.imageData.replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
          });
          return {type: 'savedImagePath', requestId: request.requestId, result: {ok: true, value: {path: saved.relativePath, fileName: saved.fileName}}};
        } catch (error) { return {type: 'savedImagePath', requestId: request.requestId, result: {ok: false, error: {code: 'operation-failed', message: String(error)}}}; }
      });
      await page.exposeFunction('__imageResolutionHost', async (request: {requestId: string; url: string}) => {
        let resolvedUrl = '';
        if (imageContext.documentFsPath) {
          const bytes = await fs.readFile(path.resolve(path.dirname(imageContext.documentFsPath), decodeURIComponent(request.url))).catch(() => null);
          if (bytes) resolvedUrl = 'data:image/png;base64,' + bytes.toString('base64');
        }
        return {type: 'resolvedImageSrc', requestId: request.requestId, result: {ok: true, value: {resolvedUrl}}};
      });
      imagePages.add(page);
    }
    await page.setViewport({ width: 1100, height: 780 });
    await page.setContent(`<!doctype html><meta name="meo-logo" content="${logoDataUrl}"><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>`);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    if (process.argv.includes('--latex-only')) {
      await page.evaluate(({ markdown, shiki, wasm }) => {
        document.body.dataset.meoMarkdownWorkerSrc = URL.createObjectURL(new Blob([markdown], { type: 'text/javascript' }));
        document.body.dataset.meoShikiWorkerSrc = URL.createObjectURL(new Blob([shiki], { type: 'text/javascript' }));
        document.body.dataset.meoShikiWasmSrc = URL.createObjectURL(new Blob([Uint8Array.from(atob(wasm), character => character.charCodeAt(0))]));
      }, { markdown: await fs.readFile('webview/dist/markdown-parse-worker.js', 'utf8'),
        wasm: (await fs.readFile('webview/dist/onig.wasm')).toString('base64'),
        shiki: await fs.readFile('webview/dist/shiki-highlight-worker.js', 'utf8') });
    }
    await page.addScriptTag({ content: `
      window.__messages=[]; window.__revision=0; window.__clipboard='';
      window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
        window.__messages.push(message);
        if(message.type==='requestPreviewRender' && window.__renderLatexPreview) {
          window.__renderLatexPreview(message).then(value=>window.dispatchEvent(new MessageEvent('message',{data:{type:'previewRenderResult',requestId:message.requestId,result:{ok:true,value}}})));
        }
        if(message.type==='extensionFeaturesRequest') {
          const state = window.__extrasState ?? {installed:false,version:'',features:[]};
          const failed = !!window.__extrasFail;
          if(!failed && message.action==='setEnabled') {
            const feature = state.features.find(feature => feature.id===message.id);
            if(feature) { feature.enabled=message.enabled; feature.active=message.enabled; }
          }
          queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'extensionFeaturesResult',requestId:message.requestId,state,failed}})));
        }
        if(message.type==='updateEditingPreferences') {
          const apply = () => {
          if(window.__failNextUpdate) {
            window.__failNextUpdate=false;
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision:window.__revision,result:{ok:false,error:{code:'operation-failed',message:'fixture write failure'}}}})));
            return;
          }
          try {
            window.__preferences=window.EditingSettingsHarness.changeEditingPreferences(window.__preferences,message.change,message.platform??'other');
            const revision=++window.__revision;
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision,result:{ok:true,value:window.__preferences}}})));
          } catch(error) {
            const stale = error instanceof window.EditingSettingsHarness.ShortcutConflictsChangedError;
            const result = stale
              ? {ok:false,error:{code:'shortcut-conflicts-changed',message:String(error)},preferences:window.__preferences}
              : {ok:false,error:{code:'operation-failed',message:String(error)}};
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision:window.__revision,result}})));
          }
          };
          if(window.__holdNextUpdate) { window.__holdNextUpdate=false; window.__flushUpdate=apply; } else apply();
        }
        if(message.type==='saveImageFromClipboard') {
          window.__imageSaveHost(message).then(response => window.dispatchEvent(new MessageEvent('message', {data: response})));
        }
        if(message.type==='resolveImageSrc') {
          window.__imageResolutionHost(message).then(response => window.dispatchEvent(new MessageEvent('message', {data: response})));
        }
        if(message.type==='imageLocation') {
          window.__imageLocationHost(message).then(response => {
            const reply = () => window.dispatchEvent(new MessageEvent('message', {data: response}));
            if(window.__holdImageReply && message.action==='preview') { window.__holdImageReply=false; window.__releaseImageReply=reply; }
            else reply();
          });
        }
        if(message.type==='editorService') {
          if((message.action==='environment' && window.__failNextEnvironment) || (message.action==='writeClipboard' && window.__failNextClipboardWrite)) {
            window.__failNextEnvironment=window.__failNextClipboardWrite=false;
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorServiceResult',requestId:message.requestId,result:{ok:false,error:{code:'operation-failed',message:'fixture failure'}}}}))); return;
          }
          const value=message.action==='environment'?{environment:window.__environment??{appName:'Visual Studio Code',appVersion:'1.140.0',system:'Windows 11 (10.0.26200)',architecture:'x64',remoteName:''}}:message.action==='links'?{candidates:window.__linkCandidates??[]}:{text:message.action==='readClipboard'?window.__clipboard:''};
          if(message.action==='writeClipboard') window.__clipboard=message.text;
          const reply=()=>queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorServiceResult',requestId:message.requestId,result:{ok:true,value}}})));
          if(message.action==='readClipboard' && window.__holdNextClipboardRead) { window.__holdNextClipboardRead=false; window.__flushClipboardRead=reply; }
          else if(message.action==='writeClipboard' && window.__holdNextClipboardWrite) { window.__holdNextClipboardWrite=false; window.__flushClipboardWrite=reply; } else reply();
        }
      }});
    ` });
    if (stubMermaid) await page.evaluate(() => { (window as any).mermaid = { initialize() {}, async render() { return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>' }; } }; });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    assert.equal(await page.$('.settings-window'), null, 'The production shell must defer the closed settings window');
    await page.evaluate(({ text, mode, outline, legacyStrongColoring, largeDocumentOptimizationEnabled }) => {
      const global = window as any; global.__preferences = { input: { ...global.EditingSettingsHarness.defaultInputAssistance }, shortcuts: {} };
      global.__initMessage = { type: 'init', documentId: 'file:///settings.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'zh-CN', uiLanguagePreference: 'zh-CN', automaticUiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, previewShowComments: false, editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null, editingPreferences: global.__preferences, editingPreferencesRevision: 0 };
      global.__initMessage.outlinePosition = outline === 'left' ? 'left' : 'right';
      global.__initMessage.outlineVisible = outline !== 'hidden';
      global.__initMessage.liveStrongColoring = legacyStrongColoring;
      global.__initMessage.largeDocumentOptimizationEnabled = largeDocumentOptimizationEnabled;
      window.dispatchEvent(new MessageEvent('message', { data: global.__initMessage }));
    }, { text, mode, outline, legacyStrongColoring, largeDocumentOptimizationEnabled });
  };
  if (process.argv.includes('--list-numbering-only') || process.argv.length === 2) {
    const source = '1. First\n9. Second';
    await openFixture(source);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')?.inert
      && !!document.querySelector('.editor-host > .cm-editor .cm-content'));
    await page.locator('.more-tools-wrapper > .format-button').click();
    await page.locator('.more-tools-settings-button').click();
    const switchSelector = '[data-setting="renumberOrderedLists"] [role="switch"]';
    for (const [language, theme, query, title] of [
      ['zh-CN', 'dark', '重新编号', '自动整理有序列表编号'],
      ['en', 'light', 'renumbering', 'Renumber ordered lists automatically']
    ]) {
      await page.locator('[data-tab="general"]').click();
      await page.locator(`[data-setting="language"] [data-value="${language}"]`).click();
      await page.locator('[data-tab="appearance"]').click();
      await page.locator(`[data-appearance-mode="${theme}"]`).click();
      await page.locator('[data-tab="typing"]').click();
      await page.locator('.settings-search').fill(query);
      assert.equal(await page.$eval(switchSelector, button => button.getAttribute('aria-label')), title);
      assert.equal(await page.$eval(switchSelector, button => button.getAttribute('aria-checked')), 'true');
      assert.ok(await page.$eval(switchSelector, button => {
        const row = button.closest('.settings-item')!;
        const text = row.querySelector('.settings-item-text')!.getBoundingClientRect();
        const control = button.getBoundingClientRect();
        return control.width > 0 && control.left >= text.right && row.scrollWidth <= row.clientWidth;
      }), 'the bilingual setting fits beside its switch');
      for (const enabled of [false, true]) {
        await page.locator(switchSelector).click();
        await page.waitForFunction(({ selector, enabled }) =>
          document.querySelector(selector)?.getAttribute('aria-checked') === String(enabled)
          && (window as any).__preferences.input.renumberOrderedLists === enabled,
        {}, { selector: switchSelector, enabled });
        assert.equal(await page.evaluate(() => (window as any).__preferences.input.lists), true);
      }
      await page.locator('.settings-search-clear').click();
    }
    await page.locator('.settings-close').click();
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView
      .findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), source);
    assert.deepEqual(errors, []);
    console.log('List numbering setting: bilingual search, layout, defaults and independent off/on passed');
    if (process.argv.includes('--list-numbering-only')) { await closeTestBrowser(browser); process.exit(0); }
  }
  if (process.argv.includes('--windows-shortcuts-only') || process.argv.length === 2) {
    const editorSnapshot = () => page.evaluate(() => {
      const scope = window as any;
      const view = scope.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const active = document.activeElement as HTMLElement | null;
      return { content: view.state.doc.toString(), head: view.state.selection.main.head, row: active?.dataset.tableRow, column: active?.dataset.tableCol };
    });
    const select = (text: string, range = false) => page.evaluate(({ text, range }) => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const from = view.state.doc.toString().indexOf(text);
      if (from < 0) throw new Error('Missing fixture text: ' + text);
      view.dispatch({ selection: { anchor: range ? from : from + 1, head: range ? from + text.length : from + 1 } });
      view.focus();
    }, { text, range });
    const press = async (key: string, ...modifiers: ('Control' | 'Alt' | 'Shift')[]) => {
      for (const modifier of modifiers) await page.keyboard.down(modifier);
      try { await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]); }
      finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
    };
    for (const [mode, large] of [['live', false], ['source', false], ['live', true], ['source', true]] as const) {
      await page.evaluate(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' }));
      const text = 'keep this\n\nstrike me\n\n| First | Second |\n| --- | --- |\n| alpha | one |\n| beta | omega |\n\nend'
        + (large ? '\n\nOrdinary paragraph in the rest of the document.'.repeat(4_200) : '');
      await openFixture(text, mode, false, 'hidden', false, large);
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden')
        && !document.querySelector('.editor-host')?.hasAttribute('inert'));
      const optimized = await page.evaluate(() => {
        const harness = (window as any).EditingSettingsHarness;
        return harness.usesLargeDocumentDerivedWorkBudget(harness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state);
      });
      assert.equal(optimized, large, `${mode}: expected document-scale policy`);
      await select('keep this', true);
      await press('k', 'Control', 'Shift');
      let snapshot = await editorSnapshot();
      assert.match(snapshot.content, /```[\s\S]*keep this[\s\S]*```/, `${mode}: code fences replace the old delete-line gesture`);
      await select('strike me', true);
      await press('5', 'Alt', 'Shift');
      assert.match((await editorSnapshot()).content, /~~strike me~~/, `${mode}: physical Digit5 toggles strikethrough`);
      const beforeWorkbenchActions = (await editorSnapshot()).content;
      await press('3', 'Control', 'Shift');
      await press('0', 'Control', 'Shift');
      const workbenchActions = () => page.evaluate(() => (window as any).__messages.filter((message: any) =>
        message.type === 'openFileTree' || message.type === 'resetWindowZoom'));
      assert.deepEqual(await workbenchActions(), [{ type: 'openFileTree' }], `${mode}: reset window zoom is unbound by default`);
      await page.evaluate(() => {
        const scope = window as any;
        scope.__preferences = { ...scope.__preferences, shortcuts: { resetWindowZoom: ['Ctrl + Alt + U'] } };
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged',
          preferences: scope.__preferences, revision: ++scope.__revision } }));
      });
      await press('u', 'Control', 'Alt');
      assert.deepEqual(await workbenchActions(), [{ type: 'openFileTree' }, { type: 'resetWindowZoom' }]);
      assert.equal((await editorSnapshot()).content, beforeWorkbenchActions);

      const enterCell = (row: number, col: number, text: string) => mode === 'live'
        ? page.click(`.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea[data-table-row="${row}"][data-table-col="${col}"]`)
        : select(text);
      const tableRows = () => editorSnapshot().then(state => state.content.split('\n').filter(line => line.startsWith('|')));
      await enterCell(2, 1, 'omega');
      await press('Tab');
      await page.waitForFunction(mode => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        if (view.state.doc.toString().split('\n').filter((line: string) => line.startsWith('|')).length !== 5) return false;
        if (mode === 'source') return view.state.doc.lineAt(view.state.selection.main.head).text === '|  |  |';
        const active = document.activeElement as HTMLElement | null;
        return active?.dataset.tableRow === '3' && active.dataset.tableCol === '0';
      }, {}, mode);
      assert.equal((await tableRows()).length, 5);
      const waitForRows = (length: number) => page.waitForFunction(length => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        return view.state.doc.toString().split('\n').filter((line: string) => line.startsWith('|')).length === length;
      }, {}, length);
      await press('z', 'Control');
      await waitForRows(4);
      await press('y', 'Control');
      await waitForRows(5);
      await enterCell(1, 0, 'alpha');
      await press('ArrowDown', 'Alt');
      let rows = await tableRows();
      assert.match(rows[2], /beta/, `${mode}: move the next row ahead of the current row`);
      assert.match(rows[3], /alpha/);
      await enterCell(2, 0, 'alpha');
      await press('ArrowUp', 'Alt');
      rows = await tableRows();
      assert.match(rows[2], /alpha/, `${mode}: move the current row back up`);
      await enterCell(1, 1, 'one');
      await press('Enter', 'Control');
      rows = await tableRows();
      assert.equal(rows.length, 6, `${mode}: Ctrl+Enter inserts a row`);
      assert.match(rows[3], /^\|\s+\|\s+\|$/);
      const waitForInsertedCell = () => page.waitForFunction(mode => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        const { head } = view.state.selection.main;
        if (mode === 'source') {
          const row = view.state.doc.lineAt(head);
          return row.text === '|  |  |' && head - row.from === 5 && view.state.doc.line(row.number - 1).text === '| alpha | one |';
        }
        const active = document.activeElement as HTMLTextAreaElement | null;
        return active?.dataset.tableRow === '2' && active.dataset.tableCol === '1'
          && active.value === '' && active.selectionStart === 0 && active.selectionEnd === 0;
      }, { timeout: 4000 }, mode);
      await waitForInsertedCell();
      await press('z', 'Control');
      await waitForRows(5);
      await press('y', 'Control');
      await waitForInsertedCell();
      await enterCell(1, 0, 'alpha');
      await press('Enter', 'Shift');
      if (mode === 'live') {
        await page.waitForFunction(() => (document.activeElement as HTMLTextAreaElement | null)?.value.includes('\n'));
      } else assert.match((await editorSnapshot()).content, /<br\s*\/?>/);
      assert.equal((await tableRows()).length, 6, `${mode}: Shift+Enter stays in the cell`);
      assert.deepEqual(errors, []);
      await page.close();
      page = await browser.newPage();
      page.on('pageerror', error => errors.push(String(error)));
    }
    for (const mode of ['source', 'live'] as const) for (const large of [false, true]) {
      for (const shortcut of ['Ctrl+Enter', 'Tab', 'Alt+Down'] as const) {
        const label = `${mode}/${large ? 'optimized' : 'ordinary'}/${shortcut}`;
        const windowed = mode === 'live' && large;
        const rowCount = windowed ? 544 : 80;
        const table = ['| A | B |', '| --- | --- |',
          ...Array.from({ length: rowCount }, (_, index) => windowed && shortcut === 'Tab' && index < rowCount - 1
            ? '|  |  |' : `| row-${index} | cell-${index} |`)].join('\n');
        const movingRow = shortcut === 'Alt+Down';
        const sourceRow = movingRow ? rowCount - 1 : rowCount;
        const sourceCell = `cell-${sourceRow - 1}`;
        const fixture = 'Intro\n\n' + table + '\n\n' + 'After the table.\n\n'.repeat(large ? 4300 : 50);
        await page.evaluate(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' }));
        await openFixture(fixture, mode, false, 'hidden', false, large);
        await page.setViewport({ width: 1080, height: 340 });
        await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden')
          && !document.querySelector('.editor-host')?.hasAttribute('inert'));
        await select(sourceCell);
        await page.evaluate(() => {
          const scope = window as any;
          const view = scope.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          view.scrollDOM.scrollTop = view.lineBlockAt(view.state.selection.main.head).bottom - view.scrollDOM.clientHeight + 50;
        });
        if (mode === 'live') await page.locator(
          `.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea[data-table-row="${sourceRow}"][data-table-col="1"]`
        ).click();
        const caretGap = () => page.evaluate(async mode => {
          const scope = window as any, harness = scope.EditingSettingsHarness;
          const view = harness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
          const caret = mode === 'live'
            ? document.activeElement!.getBoundingClientRect()
            : view.coordsAtPos(view.state.selection.main.head);
          return view.scrollDOM.getBoundingClientRect().bottom - caret!.bottom;
        }, mode);
        await page.mouse.move(850, 230);
        let gap = await caretGap();
        for (let adjustment = 0; adjustment < 3 && Math.abs(3 - gap) > 1; adjustment++) {
          await page.mouse.wheel({ deltaY: 3 - gap });
          gap = await caretGap();
        }
        assert.ok(gap >= 0 && gap <= 6, label + ': the old caret is at the bottom edge (' + gap + 'px)');
        const before = await page.evaluate(() => {
          const scope = window as any, harness = scope.EditingSettingsHarness;
          const view = harness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          scope.__insertRowScrollFrames = [] as number[];
          const sample = () => {
            scope.__insertRowScrollFrames.push(view.scrollDOM.scrollTop);
            scope.__insertRowFrame = requestAnimationFrame(sample);
          };
          sample();
          return { scroll: view.scrollDOM.scrollTop,
            windowed: !!view.dom.querySelector('[data-meo-table-windowed="true"]'),
            optimized: harness.usesLargeDocumentDerivedWorkBudget(view.state) };
        });
        assert.equal(before.optimized, large, label + ': active document work budget');
        assert.equal(before.windowed, windowed, label + ': active table row virtualization');
        if (shortcut === 'Ctrl+Enter') await press('Enter', 'Control');
        else if (shortcut === 'Tab') await press('Tab');
        else await press('ArrowDown', 'Alt');
        const after = await page.evaluate(async mode => {
          const scope = window as any;
          const view = scope.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          for (let frame = 0; frame < 28; frame++) await new Promise(requestAnimationFrame);
          cancelAnimationFrame(scope.__insertRowFrame);
          const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
          const active = document.activeElement as HTMLElement;
          const target = mode === 'live' ? active.getBoundingClientRect() : view.coordsAtPos(head);
          const bounds = view.scrollDOM.getBoundingClientRect();
          return { visible: target && target.top >= bounds.top && target.bottom <= bounds.bottom,
            line: line.text, lineNumber: line.number, offset: head - line.from, isTextarea: active instanceof HTMLTextAreaElement,
            focusRow: active?.dataset.tableRow, focusCol: active?.dataset.tableCol,
            scroll: view.scrollDOM.scrollTop, frames: scope.__insertRowScrollFrames as number[] };
        }, mode);
        const column = shortcut === 'Tab' ? 0 : 1;
        assert.equal(after.line, movingRow ? `| row-${sourceRow - 1} | ${sourceCell} |` : '|  |  |', label + ': caret follows the affected row');
        assert.equal(after.lineNumber, rowCount + (movingRow ? 4 : 5), label + ': caret is on the last row');
        if (mode === 'live') {
          assert.equal(after.isTextarea, true, label + ': native cell owns the input');
          assert.equal(after.focusRow, String(rowCount + (movingRow ? 0 : 1)));
          assert.equal(after.focusCol, String(column));
        } else assert.equal(after.offset, movingRow ? after.line.indexOf(sourceCell) : 2 + 3 * column);
        assert.equal(after.visible, true, label + ': new caret is visible without another key');
        assert.ok(after.scroll > before.scroll + 5 && after.scroll - before.scroll < 90, label + ': reveal only the nearby row');
        assert.ok(after.frames.every((frame, index) => !index || frame >= after.frames[index - 1] - 1),
          label + ': the viewport does not move backward during the command: ' + JSON.stringify(after.frames));
        if (mode === 'live' && shortcut === 'Tab') {
          await press('Tab');
          await page.waitForFunction(row => {
            const active = document.activeElement as HTMLElement;
            return active.dataset.tableRow === String(row) && active.dataset.tableCol === '1';
          }, {}, rowCount + 1);
          const scroll = await page.evaluate(async () => {
            for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
            return document.querySelector('.editor-host .cm-scroller')!.scrollTop;
          });
          assert.ok(Math.abs(scroll - after.scroll) <= 1, label + ': tabbing across the new row needs no catch-up scroll');
        }
        assert.deepEqual(errors, []);
        await page.close();
        page = await browser.newPage();
        page.on('pageerror', error => errors.push(String(error)));
      }
    }
    console.log('Windows shortcuts changed real Live/Source documents, appended and moved table rows, revealed the inserted cell at the viewport edge, kept cell breaks, and dispatched workbench actions');
    if (process.argv.includes('--windows-shortcuts-only')) {
      await closeTestBrowser(browser);
      process.exit(0);
    }
  }
  if (process.argv.includes('--custom-shortcuts-only') || process.argv.length === 2) {
    const bind = async (stroke: string) => {
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.press(stroke);
      await page.keyboard.up('Alt');
      await page.keyboard.up('Control');
    };
    const ready = () => page.waitForFunction(() => document.querySelector('.cm-content')
      && document.querySelector('.editor-loading')?.hasAttribute('hidden') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
    const editorState = () => page.evaluate(() => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const { from, to } = view.state.selection.main;
      return {
        line: view.state.doc.line(1).text, selected: view.state.sliceDoc(from, to), from, to,
        optimized: (window as any).EditingSettingsHarness.usesLargeDocumentDerivedWorkBudget(view.state)
      };
    });
    const openShortcuts = async () => {
      await page.locator('.more-tools-wrapper > .format-button').click();
      await page.locator('.more-tools-settings-button').click();
      await page.locator('[data-tab="shortcuts"]').click();
    };
    const focusStart = () => page.evaluate(() => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      view.dispatch({ selection: { anchor: 0 } });
      view.focus();
    });
    const fixture = 'target\n\n';
    await openFixture(fixture);
    await ready();
    await openShortcuts();
    const settings = '.settings-window';
    const list = settings + ' .settings-content';
    assert.equal(await page.$eval('#meo-settings-customShortcuts h3', element => element.textContent), '自定义动作');
    const originalSize = await page.$eval(settings, element => element.getBoundingClientRect().toJSON());
    await page.locator('[data-add-custom-shortcut]').click();
    const form = '.settings-custom-shortcut-form';
    const footerHint = '.settings-shortcut-skip-hint';
    const footerWarning = '.settings-shortcut-feedback';
    const footerNotesFitBesideButtons = () => page.$eval('.settings-shortcut-page-footer', footer => {
      const buttons = footer.querySelector('.settings-actions')!.getBoundingClientRect();
      const notes = [...footer.querySelectorAll<HTMLElement>('.settings-shortcut-footer-note:not([hidden])')];
      const messageRight = Math.max(...notes.map(note => note.getBoundingClientRect().right));
      const gap = parseFloat(getComputedStyle(footer).columnGap);
      return notes.length === 2 && buttons.right <= innerWidth && buttons.bottom <= innerHeight
        && Math.abs(buttons.left - messageRight - gap) < 1 && notes.every(note => note.scrollWidth <= note.clientWidth);
    });
    const checkShortcutPlaceholder = async (selector: string) => {
      const { hint, ink, background } = await page.$eval(selector, field => {
        const style = getComputedStyle(field);
        let background = style.backgroundColor;
        for (let parent = field.parentElement; parent && background === 'rgba(0, 0, 0, 0)'; parent = parent.parentElement) {
          background = getComputedStyle(parent).backgroundColor;
        }
        return { hint: getComputedStyle(field, '::placeholder').color, ink: style.color, background };
      });
      assert.ok(contrast(hint, background) >= 4.5, `${selector}: placeholder remains readable`);
      assert.ok(contrast(hint, background) < contrast(ink, background), `${selector}: placeholder is quieter than submitted text`);
    };
    const editorPage = settings + '[data-page="shortcut-editor"]';
    assert.equal(await page.$eval('#meo-shortcut-editor-title', element => element.textContent), '新建自定义动作');
    assert.equal(await page.$$eval('dialog:modal', dialogs => dialogs.length), 1, 'The form uses the existing settings dialog');
    assert.deepEqual(await page.$eval(editorPage, element => element.getBoundingClientRect().toJSON()), originalSize);
    assert.ok(await page.$eval(list, element => element.getClientRects().length === 0));
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.name), 'name');
    assert.equal(await page.$eval(form + ' input[name="name"]', input => input.getAttribute('placeholder')), '例如，插入会议纪要');
    await checkShortcutPlaceholder(form + ' input[name="name"]');
    await page.waitForSelector('.settings-shortcut-empty-actions', { visible: true });
    await page.locator(form + ' input[name="name"]').fill('Meeting notes');
    const scope = form + ' [data-shortcut-scope]';
    const scopeMenu = form + ' .settings-shortcut-scope-menu';
    const scopeOption = '[data-shortcut-scope-option]';
    const addStep = '[data-shortcut-add-action]';
    const pickerSearch = form + ' .settings-shortcut-picker input';
    const pickerRestriction = ' .settings-shortcut-picker-restriction';
    const codeBlock = '[data-shortcut-choice="codeBlock"]';
    const snippet = '[data-shortcut-choice="snippet"]';
    const deleteRow = '[data-shortcut-choice="rowDelete"]';
    const screenshots = '.local/test-artifacts/custom-shortcuts';
    await fs.mkdir(screenshots, { recursive: true });
    await page.locator(addStep).click();
    await checkShortcutPlaceholder(pickerSearch);
    assert.equal(await page.$eval(codeBlock + pickerRestriction, hint => hint.textContent), '仅在表格外执行');
    await page.$eval(codeBlock, option => option.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: screenshots + '/shortcut-action-menu.png' });
    await page.keyboard.press('Escape');
    await page.locator(scope).click();
    await page.waitForSelector(scopeMenu, { visible: true });
    assert.equal(await page.$eval(scope + ' > svg', element => getComputedStyle(element).rotate), '180deg');
    assert.deepEqual(await page.$$eval(scopeOption, options => options.map(option => option.getAttribute('data-shortcut-scope-option'))),
      ['global', 'editor', 'live', 'source'], 'New actions have a unified editing area');
    assert.ok(await page.$eval(scopeOption + '[aria-selected="true"]', element => element.childElementCount === 0));
    for (const [value, text] of [
      ['global', 'Live、Source 和 Preview 中都可触发。设置、搜索等输入框里不会触发。'], ['editor', '在 Live 和 Source 的编辑区触发，包含普通内容和表格单元格。'],
      ['live', '在 Live 的编辑区触发，包含普通内容和表格单元格。'], ['source', '在 Source 的编辑区触发，包含普通内容和表格单元格。'],
    ]) {
      const option = '[data-shortcut-scope-option="' + value + '"]';
      await page.hover(option);
      await page.waitForFunction(selector => {
        const id = document.querySelector(selector)?.getAttribute('aria-describedby');
        return id && document.getElementById(id)?.classList.contains('is-visible');
      }, {}, option);
      const hint = await page.$eval(option, element => {
        const hint = document.getElementById(element.getAttribute('aria-describedby')!)!;
        return { text: hint.textContent ?? '', toLeft: hint.getBoundingClientRect().right < element.getBoundingClientRect().left };
      });
      assert.ok(hint.toLeft, 'The hover hint stays to the left of the scope option');
      assert.equal(hint.text, text);
    }
    await page.screenshot({ path: screenshots + '/shortcut-page-scope-menu.png' });
    await page.keyboard.press('Escape');
    await page.waitForSelector(scopeMenu, { hidden: true });
    assert.ok(await page.$(editorPage), 'Escape closes the scope menu and keeps the settings page open');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.match(await page.$eval(scope, element => element.textContent ?? ''), /Source/);
    assert.ok(await page.$eval(scope, element => element === document.activeElement));
    const stepsLayout = () => page.$eval('.settings-shortcut-actions-list', element => ({
      steps: element.getBoundingClientRect().toJSON(),
      add: element.parentElement!.querySelector('[data-shortcut-add-action]')!.getBoundingClientRect().toJSON(),
      scrollHeight: element.closest('.settings-shortcut-page-body')!.scrollHeight,
    }));
    const initialStepsLayout = await stepsLayout();
    await page.locator(addStep).click();
    assert.equal(await page.$eval(addStep, element => element.textContent), '添加步骤');
    assert.deepEqual(await stepsLayout(), initialStepsLayout, 'The floating menu leaves the step section geometry unchanged');
    const pickerResults = form + ' .settings-shortcut-picker-results';
    const menu = await page.$eval(pickerResults, results => {
      const option = results.querySelector<HTMLElement>('.preview-dropdown-option')!;
      return {
        scrollable: results.scrollHeight > results.clientHeight,
        scrollbarWidth: getComputedStyle(results, '::-webkit-scrollbar').width,
        radius: getComputedStyle(option).borderRadius,
      };
    });
    assert.deepEqual(menu, { scrollable: true, scrollbarWidth: '6px', radius: '3px' });
    assert.equal(await page.$eval(codeBlock + ' .settings-shortcut-picker-name', option => option.textContent), '代码块');
    assert.ok(await page.$eval(pickerResults, list => Array.from(list.children).every(option => option.matches('button[data-shortcut-choice]'))),
      'The step menu is one continuous list of options');
    await page.locator(pickerSearch).fill('表格');
    await page.screenshot({ path: screenshots + '/shortcut-action-menu-table.png' });
    await page.locator(pickerSearch).fill('移除表格行');
    assert.equal(await page.$eval(deleteRow, element => element.getAttribute('aria-disabled')), null);
    assert.equal(await page.$eval(deleteRow + pickerRestriction, element => element.textContent), '仅在单元格内执行');
    assert.ok(await page.$eval(deleteRow, option => {
      const [name, hint] = Array.from(option.children, child => child.getBoundingClientRect());
      return name.right < hint.left && name.bottom > hint.top && hint.bottom > name.top;
    }), 'Restrictions stay on the right of the option name');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.settings-shortcut-empty-actions', { hidden: true });
    await page.locator(addStep).click();
    await page.locator(pickerSearch).fill('markdown template');
    await page.waitForSelector(snippet);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement)?.name), 'template');
    await checkShortcutPlaceholder(form + ' textarea');
    await page.locator('[data-shortcut-record]').click();
    await checkShortcutPlaceholder(form + ' .settings-recorder');
    assert.equal(await page.$eval(footerHint, hint => hint.textContent), '执行时会自动跳过不适用的步骤');
    assert.equal(await page.$eval(footerWarning, note => note.textContent), '调整相关警告后可保存');
    assert.ok(await footerNotesFitBesideButtons());
    await page.screenshot({ path: screenshots + '/shortcut-placeholders-dark.png' });
    await page.keyboard.press('Escape');
    await page.locator(form + ' textarea').fill('Cell-compatible text');
    assert.equal(await page.$eval('[data-shortcut-save]', button => (button as HTMLButtonElement).disabled), true,
      'A row command must be last when the following snippet can also run in the cell');
    assert.ok(await page.$('.settings-shortcut-step-warning'));
    await page.locator(form + ' textarea').fill('${1:Prose only}');
    const stepNotes = '.settings-shortcut-step-location';
    assert.deepEqual(await page.$$eval(stepNotes, notes => notes.map(note => note.textContent)),
      ['仅在单元格内执行', '仅在表格外执行']);
    const notesFitBesideSteps = () => page.$$eval('.settings-shortcut-step-note', notes => notes.length > 0 && notes.every(note => {
      const annotations = note.closest('.settings-shortcut-step-notes')!;
      const button = annotations.previousElementSibling!;
      const caption = button.querySelector('.settings-shortcut-step-caption')!;
      const name = caption.getBoundingClientRect();
      const icon = note.querySelector('svg[aria-hidden="true"]')!.getBoundingClientRect();
      const hint = note.getBoundingClientRect();
      const textLeft = hint.left + parseFloat(getComputedStyle(note).paddingInlineStart);
      const tools = note.closest('.settings-shortcut-action-heading')!.querySelector('.settings-shortcut-row-tools')!.getBoundingClientRect();
      return name.right < icon.left && icon.right < textLeft && icon.right <= hint.right
        && Math.abs(name.top + name.height / 2 - hint.top - hint.height / 2) < 1
        && annotations.getBoundingClientRect().right < tools.left && caption.scrollWidth === caption.clientWidth
        && note.scrollWidth === note.clientWidth
        && button.getAttribute('aria-describedby')?.split(' ').includes(note.id);
    }));
    assert.ok(await notesFitBesideSteps(), 'Step restrictions share the heading line and are exposed to assistive technology');
    await page.hover(stepNotes);
    assert.equal(await page.$eval(stepNotes, note => note.getAttribute('aria-describedby')), null,
      'Hovering a fully visible note does not create a duplicate tooltip');
    assert.equal(await page.$eval('[data-shortcut-save]', button => (button as HTMLButtonElement).disabled), false);
    assert.ok(await page.$eval(footerWarning, element => element.hasAttribute('hidden')), 'Valid drafts clear the warning');
    await page.waitForSelector(footerHint, { visible: true });
    await page.locator(scope).click();
    assert.equal(await page.$$eval(scopeOption + '[aria-disabled="true"]', options => options.length), 0);
    assert.equal(await page.$$eval(scopeOption + ' svg', icons => icons.length), 0, 'Scope options do not add warning icons');
    const globalScope = '[data-shortcut-scope-option="global"]';
    await page.hover(globalScope);
    const conditionalScopeHint = await page.$eval(globalScope, element => '#' + element.getAttribute('aria-describedby'));
    await page.waitForSelector(conditionalScopeHint + '.is-visible');
    const scopeHint = await page.$eval(conditionalScopeHint, element => {
      const reason = element.querySelector('.meo-tooltip-label')!;
      const divider = element.querySelector('.meo-tooltip-details > hr')!;
      const bounds = divider.getBoundingClientRect();
      return { reason: reason.textContent, description: divider.nextSibling?.textContent,
        separated: bounds.top > reason.getBoundingClientRect().bottom && bounds.width > 0 && bounds.height === 1 };
    });
    assert.deepEqual(scopeHint, { reason: '这个动作在预览中没有可执行的步骤。',
      description: 'Live、Source 和 Preview 中都可触发。设置、搜索等输入框里不会触发。', separated: true });
    await page.screenshot({ path: screenshots + '/shortcut-conditional-scope.png' });
    await page.keyboard.press('Escape');
    const removeTableStep = '[data-shortcut-action-remove="0"]';
    await page.locator(removeTableStep).click();
    await page.locator(removeTableStep).click();
    await page.locator(form + ' textarea').fill('Cell-compatible text');
    await page.waitForSelector(footerHint, { hidden: true });
    await page.locator(form + ' textarea').fill('[${1:Title}] ');
    const fileToken = form + ' .image-location-token[data-shortcut-token="${TM_FILENAME}"]';
    await page.waitForSelector(fileToken, { visible: true });
    assert.equal(await page.$eval(fileToken, button => button.textContent), '文件名');
    await page.hover(fileToken);
    await page.waitForFunction(() => [...document.querySelectorAll('.meo-tooltip.is-visible')].some(tooltip =>
      tooltip.getClientRects().length && tooltip.querySelector('.meo-tooltip-text')?.textContent === '${TM_FILENAME}'));
    await page.locator(fileToken).click();
    assert.equal(await page.$eval(form + ' textarea', input => (input as HTMLTextAreaElement).value), '[${1:Title}] ${TM_FILENAME}');
    await page.locator(form + ' textarea').fill('[${1:Title}] ${TM_FILENAME} ${CURRENT_YEAR} $0');
    await page.locator('[data-shortcut-record]').click();
    const recordHint = '.settings-shortcut-record-hint';
    await page.waitForSelector(recordHint, { visible: true });
    assert.equal(await page.$eval(recordHint, hint => hint.textContent), '按下第一组按键。按 Esc 取消录制。');
    await chord('c');
    assert.equal(await page.$eval(recordHint, hint => hint.textContent), '可以直接按第二组，或选择「完成」。');
    await page.locator('[data-shortcut-record-done]').click();
    assert.equal(await page.$eval('[data-shortcut-save]', button => (button as HTMLButtonElement).disabled), true, 'Reserved keys cannot replace a system binding');
    assert.match(await page.$eval(footerWarning, note => note.textContent ?? ''), /此按键由系统命令保留.*复制/);
    await page.screenshot({ path: screenshots + '/shortcut-conflict-reserved.png' });
    await page.locator('[data-shortcut-record]').click();
    await chord('b');
    await page.locator('[data-shortcut-record-done]').click();
    assert.equal(await page.$eval('[data-shortcut-save]', button => button.textContent), '替换并保存');
    assert.match(await page.$eval(footerWarning, note => note.textContent ?? ''), /将替换.*粗体.*的键位/);
    await page.screenshot({ path: screenshots + '/shortcut-conflict-before-save.png' });
    await page.evaluate(() => { (window as any).__holdNextUpdate = true; });
    await page.locator('[data-shortcut-save]').click();
    await page.waitForFunction(() => typeof (window as any).__flushUpdate === 'function');
    await page.evaluate(() => {
      const harness = window as any;
      const current = harness.__preferences;
      harness.__beforeCompetingBinding = current;
      harness.__preferences = { ...current, shortcuts: { ...current.shortcuts, bold: [] },
        customShortcuts: [...(current.customShortcuts ?? []), { id: 'competing-keybinding', name: '插入日报',
          scope: 'editor', strokes: ['Ctrl + B'], actions: [{ type: 'snippet', template: '日报' }] }] };
      harness.__revision++;
      harness.__flushUpdate();
      delete harness.__flushUpdate;
    });
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('键位冲突已变化'), {}, footerWarning);
    assert.match(await page.$eval(footerWarning, note => note.textContent ?? ''), /将替换「插入日报」的键位/);
    assert.equal(await page.$eval(form + ' input[name="name"]', input => (input as HTMLInputElement).value), 'Meeting notes');
    assert.deepEqual(await page.evaluate(() => (window as any).__preferences.customShortcuts.at(-1).strokes), ['Ctrl + B']);
    await page.screenshot({ path: screenshots + '/shortcut-conflict-changed.png' });
    await page.evaluate(() => {
      const harness = window as any;
      harness.__preferences = harness.__beforeCompetingBinding;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: harness.__preferences, revision: ++harness.__revision } }));
    });
    await page.locator('[data-shortcut-record]').click();
    await bind('j');
    assert.equal(await page.$eval('[data-shortcut-clear-recording]', button => button.getAttribute('aria-label')), '清空已录按键');
    await page.locator('[data-shortcut-clear-recording]').click();
    await page.waitForSelector(form + ' .settings-recorder', { visible: true });
    assert.equal(await page.$eval(form + ' .settings-recorder', input => (input as HTMLInputElement).value), '');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('settings-recorder')), true);
    await bind('k');
    assert.equal(await page.$eval(form + ' .settings-recorder', input => (input as HTMLInputElement).value), 'Ctrl + Alt + K');
    await page.keyboard.press('t');
    assert.deepEqual(await page.$$eval(form + ' kbd', elements => elements.map(e => e.textContent)), ['Ctrl + Alt + K', 'T']);
    await page.locator('[data-shortcut-record]').click();
    await bind('j');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.$$eval(form + ' kbd', elements => elements.map(e => e.textContent)), ['Ctrl + Alt + K', 'T'], 'Escape restores the previous chord');
    await page.screenshot({ path: screenshots + '/shortcut-page-zh-dark.png' });
    await page.evaluate(() => (window as any).__failNextUpdate = true);
    await page.locator('[data-shortcut-save]').click();
    await page.waitForFunction(() => document.querySelector('.settings-shortcut-feedback')?.textContent?.includes('保存失败'));
    assert.equal(await page.$eval(form + ' input[name="name"]', input => (input as HTMLInputElement).value), 'Meeting notes');
    await page.locator('[data-shortcut-save]').click();
    await page.waitForSelector('[data-custom-shortcut]');
    await page.waitForSelector(editorPage, { hidden: true });
    assert.equal(await page.$eval(settings, element => element.matches(':modal')), true);
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.hasAttribute('data-custom-shortcut-edit')), true, 'Saving restores focus to the new row');
    const rowAppearance = await page.$eval('[data-custom-shortcut]', row => {
      const name = row.querySelector('.settings-item-title')!;
      const summary = row.querySelector('.settings-custom-shortcut-summary')!;
      const builtin = document.querySelector('[data-command="bold"] .settings-item-title')!;
      return {
        sameLine: name.getBoundingClientRect().top === summary.getBoundingClientRect().top,
        sameSize: [name, summary].every(text => getComputedStyle(text).fontSize === getComputedStyle(builtin).fontSize),
        distinctColors: getComputedStyle(name).color !== getComputedStyle(summary).color,
        textTooltip: [name, summary].some(text => text.hasAttribute('title') || text.hasAttribute('data-tooltip')),
        actions: [...row.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
      };
    });
    assert.deepEqual(rowAppearance, { sameLine: true, sameSize: true, distinctColors: true, textTooltip: false, actions: ['编辑', '删除'] });
    const summaryColors = await page.$eval('.settings-custom-shortcut-summary', element => {
      const style = getComputedStyle(element);
      return { summary: style.color, muted: style.getPropertyValue('--meo-ui-text-muted'), panel: getComputedStyle(element.closest('.settings-window')!).backgroundColor };
    });
    assert.ok(contrast(summaryColors.summary, summaryColors.panel) >= 4.5, 'The weaker action summary remains readable');
    assert.ok(contrast(summaryColors.summary, summaryColors.panel) < contrast(summaryColors.muted, summaryColors.panel),
      'The action summary is quieter than ordinary secondary settings text');
    await page.screenshot({ path: screenshots + '/shortcut-list-compact.png' });
    await page.locator('.settings-search').fill('自定义快捷键');
    await page.waitForSelector('[data-custom-shortcut]');
    await page.locator('.settings-search').fill('Meeting notes');
    await page.waitForSelector('[data-custom-shortcut]');
    assert.equal(await page.$$eval('[data-custom-shortcut]', rules => rules.length), 1);
    const saved = await page.evaluate(() => (window as any).__preferences);
    await page.locator('[data-custom-shortcut-edit]').click();
    await page.locator(form + ' input[name="name"]').fill('Discard this draft');
    await page.locator(form + ' .settings-actions button:first-child').click();
    await page.waitForSelector(editorPage, { hidden: true });
    assert.equal(await page.$eval(settings + ' .settings-search', input => (input as HTMLInputElement).value), 'Meeting notes');
    assert.equal(await page.$eval('[data-custom-shortcut] .settings-item-title', element => element.textContent), 'Meeting notes');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.hasAttribute('data-custom-shortcut-edit')), true);
    const removeRule = '[data-custom-shortcut-remove]';
    const originalRemove = (await page.$(removeRule))!;
    const ruleLayout = () => page.$eval('[data-custom-shortcut]', row =>
      [row, ...row.querySelectorAll('button')].map(element => element.getBoundingClientRect().toJSON()));
    const initialRuleLayout = await ruleLayout();
    await page.locator(removeRule).click();
    assert.deepEqual(await originalRemove.evaluate(button => [button.isConnected, button.getAttribute('aria-label'), getComputedStyle(button).backgroundColor]),
      [true, '确认删除', 'rgb(188, 75, 66)'], 'The same icon becomes the red confirmation control');
    assert.deepEqual(await ruleLayout(), initialRuleLayout, 'Arming deletion keeps the row and both controls in place');
    assert.deepEqual(await page.evaluate(() => (window as any).__preferences.customShortcuts), saved.customShortcuts);
    await page.screenshot({ path: screenshots + '/shortcut-delete-confirm.png' });
    await page.keyboard.press('Escape');
    await page.waitForSelector(removeRule + '[aria-label="删除"]');
    assert.ok(await page.$(settings + ':modal'), 'Escape cancels deletion and keeps the list open');
    await page.locator('.settings-search-clear').click();
    await page.locator('[data-tab="appearance"]').click();
    await page.locator('[data-appearance-mode="light"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.editorAppearance === 'light');
    await page.locator('[data-tab="shortcuts"]').click();
    await page.$eval(list, element => { element.scrollTop = 12; });
    const listScroll = await page.$eval(list, element => element.scrollTop);
    await page.locator('[data-custom-shortcut-edit]').click();
    await page.setViewport({ width: 520, height: 450 });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiLanguageChanged', uiLanguagePreference: 'en', uiLanguage: 'en', automaticUiLanguage: 'en' } })));
    await page.waitForFunction(() => document.querySelector('#meo-shortcut-editor-title')?.textContent === 'Edit custom action');
    await page.locator(scope).click();
    await page.locator(globalScope).click();
    await page.locator('[data-shortcut-add-action]').click();
    await page.locator(form + ' .settings-shortcut-picker input').fill('nonmatching');
    assert.equal(await page.$eval('.settings-shortcut-picker-empty', element => element.textContent), 'No matching steps');
    await page.locator('.settings-shortcut-picker-clear').click();
    assert.equal(await page.$eval('.settings-shortcut-picker-input', input => (input as HTMLInputElement).value), '');
    assert.equal(await page.$eval(codeBlock + pickerRestriction, hint => hint.textContent), 'Only outside tables');
    assert.equal(await page.$eval('[data-shortcut-choice="plain"]' + pickerRestriction, hint => hint.textContent), 'Only outside tables');
    await page.locator(form + ' .settings-shortcut-picker input').fill('undo');
    await page.locator(form + ' [data-shortcut-choice="undo"]').click();
    assert.equal(await page.$$eval('[data-shortcut-action]', actions => actions.length), 2);
    assert.ok(await page.$eval('[data-shortcut-save]', element => {
      const box = element.getBoundingClientRect();
      return box.y >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
    }), 'Save remains visible while editing actions in a narrow window');
    await page.locator(form + ' .settings-shortcut-action:last-child [aria-label="Move step up"]').click();
    assert.equal(await page.$eval('[data-shortcut-save]', button => (button as HTMLButtonElement).disabled), true,
      'The order check explains why an async action cannot be moved before other actions');
    const orderWarning = 'Must run last';
    const warning = '.settings-shortcut-step-warning';
    assert.equal(await page.$eval(footerWarning, element => element.textContent), 'Resolve the warnings to save');
    assert.equal(await page.$eval(footerHint, element => element.textContent), 'Automatically skips steps that don’t apply');
    assert.ok(await page.$eval('.settings-shortcut-footer-notes', notes => {
      return ['.settings-shortcut-step-location', '.settings-shortcut-step-warning'].every((selector, index) => {
        const stepNote = document.querySelector(selector)!;
        const footerNote = notes.children[index];
        const graphic = footerNote.querySelector('svg[aria-hidden="true"]');
        return graphic?.innerHTML === stepNote.querySelector('svg')?.innerHTML && Boolean(graphic)
          && getComputedStyle(footerNote).color === getComputedStyle(stepNote).color;
      });
    }), 'The footer matches the icon and color of each step annotation');
    assert.ok(await footerNotesFitBesideButtons());
    assert.deepEqual(await page.$$eval(warning, icons => icons.map(icon =>
      icon.closest('.settings-shortcut-step-notes')?.previousElementSibling?.getAttribute('data-shortcut-action'))),
      ['0'], 'Only the misplaced step has a warning next to its name');
    assert.equal(await page.$eval(warning, note => note.textContent), orderWarning, 'The warning is rendered inline beside the step');
    assert.ok(await notesFitBesideSteps(), 'The shortened notes share the same line and fit in a narrow window');
    await page.screenshot({ path: screenshots + '/shortcut-step-order-warning.png' });
    await page.setViewport({ width: 360, height: 450 });
    assert.ok(await footerNotesFitBesideButtons(), 'The wrapped messages leave both footer buttons visible');
    const clippedNotes = await page.$$eval('.settings-shortcut-step-note', notes => notes
      .filter(note => note.scrollWidth > note.clientWidth + 1)
      .map(note => ({ id: note.id, text: note.textContent })));
    assert.ok(clippedNotes.length > 0, 'A very narrow viewport clips some notes');
    for (const { id, text } of clippedNotes) {
      await page.hover('#' + id);
      await page.waitForFunction(text => [...document.querySelectorAll('.meo-tooltip.is-visible .meo-tooltip-text')]
        .some(hint => hint.textContent === text), {}, text);
    }
    await page.setViewport({ width: 520, height: 450 });
    await page.locator(form + ' .settings-shortcut-action:first-child [aria-label="Move step down"]').click();
    assert.equal(await page.$eval('[data-shortcut-save]', button => (button as HTMLButtonElement).disabled), false);
    assert.equal(await page.$(warning), null, 'Moving the step to the end removes the warning');
    await page.locator('[data-shortcut-action="1"]').click();
    assert.equal(await page.$eval(deleteRow, element => element.getAttribute('aria-disabled')), null);
    assert.equal(await page.$eval(deleteRow + pickerRestriction, element => element.textContent), 'Only in table cells');
    await page.locator(form + ' .settings-shortcut-picker input').fill('specific mode');
    await page.locator(form + ' [data-shortcut-choice="mode"]').click();
    await page.locator('[data-shortcut-mode="preview"]').click();
    assert.equal(await page.$eval('[data-shortcut-mode="preview"]', element => element.getAttribute('aria-pressed')), 'true');
    assert.match(await page.$eval('[data-shortcut-action="1"]', element => element.textContent ?? ''), /Preview/);
    const stepRows = await page.$$eval('.settings-shortcut-action', rows => rows.map(row => {
      const number = row.querySelector('.settings-shortcut-step-number')!;
      const title = row.querySelector('.settings-shortcut-step-caption')!;
      const details = row.querySelector('.settings-shortcut-action-details')!;
      return { number: number.textContent, numberLeft: number.getBoundingClientRect().left,
        titleLeft: title.getBoundingClientRect().left, detailsLeft: details.getBoundingClientRect().left,
        titleFits: title.scrollWidth === title.clientWidth };
    }));
    assert.deepEqual(stepRows.map(step => step.number), ['1', '2']);
    assert.ok(stepRows.every(step => step.numberLeft < step.titleLeft && step.titleLeft === step.detailsLeft &&
      step.numberLeft === stepRows[0].numberLeft && step.titleLeft === stepRows[0].titleLeft), 'All steps, headings and details use the same two aligned columns');
    assert.ok(stepRows.every(step => step.titleFits), 'Titles remain fully visible when the heading has enough room');
    assert.ok(await notesFitBesideSteps(), 'Step restrictions also fit beside the title in a narrow English window');
    await page.waitForFunction(() => document.querySelector('[data-shortcut-mode="preview"] .segmented-control-button-indicator')
      ?.getAnimations().every(animation => animation.playState === 'finished'));
    await page.screenshot({ path: screenshots + '/shortcut-page-en-narrow.png' });
    const removeAction = '[data-shortcut-action-remove="1"]';
    const draftLayout = () => page.$eval(removeAction, button => {
      const row = button.closest('.settings-shortcut-action')!;
      return [row, ...row.querySelectorAll('button')].map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const origin = row.getBoundingClientRect();
        return { x: x - origin.x, y: y - origin.y, width, height };
      });
    });
    const initialDraftLayout = await draftLayout();
    await page.locator(removeAction).click();
    assert.equal(await page.$eval(removeAction + '.is-delete-armed', button => button.getAttribute('aria-label')), 'Confirm removal');
    assert.deepEqual(await draftLayout(), initialDraftLayout, 'Draft removal leaves the action and all its controls in place until confirmed');
    await page.keyboard.press('Escape');
    await page.waitForSelector(removeAction + '[aria-label="Remove step"]');
    assert.ok(await page.$(editorPage), 'Escape only disarms draft removal');
    await page.locator(removeAction).click();
    await page.locator(removeAction).click();
    assert.equal(await page.$$eval('[data-shortcut-action]', actions => actions.length), 1);
    const removeLastStep = '[data-shortcut-action-remove="0"]';
    await page.locator(removeLastStep).click();
    await page.locator(removeLastStep).click();
    const restoredScopeHint = await page.$eval(globalScope, element => {
      const id = element.getAttribute('aria-describedby');
      const tooltip = document.getElementById(id!)!;
      return { text: tooltip.textContent ?? '', hasDivider: !!tooltip.querySelector('hr') };
    });
    assert.match(restoredScopeHint.text, /Live, Source, and Preview/, 'The available scope shows its regular description again');
    assert.equal(restoredScopeHint.hasDivider, false);
    await page.setViewport({ width: 1100, height: 780 });
    await page.keyboard.press('Escape');
    await page.waitForSelector(editorPage, { hidden: true });
    assert.ok(await page.$(settings + ':modal'), 'Returning from the editor keeps the settings dialog open');
    assert.equal(await page.$eval(list, element => element.scrollTop), listScroll);
    await page.locator('.settings-close').click();
    await focusStart();
    await bind('k');
    assert.equal((await editorState()).line, 'target', 'The prefix alone does not edit');
    await page.keyboard.press('t');
    const inserted = await editorState();
    assert.match(inserted.line, /^\[Title\] settings\.md \d{4} target$/);
    assert.equal(inserted.selected, 'Title');
    await page.keyboard.press('Tab');
    assert.equal((await editorState()).from, inserted.line.indexOf('target'), 'Tab reached the final stop');
    await chord('z');
    assert.equal((await editorState()).line, 'target', 'Snippet is undone in one step');
    await page.locator('button[data-mode="live"]').click();
    await ready();
    await focusStart();
    await bind('k');
    const beforeModeGuard = (await editorState()).line;
    assert.equal(beforeModeGuard, 'target', 'Source-only prefix cannot start the rule in Live');
    await page.keyboard.press('t');
    assert.equal((await editorState()).line, 'ttarget', 'Live receives the normal key when the rule is out of scope');
    await openShortcuts();
    await page.evaluate(() => {
      const g = window as any;
      g.__preferences = { ...g.__preferences, shortcuts: { bold: ['Ctrl + Alt + U'] } };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
    });
    await page.locator('.settings-footer > .settings-button').click();
    assert.match(await page.$eval('.settings-reset-description', element => element.textContent ?? ''), /Custom keybindings are cleared/);
    await page.locator('.settings-reset-popover .settings-primary').click();
    await page.waitForSelector('[data-custom-shortcut] .settings-unassigned');
    assert.deepEqual(await page.evaluate(() => (window as any).__preferences.shortcuts), {});
    assert.deepEqual(await page.evaluate(() => (window as any).__preferences.customShortcuts),
      saved.customShortcuts.map((rule: import('../src/foundation/editingPreferences').CustomShortcut) => ({ ...rule, strokes: [] })));
    await page.locator(removeRule).click();
    await page.locator(removeRule).click();
    await page.waitForSelector('[data-custom-shortcut]', { hidden: true });
    assert.deepEqual(await page.evaluate(() => (window as any).__preferences.customShortcuts), []);
    assert.match(await page.$eval('.settings-custom-shortcut-empty', hint => hint.textContent ?? ''), /assign keys/);

    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    const largeText = 'target\n\n' + 'A paragraph for the large document shortcut test.\n\n'.repeat(4600);
    assert.equal(assessLargeDocument(largeText).boundedEditorWork, true);
    await openFixture(largeText, 'live', false, 'hidden', false, true);
    await ready();
    await page.evaluate(preferences => {
      const global = window as any;
      global.__preferences = preferences;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences, revision: ++global.__revision } }));
    }, { ...saved, customShortcuts: saved.customShortcuts.map((rule: { scope: string }) => ({ ...rule, scope: 'live' })) });
    await focusStart();
    assert.equal((await editorState()).optimized, true, 'Live uses the large-document work budget');
    await bind('k'); await page.keyboard.press('t');
    assert.match((await editorState()).line, /^\[Title\] settings\.md \d{4} target$/);
    await chord('z');
    assert.equal((await editorState()).line, 'target');

    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    const tableFixture = fixture + '| Column |\n| --- |\n| first cell |\n| second cell |\n|  |\n';
    const documentText = () => page.evaluate(() => (window as any).EditingSettingsHarness.EditorView
      .findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
    const focusCell = async (mode: 'source' | 'live', select = false, offset = 0, cell = 'first cell') => {
      if (mode === 'live') {
        await page.locator('tbody tr:first-child .meo-md-html-table-cell-preview').click();
        await page.waitForFunction(cell => document.activeElement instanceof HTMLTextAreaElement
          && document.activeElement.value === cell, {}, cell);
      }
      await page.evaluate(({ mode, select, offset, cell }) => {
        if (mode === 'live') {
          const input = document.activeElement as HTMLTextAreaElement;
          input.setSelectionRange(offset, select ? input.value.length : offset);
          return;
        }
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        const anchor = view.state.doc.toString().indexOf(cell) + offset;
        view.dispatch({ selection: { anchor, head: anchor + (select ? cell.length - offset : 0) } });
        view.focus();
      }, { mode, select, offset, cell });
    };
    await openFixture(tableFixture);
    await ready();
    const exampleHost = createEditingPreferencesHost({
      platform: 'other', read: () => ({ input: defaultInputAssistance, shortcuts: {} }),
      write: async () => { throw new Error('The initial example must not write settings'); }
    });
    await page.evaluate(preferences => {
      const global = window as any;
      global.__preferences = preferences;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences, revision: ++global.__revision } }));
    }, exampleHost.read());
    for (const mode of ['source', 'live'] as const) {
      await page.locator('button[data-mode="' + mode + '"]').click();
      await ready();
      await focusStart();
      await bind('t');
      assert.match((await editorState()).line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}target$/);
      await chord('z');
      assert.equal((await editorState()).line, 'target');
      await focusCell(mode);
      await bind('t');
      assert.match(await documentText(), /\| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}first cell\s*\|/,
        `${mode}: the default timestamp is inserted in the cell`);
      await chord('z');
      assert.equal(await documentText(), tableFixture, `${mode}: one undo restores the cell and the original table`);
      if (mode === 'source') {
        const focusSource = (marker: string) => page.evaluate(marker => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(marker) + 2 } });
          view.focus();
        }, marker);
        await focusSource('| --- |');
        await bind('t');
        assert.equal(await documentText(), tableFixture, 'The Source table delimiter is never edited by a snippet');
        await focusSource('|  |');
        await bind('t');
        assert.match(await documentText(), /\n\| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \|\n$/,
          'A Source cell with no text can receive the timestamp');
        await chord('z');
        assert.equal(await documentText(), tableFixture);
      }
    }
    await openShortcuts();
    const example = '[data-custom-shortcut="' + insertCurrentTimeExampleId + '"]';
    const exampleName = example + ' .settings-item-title';
    assert.equal(await page.$$eval('[data-custom-shortcut]', actions => actions.length), 1);
    assert.equal(await page.$eval(exampleName, element => element.textContent), '示例 · 插入当前时间');
    assert.equal(await page.$eval(example + ' .settings-custom-shortcut-summary', element => element.textContent), '编辑区（Live / Source） · 插入片段');
    assert.equal(await page.$eval(example + ' kbd', element => element.textContent), 'Ctrl + Alt + T');
    await page.screenshot({ path: screenshots + '/shortcut-example.png' });
    await page.locator('.settings-search').fill('insert current time');
    await page.waitForSelector(example);
    await page.locator('.settings-search-clear').click();
    await page.locator(example + ' [data-custom-shortcut-edit]').click();
    const nameField = form + ' input[name="name"]';
    assert.equal(await page.$eval(nameField, input => (input as HTMLInputElement).value), '示例 · 插入当前时间');
    const useLanguage = (language: 'zh-CN' | 'en') => page.evaluate(language => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'uiLanguageChanged', uiLanguagePreference: language, uiLanguage: language, automaticUiLanguage: language }
    })), language);
    await useLanguage('en');
    await page.waitForFunction((selector, title) => document.querySelector<HTMLInputElement>(selector)?.value === title, {}, nameField, insertCurrentTimeExampleName);
    await page.locator('[data-shortcut-save]').click();
    await page.waitForSelector(editorPage, { hidden: true });
    assert.equal(await page.$eval(exampleName, element => element.textContent), insertCurrentTimeExampleName);
    assert.equal(await page.evaluate(() => (window as any).__preferences.customShortcuts[0].useDefaultName), true);
    await page.locator(example + ' [data-custom-shortcut-edit]').click();
    await page.locator(nameField).fill('我的时间戳');
    await page.locator('[data-shortcut-save]').click();
    await page.waitForSelector(editorPage, { hidden: true });
    await useLanguage('zh-CN');
    await page.waitForFunction(() => document.querySelector('#meo-settings-customShortcuts h3')?.textContent === '自定义动作');
    assert.equal(await page.$eval(exampleName, element => element.textContent), '我的时间戳');
    assert.equal(await page.evaluate(() => (window as any).__preferences.customShortcuts[0].useDefaultName), undefined);
    await page.locator('.settings-close').click();
    const applyMixedAction = () => page.evaluate(() => {
      const global = window as any;
      const actions: CustomShortcutAction[] = [{ type: 'snippet', template: 'Prose: $1' }, { type: 'command', command: 'heading1' },
        { type: 'command', command: 'rowDelete' }];
      const mixed = { id: 'mixed', name: 'Mixed action', scope: 'editor', strokes: ['Ctrl + Alt + Y'], actions };
      const cell = { id: 'cell', name: 'Cell snippet', scope: 'editor', strokes: ['Ctrl + Alt + I'], actions: [
        { type: 'snippet', template: 'A | $0${TM_SELECTED_TEXT}\nZ' }
      ] };
      const cellBreak = { id: 'cell-break-then-insert', name: 'Cell break and insert', scope: 'editor', strokes: ['Ctrl + Alt + X'], actions: [
        { type: 'command', command: 'cellBreak' }, { type: 'snippet', template: 'Time' }
      ] };
      const literalBreak = { id: 'cell-code', name: 'Cell code', scope: 'editor', strokes: ['Ctrl + Alt + Q'], actions: [
        { type: 'snippet', template: '`a<br>$0XY`' }
      ] };
      const breakFragment = { id: 'cell-code-fragment', name: 'Code fragment', scope: 'editor', strokes: ['Ctrl + Alt + W'], actions: [
        { type: 'snippet', template: 'c<br>$0D' }
      ] };
      const preferences = { ...global.__preferences, customShortcuts: [...(global.__preferences.customShortcuts ?? []), mixed, cell, cellBreak, literalBreak, breakFragment] };
      global.__preferences = preferences;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences, revision: ++global.__revision } }));
    });
    const textBeforeCaret = () => page.evaluate(() => {
      if (document.activeElement instanceof HTMLTextAreaElement) return document.activeElement.value.slice(0, document.activeElement.selectionStart);
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      return view.state.sliceDoc(view.state.doc.lineAt(view.state.selection.main.head).from, view.state.selection.main.head);
    });
    for (const mode of ['source', 'live'] as const) {
      let text = tableFixture;
      if (mode === 'live') {
        text += '\n' + largeText;
        assert.equal(assessLargeDocument(text).boundedEditorWork, true);
        await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
        await openFixture(text, 'live', false, 'hidden', false, true);
      } else {
        await page.locator('button[data-mode="source"]').click();
      }
      await ready();
      await applyMixedAction();
      await focusStart();
      assert.equal((await editorState()).optimized, mode === 'live');
      if (mode === 'source') {
        await page.evaluate(() => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('first cell') + 2, head: 0 } });
          view.focus();
        });
        await bind('i');
        assert.equal(await documentText(), text, 'A selection that extends from a cell into prose stays intact');
        assert.equal((await editorState()).from, 0);
      }
      await focusCell(mode, true);
      await bind('i');
      const insertedCell = await documentText();
      assert.equal(insertedCell.replace(/\|\s*A \\\| first cell<br>Z\s*\|/, '| first cell |'), text,
        `${mode}: selection replacement escapes pipes, keeps line breaks inside the cell and preserves the document`);
      assert.notEqual(insertedCell, text);
      const caretText = await textBeforeCaret();
      assert.ok(caretText.endsWith('A \\| '), `${mode}: the final marker places the caret before the selected-text variable`);
      await chord('z');
      assert.equal(await documentText(), text, `${mode}: one undo restores the replaced selection`);
      await focusCell(mode, true);
      await bind('q');
      const insertedCode = text.replace('first cell', '`a<br>XY`');
      assert.equal(await documentText(), insertedCode);
      assert.ok((await textBeforeCaret()).endsWith('`a<br>'), `${mode}: the literal break in code does not move the snippet cursor`);
      await bind('w');
      assert.equal(await documentText(), insertedCode.replace('a<br>XY', 'a<br>c<br>DXY'));
      assert.ok((await textBeforeCaret()).endsWith('`a<br>c<br>'), `${mode}: a fragment uses the surrounding inline code syntax`);
      await chord('z');
      assert.equal(await documentText(), insertedCode);
      await chord('z');
      assert.equal(await documentText(), text);
      await focusStart();
      await bind('y');
      const withProse = text.replace('target', '# Prose: target');
      assert.equal(await documentText(), withProse, `${mode}: the mixed binding runs the prose steps in a paragraph`);
      await focusCell(mode, false, 2);
      await bind('y');
      assert.equal(await documentText(), withProse.replace('| first cell |\n', ''),
        `${mode}: the same binding skips the prose steps and deletes just the selected row`);
      await focusCell(mode, false, 2, 'second cell');
      await bind('x');
      assert.match(await documentText(), /\|[^\n]*<br>Time[^\n]*\|/, `${mode}: a cell break is followed by the snippet in the same cell`);
    }
    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    const failureFixture = '# 示例文档\n\n已打开会议记录模板\n\n待填写的会议纪要\n';
    await openFixture(failureFixture);
    await ready();
    await useLanguage('zh-CN');
    await page.evaluate(() => {
      const harness = window as any;
      const view = harness.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const dispatch = view.dispatch.bind(view);
      view.dispatch = (...transactions: any[]) => {
        for (const transaction of transactions) {
          transaction.changes?.iterChanges?.((_from: number, _to: number, _before: number, _after: number, insert: { toString(): string }) => {
            if (insert.toString().includes('MEO_FIXTURE_FAIL')) throw new Error('Simulated editor failure');
          });
        }
        dispatch(...transactions);
      };
      const notes = { id: 'failure-example', name: '插入会议纪要', scope: 'editor', strokes: ['Ctrl + Alt + J'], actions: [
        { type: 'snippet', template: '# 会议纪要\n\n' },
        { type: 'snippet', template: 'MEO_FIXTURE_FAIL' },
        { type: 'snippet', template: '第三步不应执行' }
      ] };
      const moveAndInsert = { id: 'continue-example', name: '上移并插入', scope: 'editor', strokes: ['Ctrl + Alt + M'], actions: [
        { type: 'command', command: 'moveUp' }, { type: 'snippet', template: '已继续执行' }
      ] };
      harness.__preferences = { ...harness.__preferences, customShortcuts: [notes, moveAndInsert] };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: harness.__preferences, revision: ++harness.__revision } }));
    });
    await page.evaluate(() => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('待填写的会议纪要') } });
      view.focus();
    });
    await bind('j');
    const executionError = '.editor-notice[data-kind="error"]';
    await page.waitForSelector(executionError, { visible: true });
    assert.match(await page.$eval(executionError, notice => notice.textContent ?? ''), /自定义动作执行失败.*插入会议纪要.*第 2 步.*插入片段.*已完成的修改会保留/);
    const partlyApplied = failureFixture.replace('待填写的会议纪要', '# 会议纪要\n\n待填写的会议纪要');
    assert.equal(await documentText(), partlyApplied);
    await page.screenshot({ path: screenshots + '/shortcut-execution-failure.png', clip: { x: 0, y: 0, width: 1100, height: 264 } });
    await page.locator(executionError + ' .editor-notice-close').click();
    await page.waitForSelector(executionError, { hidden: true });
    await focusStart();
    await bind('m');
    assert.equal(await documentText(), '已继续执行' + partlyApplied);
    assert.equal(await page.$(executionError), null, 'Skip is quiet and does not show an execution failure');
    assert.deepEqual(errors, []);
    console.log('Custom shortcuts: settings, scoped steps, prose and table snippets, timestamps, cell-safe formatting and undo (Source and optimized Live) passed');
    if (process.argv.includes('--custom-shortcuts-only')) { await closeTestBrowser(browser); process.exit(0); }
    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  }
  if (process.argv.includes('--keycaps-only') || process.argv.length === 2) {
    const folder = path.resolve('.local/test-artifacts/ui-keycaps'); await fs.mkdir(folder, { recursive: true });
    const sample = (selector: string, carrier: string) => page.$eval(selector, (cap, carrier) => {
      const style = getComputedStyle(cap), parent = getComputedStyle(cap.closest(carrier)!);
      const roles = document.documentElement.style;
      return { background: style.backgroundColor, color: style.color, shadow: style.boxShadow, border: style.borderTopColor,
        borderWidth: style.borderWidth, bottom: style.borderBottomColor, parent: parent.backgroundColor, outline: style.outlineStyle,
        height: style.height, radius: style.borderRadius, align: style.alignItems,
        controlBorder: roles.getPropertyValue('--meo-ui-border-control'),
        hover: roles.getPropertyValue('--meo-ui-surface-hover'),
        field: roles.getPropertyValue('--meo-ui-surface-field') };
    }, carrier);
    for (const appearance of ['light', 'dark'] as const) for (const language of ['zh-CN', 'en'] as const) {
      await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
      const text = '# Keyboard labels\n\n按 <kbd>Enter</kbd> 继续 / Press to continue\n\n';
      await openFixture(text, 'live');
      // VS Code injects this KBD carrier before extension CSS. Keep a dark host
      // for both editor appearances to cover the reported light/dark mismatch.
      await page.addStyleTag({ content: `
        :root { --vscode-keybindingLabel-background: rgba(128,128,128,.17); --vscode-keybindingLabel-foreground: #CCC;
          --vscode-keybindingLabel-border: rgba(51,51,51,.6); --vscode-keybindingLabel-bottomBorder: rgba(68,68,68,.6);
          --vscode-widget-shadow: rgba(0,0,0,.36); }
        kbd { background-color: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground);
          border-style: solid; border-width: 1px; border-radius: 3px; border-color: var(--vscode-keybindingLabel-border);
          border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
          vertical-align: middle; padding: 1px 3px; }
      ` });
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
      await page.evaluate(language => window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiLanguageChanged', uiLanguagePreference: language, uiLanguage: language, automaticUiLanguage: language } })), language);
      await page.locator('.more-tools-wrapper > .format-button').click();
      await page.locator(`button.editor-appearance-button[data-editor-appearance="${appearance}"]`).click();
      await page.locator('.more-tools-wrapper > .format-button').click();
      await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus();
      });
      await page.keyboard.type('/'); await page.waitForSelector('.meo-input-suggestions:not([hidden])');
      const menu = await sample('.meo-suggestion-key kbd[data-key="Enter"]', '.meo-input-suggestions');
      // Beyond-viewport capture can transiently resize Chromium's layout viewport
      // to 1x1 and legitimately dismiss a caret-anchored menu. These UI crops are
      // already visible and must preserve the interactive page's viewport.
      await (await page.$('.meo-input-suggestions:not([hidden])'))!.screenshot({ path: path.join(folder, `menu-${language}-${appearance}.png`), captureBeyondViewport: false });
      await (await page.$('.meo-suggestion-guidance'))!.screenshot({ path: path.join(folder, `guidance-${language}-${appearance}.png`), captureBeyondViewport: false });
      const documentKbd = '.editor-host .cm-content kbd';
      const documentLine = await page.$eval(documentKbd, key => key.closest('.cm-line')!.getBoundingClientRect().toJSON());
      await page.screenshot({ path: path.join(folder, `document-${language}-${appearance}.png`), captureBeyondViewport: false, clip: {
        x: Math.floor(documentLine.x) - 6, y: Math.floor(documentLine.y) - 4,
        width: Math.min(420, Math.ceil(documentLine.width) + 12), height: Math.ceil(documentLine.height) + 8
      } });
      await page.keyboard.press('Escape'); await page.hover('[data-action="find"]');
      await page.waitForSelector('.meo-tooltip.is-visible .meo-tooltip-shortcut:not([hidden])');
      const tooltip = await sample('.meo-tooltip.is-visible .meo-tooltip-shortcut', '.meo-tooltip');
      await (await page.$('.meo-tooltip.is-visible'))!.screenshot({ path: path.join(folder, `tooltip-${language}-${appearance}.png`), captureBeyondViewport: false });
      await page.keyboard.press('Escape'); await page.mouse.move(2, 2);
      await page.locator('.more-tools-wrapper > .format-button').click(); await page.locator('.more-tools-settings-button').click();
      await page.locator('.settings-tab[data-tab="shortcuts"]').click();
      const settings = await sample('.settings-key', '.settings-window');
      await (await page.$('.settings-key'))!.evaluate(cap => cap.closest('.settings-item')!.setAttribute('data-keycap-sample', ''));
      await (await page.$('[data-keycap-sample]'))!.screenshot({ path: path.join(folder, `settings-${language}-${appearance}.png`), captureBeyondViewport: false });
      const keys = await page.$eval('.settings-shortcut-keys', group => group.getBoundingClientRect().toJSON());
      await page.screenshot({ path: path.join(folder, `binding-${language}-${appearance}.png`), captureBeyondViewport: false, clip: {
        x: Math.floor(keys.x) - 6, y: Math.floor(keys.y) - 6, width: Math.ceil(keys.right) - Math.floor(keys.x) + 12, height: Math.ceil(keys.bottom) - Math.floor(keys.y) + 12
      } });
      assert.equal(tooltip.background, appearance === 'dark' ? 'rgba(255, 255, 255, 0.18)' : 'rgb(85, 85, 85)', 'tooltip shortcut keeps its original fill');
      assert.equal(tooltip.shadow, 'none', 'tooltip shortcut has no added shadow');
      assert.equal(tooltip.outline, 'none', 'tooltip shortcut has no added outline');
      for (const [kind, cap] of Object.entries({ menu, settings })) {
        assert.equal(cap.shadow, 'rgba(0, 0, 0, 0.36) 0px -1px 0px 0px inset', kind + ': original VS Code inset is preserved');
        assert.equal(cap.outline, 'none', kind + ': no added outline');
        assert.equal(cap.borderWidth, '1px', kind + ': original host border width is preserved');
        assert.equal(cap.radius, '4px', kind + ': original corner radius is preserved');
        assert.deepEqual(channels(cap.background), channels(kind === 'menu' ? cap.hover : cap.field), kind + ': original fill rule is preserved in both appearances');
        if (kind === 'settings') assert.deepEqual(channels(cap.border), channels(cap.controlBorder), 'settings: original border color is preserved');
        assert.ok(contrast(cap.color, cap.background) >= 4.5, kind + ': key text stays readable');
        if (kind === 'menu') {
          assert.equal(cap.height, '20px'); assert.equal(cap.align, 'center');
          if (appearance === 'dark') {
            assert.deepEqual(channels(cap.border), channels(cap.controlBorder), 'dark menu: existing frame uses the editor UI border color');
            assert.ok(contrast(cap.border, cap.background) >= 2, 'dark menu: existing frame remains visible against the light fill');
          } else {
            assert.equal(cap.border, 'rgba(51, 51, 51, 0.6)', 'light menu: host frame color is unchanged');
            assert.equal(cap.bottom, 'rgba(68, 68, 68, 0.6)', 'light menu: host lower edge color is unchanged');
          }
        }
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        return view.hasFocus && view.state.doc.toString().endsWith('/');
      }), true, 'closing the styled settings restores the unchanged document');
      if (appearance === 'dark' && language === 'en') {
        const documentKey = () => page.$eval(documentKbd, cap => {
          const style = getComputedStyle(cap); return [style.backgroundColor, style.color, style.borderColor, style.boxShadow];
        });
        const documentKeyBefore = await documentKey();
        for (const surface of ['#000000', '#777777', '#002244', '#EEEEEE']) {
          await page.evaluate(surface => window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiColorsChanged', colors: { light: {}, dark: { surface } } } })), surface);
          const roles = await page.evaluate(() => {
            const style = document.documentElement.style;
            return ['surface-hover', 'text', 'text-muted'].map(name => style.getPropertyValue('--meo-ui-' + name));
          });
          assert.ok(contrast(roles[1], roles[0]) >= 4.5 && contrast(roles[2], roles[0]) >= 4.5, 'custom ' + surface + ': inherited key text stays readable');
          assert.deepEqual(await documentKey(), documentKeyBefore, 'UI keycap colors cannot change document KBD');
        }
        await page.evaluate(() => {
          document.body.className = 'vscode-high-contrast'; document.documentElement.style.setProperty('--vscode-contrastBorder', '#FFFFFF');
          document.documentElement.style.setProperty('--vscode-keybindingLabel-border', '#6FC3DF');
          document.documentElement.style.setProperty('--vscode-keybindingLabel-bottomBorder', '#6FC3DF');
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'vscodeCodeThemeChanged', appearance: 'dark', vscodeTheme: { name: 'Keycap HC fixture', type: 'dark', colors: {}, tokenColors: [] } } }));
        });
        await page.keyboard.type(' /'); await page.waitForSelector('.meo-input-suggestions:not([hidden])');
        const cap = await sample('.meo-suggestion-key kbd[data-key="Enter"]', '.meo-input-suggestions');
        assert.equal(cap.shadow, 'rgba(0, 0, 0, 0.36) 0px -1px 0px 0px inset', 'high contrast retains the host inset');
        assert.equal(cap.border, 'rgb(111, 195, 223)', 'high contrast retains the native keybinding border');
        assert.equal(cap.outline, 'none', 'high contrast has no added keycap outline');
        await page.keyboard.press('Escape');
      }
    }
    assert.deepEqual(errors, []); console.log('UI keycaps: real VS Code KBD carrier, matching light/dark geometry, existing frame recolored in dark UI, original fills/insets/tooltips, custom colors and document KBD isolation passed; screenshots: ' + folder);
    if (process.argv.includes('--keycaps-only')) { await closeTestBrowser(browser); process.exit(0); }
  }
  if (process.argv.includes('--suggestions-only') || process.argv.length === 2) {
    const folder = path.resolve('.local/test-artifacts/suggestion-guidance'); await fs.mkdir(folder, { recursive: true });
    const examples = [
      { kind: 'slash', before: '', after: '', typed: '/', setting: 'slash' },
      { kind: 'documents', before: '[[', after: ']]', typed: 'pr', setting: 'documentSuggestions' },
      { kind: 'paths', before: '[Guide](./', after: ')', typed: 'g', setting: 'documentSuggestions' },
      { kind: 'headings', before: '[Go](#', after: ')', typed: 'ov', setting: 'documentSuggestions' },
      { kind: 'emoji', before: '', after: '', typed: ':s', setting: 'emoji' },
      { kind: 'math', before: '$', after: '$', typed: '\\s', setting: 'math' },
      { kind: 'html', name: 'html-tags', before: '', after: '', typed: '<d', setting: 'html' },
      { kind: 'html', name: 'html-attributes', before: '<div ', after: '></div>', typed: 'c', setting: 'html' },
      { kind: 'html', name: 'html-values', before: '<input type="', after: '">', typed: 't', setting: 'html' }
    ];
    for (const mode of ['source', 'live'] as const) for (const language of ['zh-CN', 'en'] as const) {
      await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
      await openFixture('', mode);
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
      await page.evaluate(language => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiLanguageChanged', uiLanguagePreference: language, uiLanguage: language, automaticUiLanguage: language } }));
        const g = window as any; g.__preferences.input.emoji = true;
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
      }, language);
      await page.locator('.more-tools-wrapper > .format-button').click();
      await page.locator(`button.editor-appearance-button[data-editor-appearance="${language === 'en' ? 'dark' : 'light'}"]`).click();
      await page.locator('.more-tools-wrapper > .format-button').click();
      for (const [index, item] of examples.entries()) {
        const label = `${mode}/${language}/${item.name ?? item.kind}`;
        const above = index % 2 === 1;
        await page.evaluate(({ item, above }) => {
          const g = window as any, view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          g.__linkCandidates = [{ label: 'Project guide.md', insert: 'project-guide.md', detail: 'docs/project-guide.md', kind: 'file' }, { label: 'Project notes.md', insert: 'project-notes.md', detail: 'docs/project-notes.md', kind: 'file' }];
          g.__preferences.input.slashPreferAbove = above;
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
          const prefix = '# Overview\n\n' + 'Example paragraph.\n\n'.repeat(8), from = prefix.length + item.before.length;
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: prefix + item.before + item.after }, selection: { anchor: from }, scrollIntoView: true }); view.focus();
        }, { item, above });
        await page.keyboard.type(item.typed);
        await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 3000 });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const layout = await page.evaluate(() => {
          const popup = document.querySelector<HTMLElement>('.meo-input-suggestions:not([hidden])')!, footer = popup.querySelector<HTMLElement>('.meo-suggestion-guidance')!, list = popup.querySelector<HTMLElement>('.meo-suggestion-list')!;
          const groups = [...footer.querySelectorAll<HTMLElement>('.meo-suggestion-key')].map(key => key.getBoundingClientRect());
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          return { kind: popup.dataset.suggestionKind, placement: popup.dataset.placement, width: popup.getBoundingClientRect().width,
            footer: footer.getBoundingClientRect().toJSON(), list: list.getBoundingClientRect().toJSON(), fits: footer.scrollWidth <= footer.clientWidth + 1, footerScrollWidth: footer.scrollWidth, footerClientWidth: footer.clientWidth, footerFont: getComputedStyle(footer).font,
            singleLine: groups.every(group => group.top === groups[0].top), keys: [...footer.querySelectorAll<HTMLElement>('kbd')].map(key => key.dataset.key),
            centeredKeys: [...footer.querySelectorAll('kbd')].every(key => {
              const cap = key.getBoundingClientRect(), ink = key.firstElementChild!.getBoundingClientRect();
              return cap.height === 20 && Math.abs(cap.top + cap.height / 2 - ink.top - ink.height / 2) < 0.5 && Math.abs(cap.left + cap.width / 2 - ink.left - ink.width / 2) < 0.5;
            }), arrowIcon: !!footer.querySelector('kbd[aria-label] svg'),
            unifiedGuidance: getComputedStyle(footer).backgroundColor === getComputedStyle(popup).backgroundColor,
            insetSeparator: (() => { const line = getComputedStyle(footer, '::before'), frame = getComputedStyle(footer);
              return line.content !== 'none' && parseFloat(line.left) >= 8 && parseFloat(line.right) >= 8 && parseFloat(line.height) === 1
                && frame.borderTopWidth === '0px' && frame.borderBottomWidth === '0px'; })(),
            text: view.state.doc.toString(), selection: view.state.selection.main.toJSON(), updates: (window as any).__messages.filter((m: any) => m.type === 'updateEditingPreferences').length };
        });
        assert.equal(layout.kind, item.kind, label); assert.equal(layout.placement, above ? 'above' : 'below', label + ': actual placement');
        assert.equal(layout.fits && layout.singleLine, true, label + ': complete guidance fits one line: ' + JSON.stringify(layout));
        assert.deepEqual(layout.keys, ['↑↓', 'Enter', 'Esc']); assert.ok(layout.width >= (language === 'en' ? 304 : 288), label + ': widened fixed minimum');
        assert.equal(layout.centeredKeys && layout.arrowIcon && layout.unifiedGuidance && layout.insetSeparator, true, label + ': centered key contents, vector arrows, shared surface and an inset separator');
        assert.ok(above ? layout.footer.bottom <= layout.list.top + 1 : layout.footer.top >= layout.list.bottom - 1, label + ': guidance stays away from input');
        if (mode === 'source') await (await page.$('.meo-input-suggestions:not([hidden])'))!.screenshot({ path: path.join(folder, `${language}-${item.name ?? item.kind}.png`), captureBeyondViewport: false });
        await page.locator('.meo-suggestion-settings').click();
        await page.waitForSelector('.settings-window[open]');
        assert.equal(await page.$('.meo-input-suggestions:not([hidden])'), null, label + ': candidate popup closes');
        assert.equal(await page.$eval('.settings-tab[data-tab="typing"]', tab => tab.getAttribute('aria-selected')), 'true');
        const target = `.settings-item[data-setting="${item.setting}"]`;
        assert.equal(await page.$eval(target, row => row.classList.contains('is-revealed')), true, label + ': correct shared setting is emphasized');
        assert.equal(await page.evaluate(({ target, layout }) => {
          const g = window as any, view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          const row = document.querySelector(target)!, control = row.querySelector('button')!, box = row.getBoundingClientRect(), viewport = document.querySelector('.settings-content')!.getBoundingClientRect();
          return control === document.activeElement && box.top >= viewport.top && box.bottom <= viewport.bottom
            && g.__preferences.input[row.getAttribute('data-setting')!] === true
            && view.state.doc.toString() === layout.text && JSON.stringify(view.state.selection.main.toJSON()) === JSON.stringify(layout.selection)
            && g.__messages.filter((m: any) => m.type === 'updateEditingPreferences').length === layout.updates;
        }, { target, layout }), true, label + ': focused visible setting, unchanged value/text/selection');
        if (mode === 'source' && item.kind === 'slash') {
          await page.screenshot({ path: path.join(folder, `${language}-settings.png`) });
          const typography = () => page.$eval(target + ' .settings-item-title', row => ({ color: getComputedStyle(row).color, weight: getComputedStyle(row).fontWeight }));
          const before = await typography();
          await page.waitForFunction(target => !document.querySelector(target)?.classList.contains('is-revealed'), { timeout: 3000 }, target);
          assert.deepEqual(await typography(), before, 'setting emphasis never changes text color or weight');
          await page.locator(target + ' button').click();
          await page.waitForFunction(setting => (window as any).__preferences.input[setting] === false, {}, item.setting);
          assert.equal(await page.$eval(target + ' button', control => control.getAttribute('aria-checked')), 'false', 'the user can disable the feature through the revealed control');
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.settings-window[open]'));
        assert.equal(await page.evaluate(() => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')); return view.hasFocus;
        }), true, label + ': closing returns to the document');
      }
    }
    assert.deepEqual(errors, []); console.log('Candidate guidance: seven kinds, HTML subtypes, bilingual themes, both modes, actual sides, setting scope and focus passed; screenshots: ' + folder);
    if (process.argv.includes('--suggestions-only')) { await closeTestBrowser(browser); process.exit(0); }
  }
  if (process.argv.includes('--content-width-only') || process.argv.length === 2) {
    const folder = path.join('.local', 'test-runs', 'content-width');
    await fs.mkdir(folder, { recursive: true });
    const quick = '.more-tools-panel [data-content-width-row]';
    const field = `${quick} .content-width-input`;
    const full = '[data-setting="widthValue"]';
    const width = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--meo-content-max-width'));
    const fill = async (selector: string, text: string) => {
      await page.click(selector); await chord('a'); await page.keyboard.press('Backspace');
      if (text) await page.type(selector, text);
    };
    const messageCount = () => page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'setContentMaxWidth').length);
    const layout = (selector: string) => page.$eval(selector, input => {
      const row = input.closest<HTMLElement>('[data-content-width-row], .settings-item')!;
      const menu = input.closest<HTMLElement>('.more-tools-panel, .settings-window')!;
      return { rowHeight: row.getBoundingClientRect().height, menuHeight: menu.getBoundingClientRect().height,
        nextTop: row.nextElementSibling?.getBoundingClientRect().top ?? null };
    });
    const hint = (selector: string) => page.$eval(selector, input => {
      const id = input.getAttribute('aria-describedby')?.split(/\s+/).find(id => document.getElementById(id)?.matches('.meo-tooltip'));
      const tooltip = id ? document.getElementById(id) : null;
      const rect = tooltip?.getBoundingClientRect();
      return { visible: !!tooltip && getComputedStyle(tooltip).visibility === 'visible' && getComputedStyle(tooltip).opacity === '1',
        text: tooltip?.querySelector('.meo-tooltip-text')?.textContent ?? '',
        contained: !!rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        unclipped: !!tooltip && tooltip.scrollWidth <= tooltip.clientWidth && tooltip.scrollHeight <= tooltip.clientHeight,
        modalOwner: !!tooltip && tooltip.closest('dialog') === input.closest('dialog') };
    });
    const widthInfo = '[data-action="contentMaxWidth"] .more-tools-option-info';
    const showWidthHint = async (text: string) => {
      await page.hover(widthInfo);
      await page.waitForFunction(() => {
        const tooltip = document.querySelector('#document-width-tooltip.is-visible');
        return tooltip && getComputedStyle(tooltip).opacity === '1';
      });
      assert.deepEqual(await hint('[data-action="contentMaxWidth"]'), { visible: true, text, contained: true, unclipped: true, modalOwner: true });
    };
    for (const mode of ['source', 'live'] as const) for (const large of [false, true]) {
      const sample = '# Width\n\n| A | B |\n| --- | --- |\n| One | Two |\n\n$$x+y$$\n\n'
        + 'Paragraph with enough words to wrap when the reading area changes.\n\n'.repeat(large ? 4500 : 35);
      await openFixture(sample, mode);
      await page.setViewport({ width: 1400, height: 900 });
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
      assert.equal(assessLargeDocument(sample).boundedEditorWork, large, 'paired document sizes exercise the production policy');
      await page.mouse.move(650, 600); await page.mouse.wheel({ deltaY: large ? 1800 : 300 });
      await page.waitForFunction(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).scrollDOM.scrollTop > 100);
      await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
      const before = await page.evaluate(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        const from = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
        view.dispatch({ selection: { anchor: from + 1, head: from + 5 } });
        return { selection: view.state.selection.toJSON(), text: view.state.doc.toString(),
          readingLine: view.state.doc.lineAt(from).number };
      });
      await page.click('.more-tools-wrapper > .format-button');
      assert.equal(await page.$eval(quick, e => (e as HTMLElement).hidden), true, 'the second width row is hidden while limiting is off');
      await showWidthHint('开启后，限制实时和源码模式下的文档显示宽度。');
      await page.click(widthInfo);
      assert.equal(await page.$eval('[data-action="contentMaxWidth"]', e => e.getAttribute('aria-checked')), 'false', 'the information icon does not toggle document width');
      await page.click('[data-action="contentMaxWidth"]');
      assert.equal(await page.$eval('.more-tools-panel', e => (e as HTMLElement).hidden), false, 'toggle keeps the menu open');
      assert.equal(await page.$eval(quick, e => (e as HTMLElement).hidden), false);
      assert.ok(await page.$eval(quick, row => {
        const label = row.querySelector('.more-tools-control-label')!.getBoundingClientRect();
        const stepper = row.querySelector('.content-width-stepper')!.getBoundingClientRect();
        const toggle = document.querySelector('[data-action="contentMaxWidth"]')!;
        const switchBox = toggle.getBoundingClientRect();
        const parentLabel = toggle.querySelector('.more-tools-option-label')!.getBoundingClientRect();
        return row.previousElementSibling === toggle && label.right <= stepper.left && label.top >= switchBox.bottom
          && Math.abs(label.left - parentLabel.left) < 1;
      }), 'the numeric row sits below the switch row and aligns with its text');
      assert.equal(await width(), '1200px');
      await fill(field, '850');
      assert.equal(await width(), '1200px', 'typing a draft does not reflow the document');
      const count = await messageCount();
      await page.click(`${quick} [data-width-action="increase"]`);
      assert.equal(await width(), '950px');
      assert.equal(await page.$eval('[data-action="contentMaxWidth"]', e => e.getAttribute('aria-checked')), 'true', 'stepping the width must not toggle its parent setting');
      assert.equal(await messageCount(), count + 1, 'draft plus pointer step saves only the final width');
      await fill(field, '1200'); await page.keyboard.press('Enter');
      assert.equal(await width(), '1200px');
      const validLayout = await layout(field);
      for (const invalid of ['', '399', '2401', '800.5', 'abc']) {
        await fill(field, invalid); await page.keyboard.press('Enter');
        assert.equal(await page.$eval(field, e => e.getAttribute('aria-invalid')), 'true');
        assert.equal(await width(), '1200px', 'invalid drafts retain the accepted width');
        assert.deepEqual(await layout(field), validLayout, 'validation does not move settings rows or resize the menu');
        assert.deepEqual(await hint(field), { visible: true, text: '请输入400～2400之间的整数。', contained: true, unclipped: true, modalOwner: true });
      }
      await fill(field, '400'); await page.keyboard.press('Enter');
      assert.equal(await page.$eval(`${quick} [data-width-action="decrease"]`, e => (e as HTMLButtonElement).disabled), true);
      await fill(field, '2390'); await page.keyboard.press('Enter');
      await page.click(`${quick} [data-width-action="increase"]`);
      assert.equal(await width(), '2400px');
      assert.equal(await page.$eval(`${quick} [data-width-action="increase"]`, e => (e as HTMLButtonElement).disabled), true);
      await fill(field, '7000'); await page.keyboard.press('Enter');
      const disabledHint = await page.$eval(field, e => e.getAttribute('aria-describedby'));
      await page.click('[data-action="contentMaxWidth"]');
      assert.equal(await page.$eval(quick, e => (e as HTMLElement).hidden), true);
      assert.equal(await page.$eval(field, e => (e as HTMLInputElement).disabled), true);
      assert.equal(await page.$eval(field, e => e.hasAttribute('aria-invalid') || e.hasAttribute('aria-describedby')), false);
      assert.equal(await page.$(`#${disabledHint}`), null, 'disabling width removes the owned validation surface');
      assert.equal(await width(), '');
      await page.click('[data-action="contentMaxWidth"]');
      assert.equal(await width(), '2400px', 're-enabling restores the last pixel width');
      await page.click('.more-tools-settings-button');
      assert.equal(await page.$eval(full, e => (e as HTMLElement).dataset.parentSetting), 'width');
      assert.equal(await page.$eval(`${full} .content-width-input`, e => (e as HTMLInputElement).value), '2400');
      await fill(`${full} .content-width-input`, '7000'); await page.keyboard.press('Enter');
      await page.click('[data-setting="width"] [role="switch"]');
      assert.equal(await page.$eval(`${full} .content-width-input`, e => (e as HTMLInputElement).disabled), true);
      assert.equal(await page.$eval(`${full} .content-width-input`, e => e.hasAttribute('aria-invalid') || e.hasAttribute('aria-describedby')), false);
      assert.equal(await page.$eval(full, e => e.getBoundingClientRect().height > 0), true, 'the dependent setting remains discoverable while disabled');
      await page.click('[data-setting="width"] [role="switch"]');
      await fill(`${full} .content-width-input`, '1100');
      await page.click('.settings-title');
      assert.equal(await width(), '1100px', 'valid blur commits the input');
      await page.click(`${full} [data-width-action="reset"]`);
      assert.equal(await width(), '1200px');
      const fullLayout = await layout(`${full} .content-width-input`);
      await fill(`${full} .content-width-input`, '7000'); await page.keyboard.press('Enter');
      assert.deepEqual(await layout(`${full} .content-width-input`), fullLayout, 'validation does not shift the full settings window');
      assert.deepEqual(await hint(`${full} .content-width-input`), { visible: true, text: '请输入400～2400之间的整数。', contained: true, unclipped: true, modalOwner: true });
      await page.screenshot({ path: path.join(folder, `full-error-${mode}-${large ? 'large' : 'ordinary'}-zh.png`) });
      await page.click(`${full} [data-width-action="reset"]`);
      assert.equal(await page.$eval(`${full} .content-width-input`, e => e.hasAttribute('aria-describedby')), false, 'reset retires the owned validation tooltip');
      await page.screenshot({ path: path.join(folder, `${mode}-${large ? 'large' : 'ordinary'}-zh.png`) });
      await page.click('.settings-close');
      await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
      const after = await page.evaluate(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        return { selection: view.state.selection.toJSON(), text: view.state.doc.toString(), focus: view.hasFocus,
          optimized: h.usesLargeDocumentDerivedWorkBudget(view.state),
          readingLine: view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number };
      });
      assert.deepEqual(after.selection, before.selection); assert.equal(after.text, before.text);
      assert.equal(after.focus, true); assert.equal(after.optimized, large);
      assert.ok(Math.abs(after.readingLine - before.readingLine) <= 1, `${mode}/${large}: width changes retain the reading line (${before.readingLine} -> ${after.readingLine})`);
      await page.setViewport({ width: 360, height: 780 });
      await page.click('.more-tools-wrapper > .format-button');
      await fill(field, '2400'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'a large configured maximum does not widen a narrow pane');
      await page.screenshot({ path: path.join(folder, `${mode}-${large ? 'large' : 'ordinary'}-narrow.png`) });
      console.log(`Content width ${mode}/${large ? 'optimized' : 'ordinary'}: input, pointer step, bounds, hierarchy, focus and narrow layout passed`);
    }
    const widthSurfaceColors = new Set<string>();
    for (const language of ['en', 'zh-CN'] as const) for (const appearance of ['light', 'dark'] as const) {
      // Use a fresh Webview for each independent palette/language case.
      await page.close(); page = await browser.newPage();
      page.on('pageerror', error => errors.push(String(error)));
      await openFixture();
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden'));
      await page.evaluate(language => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiLanguageChanged', uiLanguagePreference: language, uiLanguage: language, automaticUiLanguage: language } }));
      }, language);
      await page.locator('.more-tools-wrapper > .format-button').click();
      await page.locator(`button.editor-appearance-button[data-editor-appearance="${appearance}"]`).click();
      widthSurfaceColors.add(await page.$eval('.more-tools-panel', e => getComputedStyle(e).backgroundColor));
      await page.click('[data-action="contentMaxWidth"]');
      assert.equal(await page.$eval('[data-action="contentMaxWidth"] .more-tools-option-label', e => e.textContent), language === 'en' ? 'Limit document width' : '限制文档宽度');
      assert.equal(await page.$eval(`${quick} .more-tools-control-label`, e => e.textContent), language === 'en' ? 'Maximum width' : '最大文档宽度');
      assert.ok(await page.$eval(`${quick} .more-tools-control-label`, e => e.scrollWidth <= e.clientWidth), 'the complete maximum-width label fits beside its controls');
      await page.screenshot({ path: path.join(folder, `quick-${language}-${appearance}.png`) });
      const scopeText = language === 'en' ? 'When enabled, limits the displayed document width in Live and Source modes.' : '开启后，限制实时和源码模式下的文档显示宽度。';
      await showWidthHint(scopeText);
      await page.screenshot({ path: path.join(folder, `quick-info-${language}-${appearance}.png`) });
      await page.click(widthInfo);
      assert.equal(await page.$eval('[data-action="contentMaxWidth"]', e => e.getAttribute('aria-checked')), 'true');
      await page.focus('[data-action="longCodeBlockFolding"]');
      await page.keyboard.press('Tab');
      assert.equal(await page.$eval('[data-action="contentMaxWidth"]', e => e === document.activeElement), true);
      await page.waitForFunction(() => document.querySelector('#document-width-tooltip.is-visible'));
      assert.equal((await hint('[data-action="contentMaxWidth"]')).visible, true, 'keyboard focus also exposes the scope explanation');
      const beforeError = await layout(field);
      await fill(field, '7000'); await page.keyboard.press('Enter');
      assert.deepEqual(await layout(field), beforeError);
      const errorText = language === 'en' ? 'Enter a whole number from 400 to 2400.' : '请输入400～2400之间的整数。';
      assert.deepEqual(await hint(field), { visible: true, text: errorText, contained: true, unclipped: true, modalOwner: true });
      await page.screenshot({ path: path.join(folder, `quick-error-${language}-${appearance}.png`) });
      await page.keyboard.press('Tab');
      assert.equal((await hint(field)).visible, false, 'leaving the input dismisses the validation hint');
      await page.setViewport({ width: 360, height: 780 });
      // Refocus after the responsive toolbar has repositioned its menu.
      await page.locator(field).click();
      assert.deepEqual(await hint(field), { visible: true, text: errorText, contained: true, unclipped: true, modalOwner: true });
      await page.screenshot({ path: path.join(folder, `quick-error-${language}-${appearance}-narrow.png`) });
      await page.keyboard.press('Tab');
      assert.equal((await hint(field)).visible, false, 'leaving the input dismisses the validation hint');
      await page.click(field);
      assert.equal((await hint(field)).visible, true, 'returning to an invalid input reveals its explanation');
      await fill(field, '800'); await page.keyboard.press('Enter');
      assert.equal(await page.$eval(field, e => e.hasAttribute('aria-invalid') || e.hasAttribute('aria-describedby')), false, 'correcting the value removes stale validation feedback');
      await showWidthHint(scopeText);
      await page.screenshot({ path: path.join(folder, `quick-info-${language}-${appearance}-narrow.png`) });
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.more-tools-settings-button');
      for (const query of language === 'en' ? ['limit document width', 'maximum width', 'pixels'] : ['限制文档宽度', '最大文档宽度', '像素']) {
        await fill('.settings-search', query);
        assert.deepEqual(await page.$$eval('.settings-item', nodes => nodes.map(node => (node as HTMLElement).dataset.setting)), ['width', 'widthValue'], 'both the menu label and numeric aliases retain the parent switch in settings search');
      }
      await page.setViewport({ width: 500, height: 780 });
      await page.screenshot({ path: path.join(folder, `full-${language}-${appearance}-narrow.png`) });
      assert.equal(await page.$eval('.settings-window', e => e.scrollWidth <= e.clientWidth), true);
      await page.click('.settings-close');
      console.log(`Content width ${language}/${appearance}: actual palette, dependent search and narrow settings passed`);
    }
    assert.equal(widthSurfaceColors.size, 2, 'width controls are inspected under both actual UI palettes');
    await page.exposeFunction('__renderWidthPreview', (request: { text: string; uiLanguage: 'en' | 'zh-CN'; preset?: PreviewPresetId }) =>
      renderPreviewDocument({ markdownText: request.text, uiLanguage: request.uiLanguage, preset: request.preset, sourceDocumentPath: '' }));
    await openFixture('# Preview width\n\nPreview retains its own reading layout.');
    await page.evaluate(() => {
      const scope = window as any; scope.__renderLatexPreview = scope.__renderWidthPreview;
      const request = scope.__messages.findLast((m: any) => m.type === 'requestPreviewRender');
      if (request) scope.__renderWidthPreview(request).then((value: unknown) => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'previewRenderResult', requestId: request.requestId, result: { ok: true, value } }
      })));
    });
    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc')
      && document.querySelector<HTMLElement>('.preview-status')?.hidden && !document.querySelector('.editor-host')?.hasAttribute('data-preview-cover'));
    const previewBefore = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!.querySelector<HTMLElement>('.meo-export-doc')!;
      (window as any).__widthPreviewDocument = doc;
      return { width: doc.getBoundingClientRect().width, html: doc.innerHTML,
        requests: (window as any).__messages.filter((m: any) => m.type === 'requestPreviewRender').length };
    });
    await page.click('.more-tools-wrapper > .format-button'); await page.click('[data-action="contentMaxWidth"]');
    await fill(field, '400'); await page.keyboard.press('Enter');
    await fill(field, '2400'); await page.keyboard.press('Enter');
    const previewAfter = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector<HTMLElement>('.meo-export-doc')!;
      return { width: doc.getBoundingClientRect().width, html: doc.innerHTML,
        requests: (window as any).__messages.filter((m: any) => m.type === 'requestPreviewRender').length,
        same: doc === (window as any).__widthPreviewDocument };
    });
    assert.deepEqual(previewAfter, { ...previewBefore, same: true }, 'editor width changes retain the exact Preview document, width and render request count');
    await page.evaluate(() => { delete (window as any).__renderLatexPreview; });
    assert.deepEqual(errors, []);
    if (process.argv.includes('--content-width-only')) { await closeTestBrowser(browser); process.exit(0); }
  }
  if (process.argv.includes('--host-language-only') || process.argv.length === 2) {
    for (const text of ['# Language\n\nSelected prose\n', '# Language\n\n' + 'Large document language setting body.\n\n'.repeat(18000)]) {
      await openFixture(text);
      await page.waitForFunction(() => document.querySelector('.cm-content') && document.querySelector('.editor-loading')?.hasAttribute('hidden') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
      await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ selection: { anchor: 3, head: 9 } });
        view.scrollDOM.scrollTop = Math.min(1200, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await page.evaluate(() => {
        const global = window as any;
        const view = global.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        global.__languageView = view; global.__languageDocument = view.state.doc;
        return { selection: view.state.selection.toJSON(), top: view.scrollDOM.scrollTop };
      });
      for (const [preference, language] of [['en', 'en'], ['zh-CN', 'zh-CN'], ['auto', 'en'], ['auto', 'zh-CN']] as const) {
        await page.evaluate(({ preference, language }) => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'uiLanguageChanged', uiLanguagePreference: preference, uiLanguage: language, automaticUiLanguage: language
        } })), { preference, language });
        await page.waitForFunction(({ preference, language }) => {
          const input = document.querySelector<HTMLInputElement>('.line-jump-input');
          return document.documentElement.lang === language && input?.placeholder === (language === 'en' ? 'Lines' : '行号')
            && input.getAttribute('aria-label') === (language === 'en' ? 'Go to line' : '跳转到行')
            && document.querySelector(`[data-ui-language="${preference}"]`)?.classList.contains('is-active');
        }, { timeout: 3000 }, { preference, language });
        const after = await page.evaluate(() => {
          const global = window as any;
          const view = global.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
          return { sameView: view === global.__languageView, sameDocument: view.state.doc === global.__languageDocument,
            selection: view.state.selection.toJSON(), top: view.scrollDOM.scrollTop };
        });
        assert.equal(after.sameView, true); assert.equal(after.sameDocument, true);
        assert.deepEqual(after.selection, before.selection); assert.ok(Math.abs(after.top - before.top) <= 1,
          'Host language changes preserve the actual document, selection and reading position');
      }
      await page.evaluate(() => { delete (window as any).__languageView; delete (window as any).__languageDocument; });
    }
    console.log('Host language settings update open ordinary/large Source views, explicit/automatic labels and preference controls without replacing document/view or reading state');
    if (process.argv.includes('--host-language-only')) { await closeTestBrowser(browser); process.exit(0); }
  }
  if (process.argv.includes('--latex-only')) {
    await page.exposeFunction('__renderLatexPreview', (request: { text: string; latexDelimiters?: boolean; uiLanguage: 'en' | 'zh-CN'; preset?: PreviewPresetId }) =>
      renderPreviewDocument({ markdownText: request.text, latexDelimiters: request.latexDelimiters, uiLanguage: request.uiLanguage, preset: request.preset, sourceDocumentPath: '' }));
    const sample = '# Math\n\n**Bold text**\n\nInline: \\( a+b \\)\n\n\\[\nx^2\n\\]\n\n| Formula | Note |\n| --- | --- |\n| \\(c+d\\) | plain |\n\n`\\(code\\)`\n\nOutside';
    const open = async () => { await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); };
    const switchSelector = '[data-setting="latexDelimiters"] [role="switch"]';
    const quickSwitchSelector = '.more-tools-panel [data-action="latexDelimiters"]';
    const showQuickMathHint = async (expected: string) => {
      const checked = await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked'));
      const info = `${quickSwitchSelector} .more-tools-option-info`;
      await page.mouse.move(0, 700);
      await page.hover(info);
      await page.waitForFunction(text => {
        const tooltip = document.querySelector('#latex-delimiters-tooltip.is-visible');
        return tooltip?.querySelector('.meo-tooltip-text')?.textContent === text && getComputedStyle(tooltip).opacity === '1';
      }, {}, expected);
      assert.equal(await page.$eval('#latex-delimiters-tooltip', tooltip => {
        const bounds = tooltip.getBoundingClientRect();
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight
          && tooltip.scrollWidth <= tooltip.clientWidth && tooltip.scrollHeight <= tooltip.clientHeight;
      }), true, 'the full math explanation fits the viewport without clipping');
      await page.click(info);
      assert.equal(await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked')), checked,
        'clicking the information icon does not toggle math syntax');
      assert.equal(await page.$eval('.more-tools-panel', node => (node as HTMLElement).hidden), false);
      await page.mouse.move(0, 700);
      await page.focus('.more-tools-panel [data-action="contentMaxWidth"]');
      await page.keyboard.press('Tab');
      await page.waitForFunction(text => document.querySelector('#latex-delimiters-tooltip.is-visible .meo-tooltip-text')?.textContent === text, {}, expected);
      assert.equal(await page.$eval(quickSwitchSelector, node => node === document.activeElement), true,
        'keyboard focus reaches the math switch and shows its explanation');
    };
    const mathCount = () => page.evaluate(() => {
      const h = (window as any).EditingSettingsHarness;
      const view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      return h.collectDocumentMathRanges(view.state).length;
    });
    for (const large of [false, true]) {
      const text = sample + (large ? '\n\nPlain paragraph.\n\n'.repeat(7000) : '');
      await openFixture(text, 'source', false, 'hidden', true);
      await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
      await page.waitForFunction(() => !(window as any).EditingSettingsHarness.syntaxParserRunning((window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'))));
      await page.evaluate(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ selection: { anchor: 2, head: 4 } });
        (window as any).__latexBefore = view.state.doc.toString();
      });
      assert.equal(await mathCount(), 0, 'new and reopened sessions default off');
      assert.equal(await page.$eval('html', node => node.classList.contains('meo-live-strong-coloring')), false,
        'a legacy enabled init preference cannot restore retired bold coloring');
      assert.equal(await page.$('[data-action="liveStrongColoring"]'), null);
      await page.click('.more-tools-wrapper > .format-button');
      assert.deepEqual(await page.$$eval('.more-tools-panel [role="menuitemcheckbox"]', nodes => nodes.map(node => (node as HTMLElement).dataset.action)),
        ['sourceLineNumbers', 'longCodeBlockFolding', 'contentMaxWidth', 'latexDelimiters']);
      assert.equal(await page.$eval('.more-tools-section-label', node => node.textContent), '快速设置');
      assert.equal(await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked')), 'false');
      await showQuickMathHint('开启后，将 \\(...\\) 识别为行内公式，将 \\[...\\] 识别为块级公式。');
      await page.click('.more-tools-wrapper > .format-button');
      await open();
      assert.equal(await page.$('[data-setting="strongColor"]'), null, 'full settings omit retired bold coloring');
      assert.equal(await page.$eval(switchSelector, e => e.getAttribute('aria-checked')), 'false');
      assert.equal(await page.$eval('[data-setting="latexDelimiters"] .settings-description', e => e.textContent),
        '开启后，将 \\(...\\) 识别为行内公式，将 \\[...\\] 识别为块级公式。');
      await page.click(switchSelector);
      assert.equal(await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked')), 'true', 'settings panel updates the quick switch');
      await page.waitForFunction(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        return h.collectDocumentMathRanges(view.state).length === 3;
      });
      assert.deepEqual(await page.evaluate(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        return { unchanged: view.state.doc.toString() === (window as any).__latexBefore,
          anchor: view.state.selection.main.anchor, head: view.state.selection.main.head,
          large: h.usesLargeDocumentDerivedWorkBudget(view.state) };
      }), { unchanged: true, anchor: 2, head: 4, large });
      assert(await page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'setLatexDelimiters' && m.enabled === true)));
      if (!large) for (const language of ['zh-CN', 'en']) for (const appearance of ['light', 'dark']) {
        await page.click('[data-tab="general"]');
        await page.click(`[data-setting="language"] [data-value="${language}"]`);
        await page.click('[data-tab="appearance"]'); await page.click(`[data-appearance-mode="${appearance}"]`);
        await page.click('[data-tab="general"]');
        await page.click('.settings-jump[data-section="math"]');
        await fs.mkdir('.local/latex-delimiters', { recursive: true });
        await page.screenshot({ path: `.local/latex-delimiters/settings-${language}-${appearance}.png` });
        assert.equal(await page.$eval('[data-setting="latexDelimiters"] .settings-item-title', e => e.textContent), language === 'zh-CN'
          ? 'LaTeX 风格公式定界符' : 'LaTeX math delimiters');
        assert.equal(await page.$eval('[data-setting="latexDelimiters"] .settings-description', e => e.textContent), language === 'zh-CN'
          ? '开启后，将 \\(...\\) 识别为行内公式，将 \\[...\\] 识别为块级公式。'
          : String.raw`When enabled, recognize \(...\) as inline math and \[...\] as display math.`);
        await page.click('.settings-close');
        await page.click('.more-tools-wrapper > .format-button');
        assert.equal(await page.$eval('.more-tools-section-label', node => node.textContent), language === 'zh-CN' ? '快速设置' : 'Quick settings');
        assert.equal(await page.$eval(`${quickSwitchSelector} .more-tools-option-label`, node => node.textContent), language === 'zh-CN' ? 'LaTeX 风格公式' : 'LaTeX math delimiters');
        assert.equal(await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked')), 'true');
        assert(await page.$eval(`${quickSwitchSelector} .more-tools-option-label`, node => node.scrollWidth <= node.clientWidth), 'quick switch label fits');
        await page.screenshot({ path: `.local/latex-delimiters/quick-settings-${language}-${appearance}.png` });
        const description = language === 'zh-CN'
          ? '开启后，将 \\(...\\) 识别为行内公式，将 \\[...\\] 识别为块级公式。'
          : String.raw`When enabled, recognize \(...\) as inline math and \[...\] as display math.`;
        for (const width of [1100, 430]) {
          await page.setViewport({ width, height: 780 });
          await showQuickMathHint(description);
          assert.equal(await page.$$eval('.more-tools-preferences-label, .more-tools-feedback-prompt', nodes =>
            nodes.every(node => node.scrollWidth <= node.clientWidth)), true,
            'the complete settings and feedback labels fit');
          await page.screenshot({ path: `.local/latex-delimiters/quick-hint-${language}-${appearance}-${width}.png` });
        }
        await page.setViewport({ width: 1100, height: 780 });
        await page.click('.more-tools-settings-button');
      }
      await page.click('.settings-close');
      await page.click('button[data-mode="live"]');
      await page.waitForSelector('.cm-editor.meo-mode-live .meo-md-math-inline');
      assert.equal(await page.$eval('.cm-editor.meo-mode-live .meo-md-strong', (node, darkForeground) => {
        const expected = document.createElement('span');
        expected.style.color = document.documentElement.dataset.editorAppearance === 'dark' ? darkForeground : 'inherit';
        node.parentElement!.append(expected);
        const matchesDefault = getComputedStyle(node).color === getComputedStyle(expected).color;
        expected.remove();
        return matchesDefault;
      }, darkDefaultLiveStrongForeground), true, 'a legacy preference retains the default uncolored bold appearance');
      assert.equal(await page.$$eval('tbody .meo-md-math-inline', nodes => nodes.length), 1, 'table formulas use the same syntax preference');
      await page.click('.more-tools-wrapper > .format-button'); await page.click(quickSwitchSelector);
      assert.equal(await page.$eval('.more-tools-panel', node => (node as HTMLElement).hidden), false, 'quick switch keeps the popover open');
      assert.equal(await page.$eval(quickSwitchSelector, node => node.getAttribute('aria-checked')), 'false');
      await page.click('.more-tools-wrapper > .format-button');
      await page.waitForFunction(() => !document.querySelector('tbody .meo-md-math-inline'));
      await page.click('.more-tools-wrapper > .format-button'); await page.click(quickSwitchSelector);
      await page.click('.more-tools-wrapper > .format-button');
      await page.waitForSelector('tbody .meo-md-math-inline');
      await page.click('button[data-mode="preview"]');
      await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.contentDocument?.querySelectorAll('.meo-export-math').length === 3));
      assert(await page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'requestPreviewRender' && m.latexDelimiters === true)));
      await open(); await page.click(switchSelector);
      await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.getBoundingClientRect().height > 0
        && frame.contentDocument?.querySelectorAll('.meo-export-math').length === 0));
      await page.click(switchSelector);
      await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.getBoundingClientRect().height > 0
        && frame.contentDocument?.querySelectorAll('.meo-export-math').length === 3));
      await page.click('.settings-close');
      if (!large) {
        const selectPreset = async (preset: string, mathCount: number) => {
          await page.select('.preview-preset-control select', preset);
          await page.waitForFunction(({ preset, mathCount }) => [...document.querySelectorAll('iframe')].some(frame =>
            frame.getBoundingClientRect().height > 0 && frame.contentDocument?.documentElement.dataset.meoPreviewPreset === preset
              && frame.contentDocument.querySelectorAll('.meo-export-math').length === mathCount), {}, { preset, mathCount });
        };
        await selectPreset('github-readme', 0);
        await page.click('.more-tools-wrapper > .format-button'); await page.click(quickSwitchSelector);
        await page.click('.more-tools-wrapper > .format-button');
        await selectPreset('default', 0);
        await page.click('.more-tools-wrapper > .format-button'); await page.click(quickSwitchSelector);
        await page.click('.more-tools-wrapper > .format-button');
        await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.getBoundingClientRect().height > 0
          && frame.contentDocument?.querySelectorAll('.meo-export-math').length === 3));
        await selectPreset('github-readme', 0);
        await selectPreset('default', 3);
      }
      await page.click('button[data-mode="source"]');
      await page.waitForSelector('.cm-editor.meo-mode-source');
      await open(); await page.click(switchSelector);
      await page.waitForFunction(() => {
        const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        return !view.state.facet(h.latexDelimitersFacet) && h.collectDocumentMathRanges(view.state).length === 0;
      });
      await page.click('.settings-close');
      assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()), text);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'latexDelimitersChanged', enabled: true } })));
      await page.waitForFunction(() => {
        const h = (window as any).EditingSettingsHarness;
        return h.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.facet(h.latexDelimitersFacet);
      });
      if (large) {
        await page.evaluate(() => {
          const h = (window as any).EditingSettingsHarness, view = h.EditorView.findFromDOM(document.querySelector('.cm-editor'));
          view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'latexDelimitersChanged', enabled: false } }));
          view.focus();
        });
        await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
        await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === text, {}, text);
        await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
        await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === text + '!', {}, text);
      }
    }
    assert.deepEqual(errors, []);
    console.log('LaTeX settings switch: visible bilingual UI, off/on, normal/worker paths, Source/Live/table/Preview, external updates and unchanged source passed');
    await closeTestBrowser(browser); process.exit(0);
  } else if (process.argv.includes('--extras-only')) {
    const tabs = ['general', 'appearance', 'typing', 'presets', 'shortcuts', 'about'];
    for (const text of ['# Notes\n\nUnchanged content', '# Notes\n\n' + 'Document paragraph.\n\n'.repeat(7000)]) {
      await openFixture(text);
      await page.waitForFunction(() => !!document.querySelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content')
        && !document.querySelector<HTMLElement>('.editor-host')!.inert && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);
      const open = async () => { await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); };
      await open();
      const visibleTabs = () => page.$$eval('.settings-tab', nodes => nodes.map(node => (node as HTMLElement).dataset.tab));
      assert.deepEqual(await visibleTabs(), tabs, 'Only the six published settings tabs are exposed');
      for (const state of [{ installed: false, version: '', features: [] }, { installed: true, version: '0.1.0', features: [] },
        { installed: true, version: '0.1.0', features: [{ id: 'mindmap', label: 'Mind map', description: 'Document mind maps.', enabled: true, active: true, failed: false }] }]) {
        await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'extensionFeaturesChanged', state } })), state);
        assert.deepEqual(await visibleTabs(), tabs, 'Extras availability must not reveal its unpublished tab');
        assert.equal(await page.$('#meo-settings-extras'), null);
      }
      await page.focus('[data-tab="shortcuts"]'); await page.keyboard.press('ArrowRight');
      assert.equal(await page.$eval('.settings-window', e => (e as HTMLElement).dataset.tab), 'about', 'Keyboard navigation skips Extras');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.$eval('.settings-window', e => (e as HTMLElement).dataset.tab), 'general');
      for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
        await page.click('[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`);
        await page.click('[data-tab="appearance"]'); await page.click(`[data-appearance-mode="${appearance}"]`);
        assert.deepEqual(await visibleTabs(), tabs);
        await page.focus('.settings-search'); await page.keyboard.type('MEO Extras');
        assert.equal(await page.$('[data-tab="extensions"]'), null);
        assert.equal(await page.$('#meo-settings-extras'), null);
        assert.ok((await page.$$eval('.settings-tab-badge', nodes => nodes.map(node => node.textContent))).every(count => count === '0'),
          'Search must not count unpublished Extras settings');
        await page.click('.settings-search-clear');
        await page.setViewport({ width: 640, height: 640 });
        assert.equal(await page.$eval('.settings-content', e => e.scrollWidth <= e.clientWidth + 1), true);
        if (process.env.MEO_SETTINGS_SCREENSHOTS) {
          const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, `extras-hidden-${language}-${appearance}.png`) });
        }
        await page.setViewport({ width: 1100, height: 780 });
      }
      assert.equal(await page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'extensionFeaturesRequest')), false,
        'Opening settings must not request the unpublished panel');
      await page.click('.settings-close'); await open();
      assert.deepEqual(await visibleTabs(), tabs, 'Reopening settings retains the published navigation');
      await page.click('.settings-close');
      assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()), text);
    }
    assert.deepEqual(errors, []);
    console.log('PASS unpublished Extras hidden: states, search, keyboard, bilingual themes, narrow UI and unchanged ordinary/large documents');
    await closeTestBrowser(browser); process.exit(0);
  }
  // Use the real outline controller: its position is owned by the wrapper,
  // and floating outlines overlap the editor rather than reserving a column.
  for (const mode of ['source', 'live'] as const) for (const outline of ['left', 'right', 'hidden'] as const) for (const floating of outline === 'hidden' ? [false] : [false, true]) {
    const label = `${mode}/${outline}/${floating ? 'floating' : 'fixed'}`;
    await openFixture('', mode, false, outline);
    await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);

    if (floating) await page.click('.outline-header-button[data-action="toggle-mode"]');
    await page.evaluate(() => {
      const g = window as any;
      g.__preferences.input.emoji = true;
      g.__linkCandidates = [{ label: 'note.md', insert: 'note', detail: 'note.md' }];
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
    });
    // A floating left outline covers the start of each line. Keep the input
    // anchor in visible prose so this exercises placement, not occlusion.
    const prefix = floating ? 'Visible text '.repeat(4) : '';
    for (const [name, before, after, typed, expected] of [
      ['slash', prefix, '', floating ? '/bold' : '/h1', floating ? prefix + '****' : '# '],
      ['emoji', prefix, '', ':smile', prefix + '😄'],
      ['wiki', prefix + '[[', ']]', 'no', prefix + '[[note]]'],
      ['path', prefix + '[File](', ')', 'no', prefix + '[File](note)'],
      ['heading', '# Target\n\n' + prefix + '[Go](#', ')', 'ta', '# Target\n\n' + prefix + '[Go](#target)']
    ]) {
      await page.evaluate(({ before, after }) => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: before + after }, selection: { anchor: before.length }, scrollIntoView: true });
        view.focus();
      }, { before, after });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.keyboard.type(typed);
      await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 2000 });
      const bounds = await page.evaluate(() => {
        const popup = document.querySelector('.meo-input-suggestions')!.getBoundingClientRect();
        const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
        const sidebar = document.querySelector('.outline-sidebar')!.getBoundingClientRect();
        return { popup: popup.toJSON(), scroller: scroller.toJSON(), sidebar: sidebar.toJSON() };
      });
      assert.ok(bounds.popup.left >= bounds.scroller.left && bounds.popup.right <= bounds.scroller.right, `${label}/${name}: menu stays inside the editor`);
      if (outline === 'left') assert.ok(bounds.popup.left >= bounds.sidebar.right, `${label}/${name}: menu clears the left outline`);
      if (outline === 'right') assert.ok(bounds.popup.right <= bounds.sidebar.left, `${label}/${name}: menu clears the right outline`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(expected => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === expected, { timeout: 2000 }, expected);
    }
    if (mode === 'live') {
      await page.evaluate(prefix => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '| A |\n| --- |\n| ' + prefix + ' |' }, selection: { anchor: 0 }, scrollIntoView: true });
      }, prefix);
      await page.waitForSelector('tbody textarea');
      await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
      await page.keyboard.type('/bold');
      await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 2000 });
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), prefix.trimEnd() + '****', label + ': native table slash command executes');
    }
  }
  await openFixture();
  await page.waitForSelector('.cm-editor');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  const closeSettings = async (method: 'button' | 'backdrop' | 'escape') => {
    if (method === 'button') await page.click('.settings-close');
    else if (method === 'escape') await page.keyboard.press('Escape');
    else {
      const point = await page.$eval('.settings-window', element => { const bounds = element.getBoundingClientRect(); return { x: Math.max(1, bounds.left - 4), y: bounds.top + 30 }; });
      await page.mouse.click(point.x, point.y);
    }
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('.settings-window')!.open);
  };
  for (const mode of ['source', 'live']) {
    await page.click(`button[data-mode="${mode}"]`);
    await page.waitForSelector(`.cm-editor.meo-mode-${mode}`);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false
      && !document.querySelector('.mode-group [aria-busy="true"]'));
    for (const method of ['button', 'backdrop', 'escape'] as const) {
      for (const [anchor, head] of [[2, 2], [1, 4], [4, 1]]) {
        const before = await page.evaluate(({ anchor, head }) => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
          view.dispatch({ selection: { anchor, head } }); view.focus();
          return { text: view.state.doc.toString(), scroll: view.scrollDOM.scrollTop, focus: view.hasFocus };
        }, { anchor, head });
        assert.equal(before.focus, true, `${mode}/${method}: settings starts from an interactive focused editor`);
        await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
        await closeSettings(method);
        const restored = await page.evaluate(() => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
          return { focus: view.hasFocus, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop };
        });
        assert.equal(restored.focus, true, `${mode}/${method}: closing settings restores editor focus immediately`);
        assert.deepEqual([restored.anchor, restored.head], [anchor, head], `${mode}/${method}: closing settings preserves the caret and selection direction`);
        assert.ok(Math.abs(restored.scroll - before.scroll) <= 1, `${mode}/${method}: closing settings preserves the document viewport`);
        await page.keyboard.type('Z');
        const expected = before.text.slice(0, Math.min(anchor, head)) + 'Z' + before.text.slice(Math.max(anchor, head));
        await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === text, { timeout: 2000 }, expected);
        assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()), expected, `${mode}/${method}: typing resumes at the original selection without another click`);
        await chord('z');
        await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === text, {}, before.text);
      }
    }
  }
  await page.click('button[data-mode="source"]');
  await page.waitForSelector('.cm-editor.meo-mode-source');
  await page.click('.more-tools-wrapper > .format-button');
  assert.equal(await page.$eval('.more-tools-panel', element => element.getBoundingClientRect().width), 288);
  assert.equal(await page.$$eval('.more-tools-panel .more-tools-option', elements => elements.length), 7);
  assert.deepEqual(await page.$$eval('.more-tools-panel [role="menuitemcheckbox"]', elements => elements.map(element => (element as HTMLElement).dataset.action)), ['sourceLineNumbers', 'longCodeBlockFolding', 'contentMaxWidth', 'latexDelimiters']);
  assert.deepEqual(await page.$$eval('.more-tools-panel .more-tools-section-label', elements => elements.map(element => element.textContent)), ['快速设置', '全部设置', '反馈与支持']);
  assert.equal(await page.$eval('.more-tools-sponsor-button', element => element.previousElementSibling?.classList.contains('more-tools-feedback-link')), true);
  await page.evaluate(() => { (window as any).__failNextEnvironment = true; });
  await page.click('.more-tools-sponsor-button');
  await page.waitForSelector('.settings-window[open][data-tab="about"]');
  await page.waitForSelector('.settings-about-retry:not([hidden])');
  assert.equal(await page.$eval('.settings-about-copy', element => (element as HTMLButtonElement).disabled), true);
  await page.click('.settings-about-retry');
  await page.waitForSelector('.settings-about-copy:not([disabled])');
  assert.equal(await page.$eval('.settings-about-retry', element => getComputedStyle(element).display), 'none');
  assert.match(await page.$eval('.settings-about-versions', element => element.textContent!), /1\.140\.0.*Windows 11.*26200.*x64/s);
  assert.equal(await page.$eval('.settings-about-logo', element => (element as HTMLImageElement).naturalWidth > 0), true);
  assert.equal(await page.$eval('.settings-about-copy', element => element.textContent), '', 'Copy is an icon-only action');
  assert.deepEqual(await page.$eval('.settings-about-copy', element => [element.getBoundingClientRect().width, element.getBoundingClientRect().height]), [28, 28]);
  assert.deepEqual(await page.$$eval('.settings-about-payment-icon', elements => elements.map(element => (element as HTMLElement).dataset.paymentMethod)), ['alipay', 'wechat', 'paypal', 'visa', 'mastercard']);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.settings-about-payment-icon img')].length === 5 && [...document.querySelectorAll<HTMLImageElement>('.settings-about-payment-icon img')].every(image => image.complete && image.naturalWidth > 0));
  await page.hover('.settings-about-copy');
  await page.waitForFunction(() => document.querySelector('.meo-tooltip.is-visible')?.textContent === '复制版本信息');
  for (const selector of ['.settings-about-platform[href*="afdian"]', '.settings-about-platform[href*="ko-fi"]', ...['alipay', 'wechat', 'paypal', 'visa', 'mastercard'].map(method => `[data-payment-method="${method}"] img`)]) {
    await page.hover(selector);
    // Observe past the shared tooltip's 200ms reveal delay, including dismissal
    // of the copy hint when entering a sponsor card.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.$('.meo-tooltip.is-visible'), null, `${selector}: sponsor cards have no hover hint`);
  }
  await page.hover('.settings-about-runtime .settings-about-section-title');
  assert.equal(await page.$eval('.settings-about-page', element => /1 个月|one month/.test(element.textContent!)), false);
  assert.equal(await page.evaluate(() => {
    const surfaces = [...document.querySelectorAll('.settings-about-runtime, .settings-about-platform')].map(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.borderColor, style.borderRadius].join('|'); });
    return surfaces.every(surface => surface === surfaces[0]);
  }), true, 'Version and sponsor cards share their surface, border and radius');
  assert.equal(await page.$eval('.more-tools-panel', element => (element as HTMLElement).hidden), true);
  assert.equal(await page.$eval('.settings-tab:last-child .settings-tab-label', element => element.textContent), '关于');
  for (const href of ['https://github.com/huangko555/meo-enhanced', 'https://github.com/huangko555/meo-enhanced/issues/new', 'https://afdian.com/a/meoenhanced', 'https://ko-fi.com/meoenhanced']) {
    await page.locator(`.settings-about-link[href="${href}"]`).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__messages.at(-1)), { type: 'openLink', href });
    assert.equal(await page.$eval('.settings-window', element => (element as HTMLDialogElement).open), true, 'External links retain the About page');
  }
  await page.evaluate(() => { (window as any).__failNextClipboardWrite = true; });
  await page.click('.settings-about-copy');
  await page.waitForSelector('.settings-about-status.is-error:not([hidden])');
  await page.click('.settings-about-copy');
  await page.waitForFunction(() => document.querySelector('.settings-about-copy')?.getAttribute('aria-label') === '已复制');
  assert.equal(await page.evaluate(() => (window as any).__clipboard), `MEO Enhanced: ${productVersion}\nVisual Studio Code: 1.140.0\nOS: Windows 11 (10.0.26200) (x64)`);
  await page.evaluate(() => { (window as any).__holdNextClipboardWrite = true; });
  await page.click('.settings-about-copy');
  assert.equal(await page.$eval('.settings-about-copy', element => (element as HTMLButtonElement).disabled), false, 'Pending copy retains its focus and visual state');
  assert.equal(await page.$eval('.settings-about-copy', element => element.getAttribute('aria-busy')), 'true');
  await closeSettings('escape');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-sponsor-button');
  await page.evaluate(() => { (window as any).__flushClipboardWrite(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.$eval('.settings-about-copy', element => element.getAttribute('aria-label')), '复制版本信息', 'Late clipboard completion cannot update a reopened About page');
  await page.type('.settings-search', 'Alipay');
  assert.equal(await page.$$eval('.settings-about-link', elements => elements.length), 1);
  assert.equal(await page.$eval('.settings-about-link', element => (element as HTMLAnchorElement).href), 'https://afdian.com/a/meoenhanced');
  await page.click('.settings-search-clear');
  await page.click('.settings-tab[data-tab="general"]');
  await closeSettings('escape');
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.more-tools-settings-button');
  await page.click('.settings-tab[data-tab="about"]');
  assert.equal(await page.$eval('.settings-about-copy', element => element.getAttribute('aria-label')), '复制版本信息', 'Reopening retires prior clipboard feedback');
  await page.click('.settings-tab[data-tab="general"]');
  assert.equal(await page.$eval('.settings-window', element => (element as HTMLDialogElement).open), true);
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 10);
  for (const [setting, type] of [['boldHeadings', 'setBoldHeadings'], ['stickyHeader', 'setTableStickyHeader']]) {
    const toggle = `[data-setting="${setting}"] .settings-switch`;
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'true');
    await page.locator(toggle).click();
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'false');
    assert.deepEqual(await page.evaluate(type => (window as any).__messages.filter((message: any) => message.type === type).at(-1), type), { type, enabled: false });
    await page.locator(toggle).click();
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'true');
  }
  assert.equal(await page.$eval('.settings-footer', element => (element as HTMLElement).hidden), true);
  const height = await page.$eval('.settings-window', element => element.getBoundingClientRect().height);
  assert.equal(await page.$('[data-setting="fontSize"]'), null, 'font size moves out of General');
  await page.click('[data-tab="appearance"]');
  await page.click('.settings-jump[data-section="appearanceTypography"]');
  const fontStepper = '.settings-item[data-setting="fontSize"] .editor-font-size-stepper';
  await page.click('[data-setting="fontSize"] [data-value="auto"]');
  assert.equal(await page.$eval(fontStepper, element => element.getAttribute('aria-disabled')), 'true');
  assert.equal(await page.$$eval(fontStepper + ' button', elements => elements.every(element => (element as HTMLButtonElement).disabled)), true);
  assert.ok(await page.$eval(fontStepper, element => Number(getComputedStyle(element).opacity) < 1), 'automatic font size visibly disables the whole stepper');
  assert.ok(await page.$$eval(fontStepper + ' button', elements => elements.every(element => {
    const button = element.getBoundingClientRect(), icon = element.querySelector('svg')!.getBoundingClientRect();
    return Math.abs(icon.top + icon.height / 2 - button.top - button.height / 2) <= .5;
  })), 'font adjustment icons are vertically centered');
  await page.click('[data-setting="fontSize"] [data-value="custom"]');
  assert.equal(await page.$eval(fontStepper, element => element.getAttribute('aria-disabled')), 'false');
  const fontValue = await page.$eval(fontStepper + ' output', element => Number(element.textContent));
  await page.click(fontStepper + ' button:last-child');
  assert.equal(await page.$eval(fontStepper + ' output', element => Number(element.textContent)), fontValue + 1);
  await page.click('[data-setting="fontSize"] [data-value="auto"]');
  assert.equal(await page.$eval(fontStepper + ' output', element => Number(element.textContent)), fontValue + 1, 'automatic mode preserves the last custom size');
  const lineSpacing = '[data-setting="lineHeight"] .editor-font-size-stepper';
  assert.ok(await page.$eval(lineSpacing, stepper => {
    const outer = stepper.getBoundingClientRect();
    const parts = [...stepper.children].map(child => child.getBoundingClientRect());
    return parts.every(rect => rect.left >= outer.left && rect.right <= outer.right)
      && parts.every((rect, index) => index === 0 || rect.left >= parts[index - 1]!.right);
  }), 'line spacing buttons and value fit without clipping or overlap');
  assert.equal(await page.$eval(lineSpacing + ' output', el => el.textContent), '1.5 倍');
  await page.click(lineSpacing + ' button:last-child');
  assert.equal(await page.$eval(lineSpacing + ' output', el => el.textContent), '1.6 倍');
  assert.equal(await page.$eval('.cm-line', el => { const style = getComputedStyle(el); return Math.round(parseFloat(style.lineHeight) / parseFloat(style.fontSize) * 10) / 10; }), 1.6, 'Source line geometry follows the setting');
  assert.ok(await page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'setEditorLineHeight' && m.value === 1.6)));
  await page.click('[data-setting="lineHeight"] .appearance-typography-reset');
  assert.equal(await page.$eval(lineSpacing + ' output', el => el.textContent), '1.5 倍');
  await page.click('.settings-tab[data-tab="typing"]');
  const typingSettingCount = Object.keys(defaultInputAssistance).length + 1; // Includes image storage.
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), typingSettingCount);
  const pasteOptionsSwitch = '[data-setting="showPasteOptions"] [role="switch"]';
  assert.equal(await page.$eval(pasteOptionsSwitch, e => e.getAttribute('aria-label')), '显示粘贴选项');
  assert.equal(await page.$eval(pasteOptionsSwitch, e => e.getAttribute('aria-checked')), 'true');
  assert.equal(await page.$eval('[data-setting="pasteHtml"] [role="switch"]', e => e.getAttribute('aria-checked')), 'true');
  await page.click(pasteOptionsSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.showPasteOptions === false);
  assert.deepEqual(await page.evaluate(() => {
    const input = (window as any).__preferences.input;
    return [input.pasteHtml, input.convertTables, input.pasteUrl];
  }), [true, true, true], 'the menu switch does not change the default conversion choices');
  await page.click(pasteOptionsSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.showPasteOptions === true);
  const slashSwitch = '[data-setting="slash"] [role="switch"]';
  const slashAboveSwitch = '[data-setting="slashPreferAbove"] [role="switch"]';
  assert.equal(await page.$eval(slashAboveSwitch, e => e.getAttribute('aria-label')), '候选菜单优先在上方显示');
  assert.equal(await page.$eval('[data-setting="slashPreferAbove"] .settings-description', e => e.textContent), '斜杠、路径、表情、公式和 HTML 菜单优先显示在输入行上方，推荐输入法用户开启。');
  assert.deepEqual(await page.$$eval('.settings-item[data-setting]', items => items.map(item => (item as HTMLElement).dataset.setting).filter(key => ['documentSuggestions', 'slash', 'emoji', 'math', 'html', 'slashPreferAbove'].includes(key!))), ['documentSuggestions', 'slash', 'emoji', 'math', 'html', 'slashPreferAbove'], 'shared placement follows all menu enable switches');
  const htmlSwitch = '[data-setting="html"] [role="switch"]';
  assert.equal(await page.$eval(htmlSwitch, e => e.getAttribute('aria-checked')), 'true');
  await page.click(htmlSwitch); await page.waitForFunction(() => (window as any).__preferences.input.html === false);
  await page.click(htmlSwitch); await page.waitForFunction(() => (window as any).__preferences.input.html === true);
  const mathSwitch = '[data-setting="math"] [role="switch"]';
  assert.equal(await page.$eval(mathSwitch, e => e.getAttribute('aria-checked')), 'true');
  await page.click(mathSwitch); await page.waitForFunction(() => (window as any).__preferences.input.math === false);
  await page.click(mathSwitch); await page.waitForFunction(() => (window as any).__preferences.input.math === true);
  await page.click(slashAboveSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.slashPreferAbove === true);
  await page.click(slashSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.slash === false);
  assert.equal(await page.$eval(slashAboveSwitch, e => (e as HTMLButtonElement).disabled), false, 'shared placement remains editable when slash commands are disabled');
  assert.equal(await page.$eval(slashAboveSwitch, e => e.getAttribute('aria-checked')), 'true', 'disabling slash commands retains the above-menu preference');
  await page.click(slashSwitch);
  await page.waitForFunction(() => !(document.querySelector('[data-setting="slashPreferAbove"] [role="switch"]') as HTMLButtonElement)?.disabled);
  await page.click(slashAboveSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.slashPreferAbove === false);
  assert.deepEqual(await page.$$eval('.settings-paste-contexts dt', elements => elements.map(e => e.textContent)), ['正文', '已有表格', '代码']);
  assert.ok(await page.$eval('.settings-paste-contexts dd:nth-of-type(2)', e => e.textContent?.includes('不受这个开关影响')));
  const wrap = '.settings-item[data-setting="wrapSelection"]';
  for (const pair of ['<>', '*', '_', '~', '$', '``']) assert.ok(await page.$eval(wrap + ' .settings-description', (element, pair) => element.textContent?.includes(pair), pair), 'wrapping description includes ' + pair);
  await page.click(wrap + ' .settings-item-title');
  assert.equal(await page.$eval(wrap + ' [role="switch"]', element => element.getAttribute('aria-checked')), 'true');
  await page.click(wrap + ' [role="switch"]');
  await page.waitForFunction(() => (window as any).__preferences.input.wrapSelection === false);
  await page.waitForFunction(() => document.querySelector('[data-setting="wrapSelection"] [role="switch"]')?.getAttribute('aria-checked') === 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'switch');
  await page.evaluate(() => { (window as any).__failNextUpdate = true; });
  await page.click(wrap + ' [role="switch"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.settings-status')?.hidden);
  assert.equal(await page.$eval(wrap + ' [role="switch"]', e => e.getAttribute('aria-checked')), 'false', 'a failed write preserves the authoritative value');
  assert.equal(await page.$eval(wrap + ' [role="switch"]', e => (e as HTMLButtonElement).disabled), false, 'failed controls become retryable');
  await page.evaluate(() => { (window as any).__holdNextUpdate = true; });
  await page.click(wrap + ' [role="switch"]');
  await page.waitForFunction(() => typeof (window as any).__flushUpdate === 'function');
  assert.equal(await page.$eval(wrap + ' [role="switch"]', e => (e as HTMLButtonElement).disabled), true, 'pending writes prevent duplicate operations');
  await page.evaluate(() => { (window as any).__flushUpdate(); });
  await page.waitForFunction(() => document.querySelector('[data-setting="wrapSelection"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.$eval('.settings-status', e => (e as HTMLElement).hidden), true);
  await page.click(wrap + ' [role="switch"]');
  await page.waitForFunction(() => document.querySelector('[data-setting="wrapSelection"] [role="switch"]')?.getAttribute('aria-checked') === 'false');

  const toolbarSwitch = '[data-setting="selectionToolbar"] [role="switch"]';
  assert.equal(await page.$eval(toolbarSwitch, e => e.getAttribute('aria-checked')), 'true');
  await page.evaluate(() => { (window as any).__failNextUpdate = true; });
  await page.click(toolbarSwitch);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.settings-status')?.hidden);
  assert.equal(await page.$eval(toolbarSwitch, e => e.getAttribute('aria-checked')), 'true', 'a failed toolbar write preserves the enabled value');
  await page.click(toolbarSwitch);
  await page.waitForFunction(() => (window as any).__preferences.input.selectionToolbar === false);
  await page.click('.settings-close');
  const toolbarVisible = () => page.$eval('.selection-inline-menu', e => e.classList.contains('is-visible'));
  const setToolbar = async (enabled: boolean) => page.evaluate(enabled => {
    const g = window as any;
    g.__preferences = { ...g.__preferences, input: { ...g.__preferences.input, selectionToolbar: enabled } };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
  }, enabled);
  const settleSelection = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const mode of ['source', 'live']) {
    await page.click(`button[data-mode="${mode}"]`);
    await page.waitForSelector(`.cm-editor.meo-mode-${mode}`);
    for (const backward of [false, true]) {
      const points = await page.evaluate(backward => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ selection: { anchor: 0 } }); view.focus();
        const from = view.coordsAtPos(0), to = view.coordsAtPos(5);
        const start = { x: from.left + 1, y: (from.top + from.bottom) / 2 };
        const end = { x: to.left - 1, y: (to.top + to.bottom) / 2 };
        return backward ? [end, start] : [start, end];
      }, backward);
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 4 }); await page.mouse.up();
      await settleSelection();
      assert.equal(await page.evaluate(() => { const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); }), 'hello');
      assert.equal(await toolbarVisible(), false, `${mode}: disabled toolbar stays hidden after dragging`);
      assert.equal(await page.$eval('.selection-inline-menu', e => getComputedStyle(e).pointerEvents), 'none');
      await setToolbar(true);
      await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible'));
      await setToolbar(false);
      assert.equal(await toolbarVisible(), false, `${mode}: disabling hides an already visible toolbar immediately`);
      // An older configuration snapshot cannot restore a disabled toolbar.
      await page.evaluate(() => {
        const g = window as any;
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: { ...g.__preferences, input: { ...g.__preferences.input, selectionToolbar: true } }, revision: g.__revision - 1 } }));
      });
      await settleSelection(); assert.equal(await toolbarVisible(), false);
    }
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.selection-inline-button[data-action="bold"]')!.click());
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.line(1).text), 'hello', 'a stale toolbar action is ignored after disabling');
    await chord('b');
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.line(1).text), '**hello**', 'format shortcuts still work with the selection toolbar disabled');
    await chord('z');
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.line(1).text), 'hello');
  }
  for (const mode of ['source', 'live']) {
    const initial = await page.evaluate(mode => { const g = window as any; return { ...g.__initMessage, mode, editingPreferences: g.__preferences, editingPreferencesRevision: g.__revision }; }, mode);
    const reopened = await browser.newPage();
    try {
      await reopened.setViewport({ width: 1100, height: 780 });
      await reopened.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await reopened.addStyleTag({ path: 'webview/src/styles.css' });
      await reopened.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(){}});' });
      await reopened.addScriptTag({ content: await build.outputs[0].text() });
      await reopened.evaluate(initial => window.dispatchEvent(new MessageEvent('message', { data: initial })), initial);
      await reopened.waitForSelector(`.cm-editor.meo-mode-${mode}`);
      await reopened.evaluate(async () => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ selection: { anchor: 0, head: 5 } }); view.focus();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      assert.equal(await reopened.$eval('.selection-inline-menu', e => e.classList.contains('is-visible')), false, `${mode}: a reopened document honors the saved disabled preference`);
    } finally { await reopened.close(); }
  }
  await setToolbar(true);
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  await page.click('.settings-tab[data-tab="typing"]');
  assert.equal(await page.$eval(toolbarSwitch, e => e.getAttribute('aria-checked')), 'true');
  await page.click('.settings-search'); await page.keyboard.type('选区工具栏');
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 1);
  assert.equal(await page.$eval(toolbarSwitch, e => e.getAttribute('aria-checked')), 'true');
  await page.click('.settings-search-clear');

  // Exercise the production settings control with the same Host path resolver as clipboard writes.
  await page.click('.settings-tab[data-tab="typing"]');
  await page.click('.settings-search'); await page.keyboard.type('图片');
  await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#meo-image-folder') && !document.querySelector<HTMLInputElement>('#meo-image-folder')!.disabled);
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 1);
  assert.equal(await page.$eval('.image-location-prefix', element => element.textContent), './');
  assert.equal(await page.$eval('.image-location-prefix', element => element.tagName), 'SPAN');
  assert.equal(imageContext.imageStorage, undefined, 'opening the settings does not migrate defaults');
  const fillImage = async (selector: string, value: string) => {
    await page.$eval(selector, (element, value) => {
      (element as HTMLInputElement).value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  };
  const waitImageSaved = async () => { await page.waitForFunction(() => document.querySelector('.image-location-feedback')?.textContent === '已自动保存'); };
  assert.equal(await page.$eval('.image-naming-modes input:checked', element => (element as HTMLInputElement).value), 'documentSequence');
  for (const naming of ['dateTime', 'imageSequence', 'timestamp', 'documentSequence']) {
    await page.click('.image-naming-modes input[value="' + naming + '"]'); await waitImageSaved();
    assert.equal(imageContext.imageStorage?.naming, naming);
    if (naming === 'documentSequence') assert.ok((await page.$eval('.image-naming-preview dd', element => element.textContent))?.endsWith('draft-1.png'));
  }
  await page.click('.image-location-modes input[value="perDocument"]'); await waitImageSaved();
  assert.equal(await page.$eval('.image-location-suffix', element => element.textContent), '/draft');
  await page.focus('#meo-image-folder');
  await fillImage('#meo-image-folder', 'images/screenshots'); await waitImageSaved();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'meo-image-folder', 'autosave keeps the active folder input focused');
  assert.equal(imageContext.imageStorage?.folder, 'images/screenshots');
  assert.equal(await page.$eval('.image-location-preview dd:last-child', element => element.textContent), path.join(os.tmpdir(), 'meo-image-notes', 'images', 'screenshots', 'draft'));
  const beforeComposition = imageContext.imageStorage!.folder;
  await page.$eval('#meo-image-folder', element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    (element as HTMLInputElement).value = '图片';
    element.dispatchEvent(new InputEvent('input', {bubbles: true, isComposing: true}));
  });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  assert.equal(imageContext.imageStorage!.folder, beforeComposition, 'IME preedit is not saved');
  assert.equal(await page.$eval('#meo-image-folder', element => (element as HTMLInputElement).value), '图片');
  await page.$eval('#meo-image-folder', element => element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})));
  await waitImageSaved(); assert.equal(imageContext.imageStorage!.folder, '图片');
  await page.click('.image-location-modes input[value="default"]'); await waitImageSaved();
  assert.equal(await page.$eval('#meo-image-folder', element => (element as HTMLInputElement).value), '图片');
  await page.focus('.image-location-modes input[value="default"]');
  await page.keyboard.press('ArrowDown'); await waitImageSaved();
  assert.equal(imageContext.imageStorage!.mode, 'perDocument', 'native radio keyboard navigation selects the next mode');
  assert.equal(await page.$eval('#meo-image-folder', element => (element as HTMLInputElement).value), '图片', 'moving the folder controls preserves the draft');
  await page.click('.image-location-modes input[value="advanced"]'); await waitImageSaved();
  await fillImage('#meo-image-rule', '${fileDirname}/assets'); await waitImageSaved();
  await page.$eval('#meo-image-rule', element => {
    const input = element as HTMLInputElement, start = input.value.indexOf('assets');
    input.focus(); input.setSelectionRange(start, start + 'assets'.length);
  });
  await page.click('.image-location-variables > button:nth-child(3)'); await waitImageSaved();
  assert.equal(await page.$eval('#meo-image-rule', element => (element as HTMLInputElement).value), '${fileDirname}/${fileBasenameNoExtension}', 'clicking a described variable replaces the selected path segment with only its token');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'meo-image-rule');
  const previousRule = imageContext.imageStorage!.rule;
  await fillImage('#meo-image-rule', '${unknown}/images');
  await page.waitForSelector('.image-location-feedback.is-error');
  assert.equal(imageContext.imageStorage!.rule, previousRule, 'invalid rules retain the last valid config');
  assert.equal(await page.$eval('#meo-image-rule', element => (element as HTMLInputElement).value), '${unknown}/images');
  await fillImage('#meo-image-rule', '${fileDirname}/pictures/${fileBasenameNoExtension}'); await waitImageSaved();
  assert.equal(await page.$eval('.image-location-preview dd:last-child', element => element.textContent), path.join(os.tmpdir(), 'meo-image-notes', 'pictures', 'draft'));
  // A late preview response must not replace a newer input or resolved directory.
  await page.evaluate(() => { (window as any).__holdImageReply = true; });
  await fillImage('#meo-image-rule', '${fileDirname}/old');
  await page.waitForFunction(() => typeof (window as any).__releaseImageReply === 'function');
  await fillImage('#meo-image-rule', '${fileDirname}/latest'); await waitImageSaved();
  await page.evaluate(() => { (window as any).__releaseImageReply(); });
  assert.equal(await page.$eval('#meo-image-rule', element => (element as HTMLInputElement).value), '${fileDirname}/latest');
  assert.equal(await page.$eval('.image-location-preview dd:last-child', element => element.textContent), path.join(os.tmpdir(), 'meo-image-notes', 'latest'));
  imageWriteFailure = true;
  await fillImage('#meo-image-rule', '${fileDirname}/retry');
  await page.waitForSelector('.image-location-feedback.is-error');
  assert.equal(imageContext.imageStorage!.rule, '${fileDirname}/latest');
  imageWriteFailure = false;
  await page.click('.image-location-retry'); await waitImageSaved();
  imageChosenFolder = null;
  const beforePicker = imageContext.imageStorage!.rule;
  await page.click('.image-location-picker');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.image-location-picker')?.disabled);
  assert.equal(imageContext.imageStorage!.rule, beforePicker);
  imageChosenFolder = path.join(os.tmpdir(), 'selected-image-folder');
  await page.click('.image-location-picker');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#meo-image-rule')?.value.includes('selected-image-folder'));
  await waitImageSaved();
  assert.equal(imageContext.imageStorage!.rule, imageChosenFolder);
  // Closing during the debounce sends the final valid draft without an Apply button.
  await fillImage('#meo-image-rule', '${fileDirname}/closed');
  await page.click('.settings-close');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#meo-image-rule')?.value === '${fileDirname}/closed' && document.querySelector('.image-location-preview dd:last-child')?.textContent?.endsWith('closed'));
  assert.equal(imageContext.imageStorage!.rule, '${fileDirname}/closed');
  imageContext = { documentFsPath: null, imageStorage: imageContext.imageStorage };
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'imageStorageChanged'}})));
  await page.waitForFunction(() => document.querySelector('.image-location-preview dd:last-child')?.textContent === '先保存文档，再粘贴图片。');
  imageContext = { ...imageContext, documentFsPath: path.join(os.tmpdir(), 'meo-image-notes', 'renamed.md') };
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'imageStorageChanged'}})));
  await page.waitForFunction(() => document.querySelector('.image-location-preview dd:first-of-type')?.textContent?.includes('renamed.md'));
  await page.click('.settings-search-clear');

  await page.click('.settings-close');
  const modeBeforeImagePaste = await page.$eval('.editor-root', element => element.getAttribute('data-mode'));
  const textBeforeImagePaste = await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
  await page.click('button[data-mode="source"]');
  await fs.mkdir(path.join(process.cwd(), '.local'), {recursive: true});
  imagePasteRoot = await fs.mkdtemp(path.join(process.cwd(), '.local', 'image-paste-test-'));
  imageContext = { documentFsPath: path.join(imagePasteRoot, '中文 方案[甲].md'), imageStorage: {mode: 'default', folder: '中文图片 with spaces (v1) #100%', rule: '${fileDirname}/assets'} };
  await fs.writeFile(imageContext.documentFsPath!, '# Draft');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaPj/HwAFggK/465+UQAAAABJRU5ErkJggg==';
  const pasteImage = async (imageBase64 = png) => {
    await page.evaluate(png => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      view.focus();
      const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
      const clipboard = new DataTransfer(); clipboard.items.add(new File([bytes], 'screenshot.png', {type: 'image/png'}));
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', {clipboardData: clipboard, bubbles: true, cancelable: true}));
    }, imageBase64);
  };
  console.log('Image settings autosave, validation, IME, stale replies, picker and close persistence passed');
  await pasteImage();
  await page.waitForFunction(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString().includes('中文图片%20with%20spaces%20%28v1%29%20%23100%25/中文%20方案%5B甲%5D-1.png'));
  const images = await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder));
  assert.equal(images.length, 1);
  assert.equal(images[0], '中文 方案[甲]-1.png');
  assert.ok((await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString())).includes('![中文 方案\\[甲\\]-1.png]('));
  console.log('Image paste created a file and inserted an escaped Markdown path');
  assert.equal((await fs.readFile(path.join(imagePasteRoot, imageContext.imageStorage!.folder, images[0]))).toString('base64'), png);
  const beforeUntitledPaste = await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
  imageContext = {...imageContext, documentFsPath: null};
  await pasteImage();
  await page.waitForFunction(() => document.querySelector('.editor-notice')?.textContent?.includes('Save the document'));
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), beforeUntitledPaste);
  imageContext = {...imageContext, documentFsPath: path.join(imagePasteRoot, '中文 方案[甲].md')};
  console.log('Untitled image paste retained the document and displayed an actionable failure');
  await pasteImage();
  await page.waitForFunction(before => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() !== before, {}, beforeUntitledPaste);
  assert.deepEqual(await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder)), ['中文 方案[甲]-1.png'],
    'pasting the same image after a failed untitled paste reuses the existing file');
  const afterRepeatedPaste = await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
  assert.equal(afterRepeatedPaste.split('![中文 方案\\[甲\\]-1.png](').length - 1, 2, 'both image references use the reused final filename');
  await pasteImage('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  await page.waitForFunction(before => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() !== before, {}, afterRepeatedPaste);
  assert.equal((await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder))).length, 2);
  assert.ok((await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder))).includes('中文 方案[甲]-2.png'),
    'different image contents still create a new sequence file');
  await page.click('button[data-mode="live"]');
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({selection: {anchor: view.state.doc.length}});
  });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.meo-md-image-img')].filter(image => image.complete && image.naturalWidth > 0 && image.alt === '中文 方案[甲]-1.png').length > 0);
  if (process.env.MEO_SETTINGS_SCREENSHOTS) {
    await fs.mkdir(path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS), {recursive: true});
    await page.screenshot({path: path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS, 'chinese-pasted-image-live.png')});
  }
  await page.click('button[data-mode="source"]');
  await page.evaluate(text => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: 0}});
  }, textBeforeImagePaste);
  if (modeBeforeImagePaste === 'live') await page.click('button[data-mode="live"]');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  const cursors = await page.$$eval('.settings-radio-input', elements => elements.map(element => [getComputedStyle(element).cursor, getComputedStyle(element.parentElement!).cursor]));
  assert.ok(cursors.every(([input, label]) => input === 'pointer' && label === 'pointer'));
  await page.click('.settings-search'); await page.keyboard.type('空符号');
  assert.deepEqual(await page.$$eval('.settings-tab-badge', elements => elements.map(element => [element.textContent, (element as HTMLElement).hidden])), [['0', false], ['0', false], ['1', false], ['0', false], ['0', false], ['0', false]]);
  assert.equal(await page.$('.settings-tab[data-tab="extensions"]'), null, 'Search keeps the unpublished Extras tab hidden');
  assert.equal(await page.$eval('.settings-searchbox svg', element => getComputedStyle(element).display), 'block');
  await page.click('.settings-tab[data-tab="shortcuts"]');
  assert.equal(await page.$eval('.settings-search-clear', element => (element as HTMLElement).hidden), false);
  await page.click('.settings-search-clear');
  await page.click('[data-edit-command="bold"]');
  await chord('z');
  assert.equal(await page.$eval('.settings-recording .settings-button', element => element.textContent), '替换原绑定');
  const before = await page.evaluate(() => (window as any).__messages.filter((message: any) => message.type === 'updateEditingPreferences').length);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (window as any).__messages.filter((message: any) => message.type === 'updateEditingPreferences').length), before);
  assert.equal(await page.$eval('.settings-warning', element => { const rgb = getComputedStyle(element).color.match(/\d+/g)!.map(Number); return rgb[0] > rgb[1] && rgb[0] > rgb[2]; }), true);
  await page.click('.settings-recording .settings-warning');
  await page.waitForFunction(() => (window as any).__preferences.shortcuts.bold?.[0] === 'Ctrl + Z');
  assert.deepEqual(await page.evaluate(() => (window as any).__preferences.shortcuts.undo), []);
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.editCommand), 'bold');
  await page.click('.settings-search'); await page.keyboard.type('ctrl+z');
  assert.deepEqual(await page.$$eval('.settings-item[data-command]', elements => elements.map(element => (element as HTMLElement).dataset.command)), ['bold'], 'shortcut search follows the new binding and omits the cleared default');
  await page.click('.settings-search-clear');
  await page.click('.settings-close');
  await page.evaluate(() => { const global = window as any; const view = global.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); view.dispatch({ selection: { anchor: 0, head: 5 } }); view.focus(); });
  await chord('z');
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.line(1).text), '**hello**');
  await chord('b');
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.line(1).text), '**hello**', 'cleared default must not execute another format operation');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  await page.click('.settings-tab[data-tab="shortcuts"]');
  const beforeReset = await page.$eval('.settings-window', element => element.getBoundingClientRect().height);
  await page.click('.settings-footer > .settings-button');
  assert.equal(await page.$eval('.settings-window', element => element.getBoundingClientRect().height), beforeReset);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('.settings-reset-popover', element => (element as HTMLElement).hidden), true);
  await page.click('.settings-footer > .settings-button'); await page.click('.settings-reset-popover .settings-primary');
  await page.waitForFunction(() => Object.keys((window as any).__preferences.shortcuts).length === 0);
  assert.equal(await page.evaluate(() => (window as any).__preferences.input.wrapSelection), false, 'reset must preserve input preferences');
  await page.click('[data-edit-command="saveAs"]');
  const beforeSaveAsRecording = await page.evaluate(() => (window as any).__messages.filter((message: any) => message.type === 'saveDocumentAs').length);
  await page.keyboard.down('Shift'); await chord('s'); await page.keyboard.up('Shift');
  assert.equal(await page.$eval('.settings-recorder', e => (e as HTMLInputElement).value), 'Ctrl + Shift + S');
  assert.equal(await page.evaluate(() => (window as any).__messages.filter((message: any) => message.type === 'saveDocumentAs').length), beforeSaveAsRecording,
    'recording Save As must not run the document action from Settings');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).__preferences.shortcuts.saveAs?.[0] === 'Ctrl + Shift + S');
  assert.equal(await page.$eval('[data-action="saveAs"]', e => (e as HTMLElement).dataset.tooltipShortcut), 'Ctrl + Shift + S');
  await page.click('.settings-search'); await page.keyboard.type('新路径保存');
  assert.deepEqual(await page.$$eval('.settings-item[data-command]', elements => elements.map(e => (e as HTMLElement).dataset.command)), ['saveAs']);
  await page.click('.settings-search-clear');
  await page.click('[data-command="saveAs"] .settings-subtle');
  await page.waitForFunction(() => (window as any).__preferences.shortcuts.saveAs?.length === 0);
  assert.equal(await page.$eval('[data-action="saveAs"]', e => (e as HTMLElement).dataset.tooltipShortcut), undefined);
  await page.click('.settings-footer > .settings-button'); await page.click('.settings-reset-popover .settings-primary');
  await page.waitForFunction(() => Object.keys((window as any).__preferences.shortcuts).length === 0);
  assert.equal(await page.$eval('[data-action="saveAs"]', e => (e as HTMLElement).dataset.tooltipShortcut), 'Ctrl + Shift + S');
  await page.click('.settings-search'); await page.keyboard.type('  ');
  assert.equal(await page.$eval('.settings-search-clear', e => (e as HTMLElement).hidden), false);
  assert.ok(await page.$$eval('.settings-tab-badge', elements => elements.every(e => (e as HTMLElement).hidden)));
  await page.click('.settings-search-clear');
  await page.click('[data-edit-command="bold"]');
  await chord('Enter'); assert.equal(await page.$eval('.settings-recorder', e => (e as HTMLInputElement).value), 'Ctrl + Enter');
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.editCommand), 'bold');
  await page.click('[data-edit-command="bold"]');
  await page.keyboard.down('Control'); await page.keyboard.press('Escape'); await page.keyboard.up('Control');
  assert.equal(await page.$eval('.settings-recorder', e => (e as HTMLInputElement).value), 'Ctrl + Escape');
  await page.keyboard.press('Tab'); assert.notEqual(await page.evaluate(() => document.activeElement?.className), 'settings-recorder');
  await page.click('.settings-recording .settings-button:last-child');
  await page.click('.settings-tab[data-tab="typing"]');
  const center = await page.$eval('.settings-radio-input', e => { const rect = e.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
  assert.equal(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, center), 'pointer');
  await page.click('.settings-tab[data-tab="shortcuts"]');
  // Newer broadcasts win over an old acknowledgement/snapshot.
  await page.evaluate(() => {
    const g = window as any; const fresh = { ...g.__preferences, input: { ...g.__preferences.input, emoji: true } }; g.__preferences = fresh;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: fresh, revision: ++g.__revision } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: { ...fresh, input: { ...fresh.input, emoji: false } }, revision: g.__revision - 1 } }));
  });
  await page.click('.settings-tab[data-tab="typing"]'); assert.equal(await page.$eval('[data-setting="emoji"] [role="switch"]', e => e.getAttribute('aria-checked')), 'true');
  await page.click('.settings-tab[data-tab="general"]');
  await page.click('[data-tab="appearance"]');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  const animation = await page.$eval('[data-appearance-mode="light"]', e => {
    (e as HTMLButtonElement).click();
    const pill = e.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
    return pill.getAnimations().map(animation => {
      animation.pause();
      const samples = [0, 75, 150].map(time => { animation.currentTime = time; const bounds = pill.getBoundingClientRect(); return { width: bounds.width, height: bounds.height, radius: getComputedStyle(pill).borderRadius }; });
      const result = { duration: animation.effect?.getTiming().duration, keyframes: (animation.effect as KeyframeEffect).getKeyframes().map(frame => frame.transform), samples };
      animation.finish(); return result;
    });
  });
  assert.ok(animation.some(value => value.duration === 150 && value.keyframes[0] !== value.keyframes[1]), 'the production segmented pill slides');
  assert.ok(animation.every(value => value.keyframes.every(transform => /^translateX\(/.test(String(transform)))), 'the selected pill only translates without scaling');
  for (const value of animation) for (const sample of value.samples) {
    assert.ok(Math.abs(sample.width - value.samples[0].width) <= .1 && Math.abs(sample.height - value.samples[0].height) <= .1 && sample.radius === value.samples[0].radius, 'the selected pill keeps its dimensions and corner radius throughout the slide');
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => document.body.classList.add('vscode-reduce-motion'));
  const reducedMotionAnimation = await page.$eval('[data-appearance-mode="dark"]', e => {
    (e as HTMLButtonElement).click();
    const pill = e.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
    return pill.getAnimations().map(animation => {
      animation.pause();
      const positions = [0, 75, 150].map(time => { animation.currentTime = time; return pill.getBoundingClientRect().left; });
      const duration = animation.effect?.getTiming().duration;
      animation.finish();
      return { positions, duration };
    });
  });
  assert.ok(reducedMotionAnimation.some(value => value.duration === 150 && value.positions[0] < value.positions[1]
    && value.positions[1] < value.positions[2]), 'segmented controls still slide when system and Host reduced-motion preferences are enabled');
  await page.evaluate(() => document.body.classList.remove('vscode-reduce-motion'));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
    await page.setViewport({ width: 1100, height: 780 });
    await page.click('.settings-tab[data-tab="general"]');
    await page.click(`[data-setting="language"] [data-value="${language}"]`);
    await page.click('.settings-tab[data-tab="appearance"]'); await page.click(`[data-appearance-mode="${appearance}"]`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.editorAppearance), appearance);
    assert.equal(await page.$eval('.more-tools-settings-button', element => element.textContent), language === 'en' ? 'Appearance · Input · Shortcuts · etc.' : '外观 · 输入 · 快捷键 · 其他');
    await page.click('.settings-tab[data-tab="shortcuts"]');
    assert.equal(await page.$eval('[data-command="saveAs"] .settings-item-title', e => e.textContent), language === 'en' ? 'Save as…' : '另存为…');
    assert.ok(await page.$('[data-command="saveAs"] [data-edit-command="saveAs"]'));
    if (process.env.MEO_SETTINGS_SCREENSHOTS) {
      const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
      await page.$eval('[data-command="saveAs"]', row => row.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(directory, `save-as-shortcut-${language}-${appearance}.png`) });
    }
    await page.click('.settings-tab[data-tab="typing"]');
    assert.equal(await page.$eval('[data-setting="selectionToolbar"] .settings-item-title', e => e.textContent), language === 'en' ? 'Selection toolbar' : '选区工具栏');
    const wrappingDescription = await page.$eval(wrap + ' .settings-description', element => element.textContent ?? '');
    for (const pair of ['<>', '*', '_', '~', '$', '``']) assert.ok(wrappingDescription.includes(pair), language + ': wrapping description includes ' + pair);
    const selectedColor = await page.$eval('.settings-tab[aria-selected="true"]', e => getComputedStyle(e).color.match(/\d+/g)!.map(Number));
    assert.ok(selectedColor[2] > selectedColor[0], 'selected tab keeps the product blue accent in both themes');
    assert.equal(await page.$eval('.more-tools-section-label:not(:first-child)', e => getComputedStyle(e).borderTopWidth), '0px', 'category uses one separator source');

    await page.setViewport({ width: 430, height: 740 });
    await page.click('.settings-tab[data-tab="general"]');
    const size = await page.evaluate(() => { const dialog = document.querySelector('.settings-window')!; const rect = dialog.getBoundingClientRect(); return { left: rect.left, right: rect.right, overflow: dialog.scrollWidth > dialog.clientWidth }; });
    assert.ok(size.left >= 0 && size.right <= 430 && !size.overflow, JSON.stringify(size));
    assert.equal(await page.$eval('.settings-footer', element => (element as HTMLElement).hidden), true);
    await closeSettings('button');
    await page.locator('.more-tools-wrapper > .format-button').click();
    await page.waitForSelector('.more-tools-panel:not([hidden])');
    await page.hover('.more-tools-settings-button');
    const entry = await page.$eval('.more-tools-settings-button', element => {
      const bounds = element.getBoundingClientRect();
      const label = element.querySelector('.more-tools-preferences-label')!.getBoundingClientRect();
      const arrow = element.querySelector(':scope > svg')!.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, height: bounds.height, labelRight: label.right, arrowLeft: arrow.left, arrowRight: arrow.right,
        overflow: element.scrollWidth > element.clientWidth, background: getComputedStyle(element).backgroundColor };
    });
    assert.ok(entry.left >= 0 && entry.right <= 430 && entry.labelRight < entry.arrowLeft && entry.arrowRight <= entry.right && !entry.overflow,
      `${language}/${appearance}: the full settings entry and arrow fit the narrow menu`);
    assert.notEqual(entry.background, 'rgba(0, 0, 0, 0)', 'The full settings row shows hover feedback');
    const feedback = await page.$eval('.more-tools-feedback-link', element => {
      const row = element.getBoundingClientRect(), prompt = element.querySelector('.more-tools-feedback-prompt')!.getBoundingClientRect();
      const action = element.querySelector('.more-tools-feedback-action')!.getBoundingClientRect();
      const promptElement = element.querySelector('.more-tools-feedback-prompt')!;
      return { left: row.left, right: row.right, height: row.height, promptRight: prompt.right, actionLeft: action.left,
        overflow: element.scrollWidth > element.clientWidth || promptElement.scrollWidth > promptElement.clientWidth };
    });
    assert.ok(feedback.left === entry.left && feedback.right === entry.right && feedback.height === entry.height && feedback.promptRight < feedback.actionLeft && !feedback.overflow,
      `${language}/${appearance}: the feedback description and action fit the aligned narrow row`);
    await page.hover('.more-tools-feedback-link');
    await page.waitForSelector('.feedback-version-popover:not([hidden])');
    await page.waitForSelector('.feedback-version-copy:not([disabled])');
    await page.click('.feedback-version-copy');
    await page.waitForFunction(() => /已复制|Copied/.test(document.querySelector('.feedback-version-copy')!.getAttribute('aria-label')!));
    assert.match(await page.evaluate(() => (window as any).__clipboard), /^MEO Enhanced: .+\nVisual Studio Code: .+\nOS: /);
    assert.equal(await page.$eval('.more-tools-panel', element => (element as HTMLElement).hidden), false, 'The production outside-pointer handler keeps the menu open when copying');
    assert.equal(await page.$eval('.feedback-version-popover', element => (element as HTMLElement).hidden), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.feedback-version-popover', element => (element as HTMLElement).hidden), true);
    if (process.env.MEO_SETTINGS_SCREENSHOTS) {
      await page.screenshot({ path: path.join(path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS), `settings-entry-${language}-${appearance}.png`) });
    }
    await page.locator('.more-tools-settings-button .more-tools-preferences-label').click();
    await page.waitForSelector('.settings-window[open]');
    assert.equal(await page.$eval('.more-tools-panel', element => (element as HTMLElement).hidden), true, 'Opening settings dismisses the menu');
    await closeSettings('escape');
    await page.locator('.more-tools-wrapper > .format-button').click();
    await page.waitForSelector('.more-tools-panel:not([hidden])');
    await page.focus('.more-tools-feedback-link');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval('.more-tools-settings-button', element => element === document.activeElement), true, 'Tab reaches the full settings entry');
    assert.equal(await page.$eval('.more-tools-settings-button', element => getComputedStyle(element).outlineStyle), 'solid', 'The entry has a visible keyboard focus outline');
    await page.keyboard.press(language === 'en' ? 'Enter' : 'Space');
    await page.waitForSelector('.settings-window[open]');
    await closeSettings('escape');
    await page.locator('.more-tools-wrapper > .format-button').click();
    await page.focus('.more-tools-settings-button'); await page.keyboard.press('Tab');
    assert.equal(await page.$eval('.more-tools-feedback-link', element => element === document.activeElement && getComputedStyle(element).outlineStyle === 'solid'), true,
      'Tab reaches the feedback row with a visible keyboard focus outline');
    await page.keyboard.press(language === 'en' ? 'Enter' : 'Space');
    assert.equal(await page.$eval('.more-tools-panel', element => (element as HTMLElement).hidden), true);
    assert.deepEqual(await page.evaluate(() => (window as any).__messages.at(-1)), { type: 'openLink', href: 'https://github.com/huangko555/meo-enhanced/issues/new' });
    await page.locator('.more-tools-wrapper > .format-button').click(); await page.locator('.more-tools-settings-button').click();
    await page.waitForSelector('.settings-window[open]');
  }
  await page.click('.settings-close');
  const setPreferences = async (shortcuts: object) => page.evaluate(shortcuts => {
    const g = window as any; g.__preferences = { ...g.__preferences, shortcuts };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', preferences: g.__preferences, revision: ++g.__revision } }));
  }, shortcuts);
  const documentText = () => page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString());
  await setPreferences({ plain: ['Ctrl + Shift + V'] });
  await page.evaluate(() => { const g = window as any; const view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); g.__clipboard = '\nA\tB\n1\t2'; });
  const beforePlain = await documentText();
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('v'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForFunction(before => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === before + '\nA\tB\n1\t2', {}, beforePlain);
  await page.evaluate(() => { (window as any).__holdNextClipboardRead = true; (window as any).__clipboard = 'STALE_CLIPBOARD'; });
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('v'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForFunction(() => typeof (window as any).__flushClipboardRead === 'function');
  await page.keyboard.type('typed'); const beforeLate = await documentText();
  await page.evaluate(() => { (window as any).__flushClipboardRead(); });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  assert.equal(await documentText(), beforeLate, 'late clipboard reads do not overwrite newer edits');
  const tableText = '| A | B |\n| --- | --- |\n| x | y |';
  await page.evaluate(table => { const g = window as any; const view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: table }, selection: { anchor: table.indexOf('x') } }); }, tableText);
  await page.click('button[data-mode="live"]'); await page.waitForSelector('tbody textarea');
  for (const method of ['button', 'backdrop', 'escape'] as const) {
    for (const [start, end, direction] of [[0, 0, 'none'], [1, 1, 'none'], [0, 1, 'forward'], [0, 1, 'backward']] as const) {
      await page.evaluate(({ start, end, direction }) => {
        const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(start, end, direction);
      }, { start, end, direction });
      await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
      await closeSettings(method);
      assert.deepEqual(await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
        return { focus: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
      }), { focus: true, start, end, direction: direction === 'none' ? 'forward' : direction }, `native cell/${method}: caret and selection direction return to the original input`);
      await page.keyboard.type('Z');
      assert.equal(await page.$eval('tbody textarea', element => (element as HTMLTextAreaElement).value), 'x'.slice(0, start) + 'Z' + 'x'.slice(end), `native cell/${method}: typing resumes without another click`);
      await chord('z');
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'x');
    }
  }
  await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(0, input.value.length); });
  await settleSelection();
  await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible'));
  await setToolbar(false);
  assert.equal(await toolbarVisible(), false, 'disabling also hides the native cell selection toolbar');
  await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(0, 0); input.setSelectionRange(0, input.value.length); });
  await settleSelection(); assert.equal(await toolbarVisible(), false, 'a new native cell selection does not reopen a disabled toolbar');
  await setToolbar(true);
  await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible'));
  await chord('b');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '**x**', 'format shortcuts edit the focused native cell');
  await setPreferences({ cellBreak: [] });
  const cellBefore = await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value);
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), cellBefore, 'clearing a table shortcut suppresses its old native handler');
  await setPreferences({ cellBreak: ['Alt + Enter'] });
  await page.keyboard.down('Alt'); await page.keyboard.press('Enter'); await page.keyboard.up('Alt');
  assert.ok(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value.includes('<br>')), 'a rebound cell break reaches the existing native commit owner');
  await setPreferences({});
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString().includes('**<br>**'));
  const beforePreview = await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString());
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-host')?.hidden || document.querySelector('button[data-mode="preview"]')?.classList.contains('active'));
  await setToolbar(false); await setToolbar(true);
  assert.equal(await toolbarVisible(), false, 'enabling in Preview does not expose the hidden editor toolbar');
  await chord('b');
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()), beforePreview, 'Preview does not mutate the hidden editor');
  for (const method of ['button', 'backdrop', 'escape'] as const) {
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); await closeSettings(method);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.more-tools-wrapper > .format-button')), true, `Preview/${method}: closing settings returns to the visible settings entry`);
    assert.equal(await page.$eval('.editor-root', element => element.getAttribute('data-mode')), 'preview');
  }
  await page.setViewport({ width: 1100, height: 780 });
  // Keep the appearance/IME matrix independent of deliberately incomplete clipboard/mode host scenarios.
  await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await openFixture();
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  type SearchTab = 'general' | 'appearance' | 'typing' | 'shortcuts';
  const searchCases: {tab: SearchTab; id: string; query: string}[] = [];
  for (const locale of ['zh-CN', 'en']) {
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${locale}"]`);
    for (const tab of ['general', 'appearance', 'typing', 'shortcuts'] as const) {
      await page.click(`.settings-tab[data-tab="${tab}"]`);
      const items = await page.$$eval('.settings-item', elements => elements.map(element => ({
        id: (element as HTMLElement).dataset.setting ?? (element as HTMLElement).dataset.input ?? (element as HTMLElement).dataset.command!,
        query: element.querySelector('.settings-item-title')!.textContent!,
        values: [...element.querySelectorAll('.settings-key, .image-location-mode-title, .image-naming-title, .image-location-field-label, .image-location-picker, .image-location-token')].map(control => control.getAttribute('aria-label') ?? control.textContent!)
      })));
      assert.equal(items.length, tab === 'general' ? 10 : tab === 'appearance' ? 14 : tab === 'typing' ? typingSettingCount : editorCommandIds.length, 'search inventory includes every setting and command');
      searchCases.push(...items.flatMap(item => [item.query, ...item.values].map(query => ({tab, id: item.id, query}))));
    }
    await page.click('.settings-close');
  }
  const synonymCases: readonly [SearchTab, string, string, string][] = [
    ['general', 'lineNumbers', '边栏', 'gutter'], ['general', 'foldCode', '收起代码', 'collapse'],
    ['general', 'width', '版心', 'reading width'], ['general', 'widthValue', '像素', 'pixels'],
    ['general', 'boldHeadings', '标题字重', 'heading weight'], ['general', 'stickyHeader', '冻结表头', 'freeze header'],
    ['general', 'restorePosition', '上次位置', 'remember position'], ['general', 'largeDocument', '启动速度', 'large file'],
    ['appearance', 'caret', '插入点', 'insertion point'],
    ['appearance', 'mode', '夜间', 'night'], ['appearance', 'surface', '底色', 'surface'], ['appearance', 'documentBackground', '画布', 'canvas'], ['appearance', 'textEmphasis', '圆点', 'bullet'], ['appearance', 'link', '脚注', 'footnote'], ['general', 'language', '本地化', 'locale'], ['appearance', 'fontSize', '文字大小', 'zoom'], ['appearance', 'lineHeight', '行高', 'leading'], ['appearance', 'lineHeight', '未完善', 'Beta'], ['appearance', 'mouseWheelZoom', '鼠标 滚轮', 'mouse wheel'],
    ['typing', 'selectionToolbar', '浮动工具栏', 'floating toolbar'], ['typing', 'wrapSelection', '环绕选区', 'surround selection'],
    ['typing', 'pairMode', '自动闭合', 'auto close'], ['typing', 'skipMode', '跳出符号', 'overtype'],
    ['typing', 'deleteMode', '一起删除', 'paired deletion'], ['typing', 'lists', '清单', 'list continuation'],
    ['typing', 'convertTables', '制表符', 'TSV'], ['typing', 'pasteUrl', '地址栏', 'web address'],
    ['typing', 'pasteHtml', '富文本', 'rich text'], ['typing', 'showPasteOptions', '仅保留文字', 'keep text only'],
    ['typing', 'documentSuggestions', '锚点', 'backlink'],
    ['typing', 'html', '闭合标签', 'attribute'],
    ['typing', 'slash', '命令面板', 'command palette'], ['typing', 'emoji', '小黄脸', 'smiley'],
    ['typing', 'imageStorage', '自定义路径', 'image storage'],
    ['shortcuts', 'save', '存盘', 'persist'], ['shortcuts', 'undo', '回退', 'rollback'],
    ['shortcuts', 'bold', '字重', 'strong'], ['shortcuts', 'plain', '无格式粘贴', 'unformatted'],
    ['shortcuts', 'wikiLink', '双向链接', 'backlink'], ['shortcuts', 'codeBlock', '代码片段', 'snippet'],
    ['shortcuts', 'heading1', '大标题', 'h1'], ['shortcuts', 'ordered', '数字列表', 'numbering'],
    ['shortcuts', 'taskList', '待办', 'checkbox'], ['shortcuts', 'rule', '分隔线', 'divider'],
    ['shortcuts', 'insertTable', '新建表格', 'create table'], ['shortcuts', 'rowDelete', '移除表格行', 'remove row'],
    ['shortcuts', 'copyCsv', '逗号分隔', 'comma separated'], ['shortcuts', 'addCursor', '多重光标', 'multi cursor'],
    ['shortcuts', 'lineComment', '取消注释', 'uncomment'], ['shortcuts', 'mode', '实时模式', 'WYSIWYG'],
    ['shortcuts', 'preview', '阅读模式', 'rendered view'], ['shortcuts', 'enter', '回车', 'return']
  ];
  searchCases.push(...synonymCases.flatMap(([tab, id, zh, en]) => [{tab, id, query: zh}, {tab, id, query: en}]));
  const searchResults = new Map<string, {ids: string[]; counts: string[]}>();
  const searchChecks = searchCases.length * 4;
  for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`); await page.click('.settings-tab[data-tab="appearance"]'); await page.click(`[data-appearance-mode="${appearance}"]`);
    const beta = '[data-setting="lineHeight"] .meo-beta-badge';
    const betaDescription = language === 'en'
      ? 'This feature is still being refined and may have interaction or display issues.'
      : '此功能仍在完善中，可能存在交互或显示问题。';
    for (const width of [1100, 430]) {
      await page.setViewport({ width, height: 780 });
      await page.$eval(beta, element => element.scrollIntoView({ block: 'center' }));
      await page.hover(beta);
      const waitForBetaHint = () => page.waitForFunction(({ beta, betaDescription }) => {
        const badge = document.querySelector(beta)!;
        const hint = document.getElementById(badge.getAttribute('aria-describedby')!);
        return hint?.textContent === betaDescription && getComputedStyle(hint).visibility === 'visible' && getComputedStyle(hint).opacity === '1';
      }, {}, { beta, betaDescription });
      await waitForBetaHint();
      assert.ok(await page.$eval(beta, element => {
        const badge = element.getBoundingClientRect(), heading = element.parentElement!.getBoundingClientRect();
        const hint = document.getElementById(element.getAttribute('aria-describedby')!)!.getBoundingClientRect();
        return element.textContent === 'Beta' && !element.hasAttribute('title')
          && badge.right <= heading.right && badge.top >= heading.top && badge.bottom <= heading.bottom
          && hint.left >= 8 && hint.right <= innerWidth - 8 && hint.top >= 8 && hint.bottom <= innerHeight - 8;
      }), `${language}/${appearance}/${width}: Beta and its description fit without clipping`);
      if (process.env.MEO_SETTINGS_SCREENSHOTS) {
        const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, `beta-${language}-${appearance}-${width}.png`) });
      }
      await page.mouse.move(0, 0);
      await page.focus('.settings-search'); await page.keyboard.press('Tab'); await page.focus(beta);
      await waitForBetaHint();
      assert.equal(await page.$eval(beta, element => element.matches(':focus-visible') && getComputedStyle(element).boxShadow !== 'none'), true, 'keyboard focus reveals the Beta hint with a visible focus ring');
      await page.keyboard.press('Tab');
    }
    await page.setViewport({ width: 1100, height: 780 });
    await page.click('.settings-close');
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    for (const tab of ['general', 'appearance', 'typing', 'shortcuts'] as const) {
      await page.click(`.settings-tab[data-tab="${tab}"]`);
      const results = await page.evaluate(cases => {
        const search = document.querySelector<HTMLInputElement>('.settings-search')!; search.focus();
        return cases.map(test => {
          search.value = test.query; search.dispatchEvent(new Event('input', {bubbles: true}));
          const ids = [...document.querySelectorAll<HTMLElement>('.settings-item')].map(element => element.dataset.setting ?? element.dataset.input ?? element.dataset.command!);
          const counts = [...document.querySelectorAll('.settings-tab-badge')].map(element => element.textContent!);
          return {...test, ids, counts, focus: document.activeElement === search};
        });
      }, searchCases.filter(test => test.tab === tab));
      for (const result of results) {
        assert.ok(result.ids.includes(result.id), language + '/' + appearance + '/' + tab + ': ' + result.query + ' finds ' + result.id);
        assert.equal(result.focus, true, 'live search retains input focus');
        const key = tab + '/' + result.query, current = {ids: result.ids, counts: result.counts};
        if (searchResults.has(key)) assert.deepEqual(current, searchResults.get(key), 'the same query yields the same items and tab counts in both UI languages and themes');
        else searchResults.set(key, current);
      }
    }
    await page.click('.settings-search-clear'); await page.click('.settings-tab[data-tab="typing"]');
    await page.click('.settings-search'); await page.keyboard.type(' AUTO  CLOSE ');
    assert.deepEqual(await page.$$eval('.settings-item', elements => elements.map(element => (element as HTMLElement).dataset.setting)), ['pairMode']);
    await page.click('.settings-search-clear'); await page.keyboard.type('图片 path');
    assert.deepEqual(await page.$$eval('.settings-item', elements => elements.map(element => (element as HTMLElement).dataset.setting)), ['imageStorage']);
    await page.click('.settings-search-clear'); await page.keyboard.type('图片 theme');
    assert.deepEqual(await page.$$eval('.settings-tab-badge', elements => elements.map(element => element.textContent)), ['0', '0', '0', '0', '0', '0']);
    assert.ok(await page.$('.settings-empty'));
    await page.click('.settings-search-clear'); await page.keyboard.type('不自动补全');
    assert.deepEqual(await page.$$eval('.settings-item', elements => elements.map(element => (element as HTMLElement).dataset.setting)), ['pairMode'], 'choice labels are searchable in the other UI language');
    await page.click('.settings-search-clear'); await page.keyboard.type(language === 'en' ? 'image' : '图片');
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#meo-image-rule') && !document.querySelector<HTMLInputElement>('#meo-image-rule')!.disabled);
    assert.equal(await page.$eval('.image-location-settings .settings-item-title', element => element.textContent), language === 'en' ? 'Image save location' : '图片保存位置');
    if (language === 'zh-CN' && appearance === 'dark') {
      for (let round = 0; round < 4; round++) for (const mode of ['default', 'perDocument', 'advanced']) {
        await page.setViewport({ width: round % 2 ? 320 : 1100, height: 780 });
        await clickImageMode(mode);
      }
      console.log('Image-mode delivery: 12 complete trusted clicks across alternating narrow/desktop layouts passed');
    }
    for (const mode of ['default', 'perDocument', 'advanced']) {
      await clickImageMode(mode);
      await page.waitForFunction(() => !document.querySelector('.image-location-feedback')?.textContent?.includes('…'));
      for (const width of [1100, 320]) {
        await page.setViewport({ width, height: 780 });
        assert.ok(await page.$eval('.image-location-settings', element => element.scrollWidth <= element.clientWidth + 1), language + '/' + appearance + '/' + mode + '/' + width + ': no image-control overflow');
        assert.ok(await page.$eval('.image-location-preview', element => element.scrollWidth <= element.clientWidth + 1));
        const expanded = await page.$$eval('.image-location-option', options => options.flatMap(option => {
          const details = option.querySelector<HTMLElement>('.image-location-details')!;
          if (details.hidden) return [];
          const label = option.querySelector<HTMLElement>('.settings-radio')!;
          const input = details.querySelector<HTMLInputElement>('input')!;
          const next = option.nextElementSibling;
          return [{mode: (option as HTMLElement).dataset.imageMode, input: input.id,
            belowLabel: details.getBoundingClientRect().top >= label.getBoundingClientRect().bottom,
            beforeNext: !next || details.getBoundingClientRect().bottom <= next.getBoundingClientRect().top}];
        }));
        assert.deepEqual(expanded, [{mode, input: mode === 'advanced' ? 'meo-image-rule' : 'meo-image-folder', belowLabel: true, beforeNext: true}], 'only the selected option expands its own controls beneath its label');
        if (mode === 'advanced') {
          const centeredButtons = await page.$$eval('.settings-close, .settings-search-clear', buttons => buttons.map(element => {
            const button = element.getBoundingClientRect(), icon = element.querySelector('svg')?.getBoundingClientRect();
            const search = document.querySelector('.settings-searchbox')!.getBoundingClientRect();
            return { square: Math.abs(button.width - button.height) < 1,
              centered: !!icon && Math.abs((icon.left + icon.right - button.left - button.right) / 2) < 1 && Math.abs((icon.top + icon.bottom - button.top - button.bottom) / 2) < 1,
              aligned: Math.abs((button.top + button.bottom - search.top - search.bottom) / 2) < 1 };
          }));
          assert.deepEqual(centeredButtons, [{square: true, centered: true, aligned: true}, {square: true, centered: true, aligned: true}], language + '/' + appearance + '/' + width + ': close and clear buttons align with the search field and center their icons');
          const descriptions = language === 'en'
            ? ['Document directory', 'File name with extension', 'File name without extension', 'Extension including the dot']
            : ['当前文档目录', '文档名，含扩展名', '文档名，不含扩展名', '扩展名，含点号'];
          const variables = ['${fileDirname}', '${fileBasename}', '${fileBasenameNoExtension}', '${fileExtname}'];
          for (const [index, description] of descriptions.entries()) {
            const selector = '.image-location-variables > button:nth-child(' + (index + 1) + ')';
            assert.equal(await page.$eval(selector, element => element.textContent), description);
            await page.$eval(selector, element => element.scrollIntoView({block: 'center'}));
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.mouse.move(0, 0);
            await page.hover(selector);
            await page.waitForFunction(selector => {
              const id = document.querySelector(selector)?.getAttribute('aria-describedby');
              return !!id && document.getElementById(id)?.classList.contains('is-visible');
            }, {}, selector).catch(error => { throw new Error(`${language}/${appearance}/${width}: variable ${index + 1} hover hint did not open`, {cause: error}); });
            const hint = await page.$eval(selector, element => {
              const tooltip = document.getElementById(element.getAttribute('aria-describedby')!)!, style = getComputedStyle(tooltip);
              const arrow = getComputedStyle(tooltip, '::before');
              const bounds = tooltip.getBoundingClientRect(), button = element.getBoundingClientRect();
              const window = element.closest('.settings-window')!, content = window.getBoundingClientRect();
              const brightness = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number).reduce((sum, channel) => sum + channel, 0);
              const expectedCenter = Math.max(content.left + 4 + bounds.width / 2, Math.min((button.left + button.right) / 2, content.right - 4 - bounds.width / 2));
              return { text: tooltip.textContent, title: element.getAttribute('title'), described: element.getAttribute('aria-describedby') === tooltip.id,
                visible: style.visibility, opacity: style.opacity, delay: style.transitionDelay, border: style.borderTopWidth, background: style.backgroundColor, foreground: style.color, radius: style.borderRadius, shadow: style.boxShadow, singleLine: bounds.height < parseFloat(style.lineHeight) * 2, arrow: arrow.content !== 'none' && arrow.width === '8px', centered: Math.abs((bounds.left + bounds.right) / 2 - expectedCenter) < 1 && style.textAlign === 'center',
                above: bounds.bottom <= button.top, lighterThanWindow: brightness(style.backgroundColor) > brightness(getComputedStyle(window).backgroundColor), contained: bounds.left >= content.left && bounds.right <= content.right && bounds.bottom <= content.bottom };
            });
            assert.deepEqual(hint, {text: variables[index], title: null, described: true, visible: 'visible', opacity: '1', delay: '0s', border: '0px', background: appearance === 'dark' ? 'rgb(58, 58, 58)' : 'rgb(13, 13, 13)', foreground: 'rgb(255, 255, 255)', radius: '10px', shadow: appearance === 'dark' ? 'rgba(0, 0, 0, 0.4) 0px 3px 10px 0px' : 'none', singleLine: true, arrow: false, centered: true, above: true, lighterThanWindow: appearance === 'dark', contained: true}, language + '/' + appearance + '/' + width + ': hover shows the variable above its descriptive button after the shared delay');
            if (index === 2) {
              const hintId = await page.$eval(selector, element => element.getAttribute('aria-describedby'));
              await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
              const clip = await page.$eval('#' + hintId, element => {
                const rect = element.getBoundingClientRect();
                return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
              });
              // Element screenshots may scroll and reposition a fixed tooltip.
              // Capture its settled viewport rectangle without changing the scene.
              const capture = await page.screenshot({clip, captureBeyondViewport: false});
              assert.deepEqual(await page.$eval('#' + hintId, element => {
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, visibility: style.visibility, opacity: style.opacity};
              }), {...clip, visibility: 'visible', opacity: '1'}, 'snapshot preserves the tooltip position and visibility');
              const tintedPixels = await page.evaluate(async data => {
                const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
                const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let tinted = 0;
                // Inspect the text area, excluding rounded corners and the page behind the bubble.
                for (let y = 6; y < canvas.height - 6; y++) for (let x = 8; x < canvas.width - 8; x++) {
                  const offset = (y * canvas.width + x) * 4, channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
                  if (Math.max(...channels) > 100 && Math.max(...channels) - Math.min(...channels) > 6) tinted++;
                }
                return tinted;
              }, Buffer.from(capture).toString('base64'));
              assert.equal(tintedPixels, 0, language + '/' + appearance + '/' + width + ': tooltip text has no colored rendering fringes');
            }
            if (index === 2 && process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR) {
              await fs.mkdir(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, {recursive: true});
              await page.screenshot({path: path.join(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, 'image-tooltip-' + language + '-' + appearance + '-' + width + '.png')});
            }
          }
          await page.hover('.image-location-settings .settings-item-title');
          assert.ok(await page.$$eval('.image-location-token', elements => elements.every(element => getComputedStyle(document.getElementById(element.getAttribute('aria-describedby')!)!).visibility === 'hidden')), 'moving away immediately hides the variable hints');
          await page.focus('#meo-image-rule'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
          await page.waitForFunction(() => {
            const button = document.querySelector('.image-location-token')!;
            return document.getElementById(button.getAttribute('aria-describedby')!)?.classList.contains('is-visible');
          });
          assert.equal(await page.$eval('.image-location-token', element => getComputedStyle(document.getElementById(element.getAttribute('aria-describedby')!)!).visibility), 'visible', 'keyboard focus exposes the same hint after the shared delay');
          await page.$eval('.settings-content', element => { element.scrollTop += 20; });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
          assert.ok(await page.$eval('.image-location-token', element => {
            const button = element.getBoundingClientRect(), hint = document.getElementById(element.getAttribute('aria-describedby')!)!.getBoundingClientRect();
            return Math.abs((hint.left + hint.right) / 2 - (button.left + button.right) / 2) < 1 && Math.abs(button.top - hint.bottom - 6) < 1;
          }), 'scrolling keeps the visible hint centered above its button');
          await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
        }
      }
      await page.setViewport({ width: 1100, height: 780 });
      if (process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, {recursive: true});
        await page.screenshot({path: path.join(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, 'image-settings-' + language + '-' + appearance + '-' + mode + '.png')});
      }
    }
    await page.click('.settings-search-clear'); await page.click('.settings-close');
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => { const g = window as any, view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); return view.dom.classList.contains('meo-mode-source') && !view.state.readOnly && view.contentDOM.isContentEditable && !document.querySelector('.editor-host')?.hasAttribute('hidden'); });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => { const g = window as any, view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '正文' }, selection: { anchor: 2 } }); view.focus(); });
    await page.click('.editor-host .cm-content'); await page.keyboard.press('End');
    await page.keyboard.type('/'); await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 3000 });
    assert.equal(await page.$eval('.meo-suggestion-command', e => e.textContent), '/bold', 'executable command names remain English in both languages');
    assert.equal(await page.$eval('.meo-input-suggestion-detail', e => e.textContent), language === 'en' ? 'Bold' : '粗体');
    assert.equal(await page.$('.meo-suggestion-group'), null, 'the compact menu has no extra group headers');
    const layout = await page.evaluate(() => {
      const popup = document.querySelector<HTMLElement>('.meo-input-suggestions')!, editor = document.querySelector<HTMLElement>('.editor-host .cm-content')!;
      const font = getComputedStyle(popup), editorFont = getComputedStyle(editor);
      return { width: popup.getBoundingClientRect().width, font: font.fontFamily, size: font.fontSize, editorFont: editorFont.fontFamily, editorSize: editorFont.fontSize };
    });
    assert.ok(Math.abs(layout.width - (language === 'en' ? 336 : 288)) < 0.1, 'slash menu uses its fixed language width');
    assert.equal(layout.font, layout.editorFont); assert.equal(layout.size, layout.editorSize);
    const surface = await page.$eval('.meo-input-suggestions', e => getComputedStyle(e).backgroundColor);
    assert.notEqual(surface, 'rgba(0, 0, 0, 0)', 'popup uses the real Webview theme surface');
    if (process.env.MEO_SETTINGS_SCREENSHOTS) {
      const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `slash-${language}-${appearance}.png`) });
    }
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: 'linktitle', selectionStart: 9, selectionEnd: 9 });
    await page.waitForFunction(() => document.querySelectorAll('.meo-input-suggestion').length === 1);
    for (const key of [' ', 'Enter', 'ArrowDown', 'Escape']) assert.equal(await page.evaluate(key => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
      document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
    }, key), false, 'the full shell leaves preedit keys to the IME');
    assert.equal(await documentText(), '正文/linktitle');
    await ime.send('Input.insertText', { text: 'linktitle' }); await ime.detach();
    await page.waitForSelector('.meo-input-suggestions:not([hidden])');
    await page.keyboard.press('Enter');
    assert.equal(await documentText(), '正文[text](url "title")', 'the full shell does not steal the command confirmation');
  }
  const scrollingText = Array.from({ length: 120 }, (_, index) => `content line ${index + 1}`).join('\n');
  for (const mode of ['source', 'live'] as const) {
    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await openFixture(scrollingText, mode); await page.waitForSelector(`.cm-editor.meo-mode-${mode}`);
    await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
    const selection = await page.evaluate(() => {
      const g = window as any, view = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      const head = view.state.doc.line(70).from + 3, anchor = head + 4;
      view.dispatch({ selection: { anchor, head }, effects: g.EditingSettingsHarness.EditorView.scrollIntoView(head, { y: 'center' }) }); view.focus(); return { anchor, head };
    });
    await settleSelection();
    const scroll = await page.$eval('.cm-scroller', element => element.scrollTop);
    assert.ok(scroll > 0, `${mode}: the settings-return fixture is genuinely scrolled`);
    for (const method of ['button', 'backdrop', 'escape'] as const) {
      await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); await closeSettings(method);
      assert.ok(Math.abs(await page.$eval('.cm-scroller', element => element.scrollTop) - scroll) <= 1, `${mode}/${method}: returning from settings keeps the scrolled viewport`);
      assert.deepEqual(await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
        return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
      }), selection);
    }
  }
  for (const fixture of [
    { kind: 'mermaid', text: 'intro\n\n```mermaid\ngraph TD\nA --> B\n```\n\ntail', selector: '.editor-host > .cm-editor .cm-content', button: '.meo-mermaid-mode-btn' },
    { kind: 'math', text: 'intro\n\n$$\nx^2 + y^2 = 1\n$$\n\ntail', selector: '.editor-host > .cm-editor .cm-content', button: null }
  ]) for (const clicks of [1, 2]) {
    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await openFixture(fixture.text, 'live', fixture.kind === 'mermaid');
    await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
    if (fixture.button) {
      for (let count = 0; count < clicks; count++) {
        await page.$eval(count===0?fixture.button:'.meo-mermaid-layout-btn', element => (element as HTMLButtonElement).click());
        await settleSelection();
      }
    } else if (clicks === 1) {
      await page.click('.meo-md-math-fenced-display');
    } else {
      await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('x^2') } }); view.focus();
      });
    }
    await page.waitForSelector(fixture.selector);
    for (const method of ['button', 'backdrop', 'escape'] as const) {
      const original = await page.evaluate(({ selector, kind }) => {
        const g = window as any, editor = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector(selector));
        const source = editor.state.doc.toString(), from = kind === 'math' ? source.indexOf('x^2') : source.indexOf('graph TD');
        const anchor = from + 4, head = from + 2;
        editor.dispatch({ selection: { anchor, head } }); editor.focus(); return { source, anchor, head };
      }, fixture);
      if (fixture.kind === 'math') await page.waitForSelector('.meo-math-source-line');
      await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); await closeSettings(method);
      assert.deepEqual(await page.evaluate(selector => {
        const inner = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector(selector));
        return { focus: inner.hasFocus, anchor: inner.state.selection.main.anchor, head: inner.state.selection.main.head };
      }, fixture.selector), { focus: true, anchor: original.anchor, head: original.head }, `${fixture.kind}/${clicks}/${method}: source editor regains its reversed selection`);
      await page.keyboard.type('R');
      const expected = fixture.text.replace(original.source, () => original.source.slice(0, original.head) + 'R' + original.source.slice(original.anchor));
      await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() === text, { timeout: 2000 }, expected);
      await chord('z');
      await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() === text, {}, fixture.text);
    }
  }
  assert.ok(height > 500);
  const htmlText = 'Before.\n\n<div><p>Format me</p><p>Second</p></div>\n\nAfter.';
  await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await openFixture(htmlText, 'live');
  await page.waitForSelector('.cm-editor');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Format me') + 2 } }); view.focus();
  });
  await page.waitForSelector('.meo-format-html-btn');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  await page.click('.settings-tab[data-tab="shortcuts"]');
  await page.click('.settings-search'); await page.keyboard.type('整理代码');
  assert.deepEqual(await page.$$eval('.settings-item[data-command]', rows => rows.map(e => (e as HTMLElement).dataset.command)), ['formatHtml']);
  await page.click('[data-edit-command="formatHtml"]');
  await page.keyboard.down('Alt'); await chord('l'); await page.keyboard.up('Alt'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).__preferences.shortcuts.formatHtml?.[0] === 'Ctrl + Alt + L');
  await closeSettings('button');
  assert.equal(await page.$eval('.meo-format-html-btn', e => (e as HTMLElement).dataset.tooltipShortcut), 'Ctrl + Alt + L');
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()), htmlText);
  await page.keyboard.down('Alt'); await chord('l'); await page.keyboard.up('Alt');
  await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() !== text, {}, htmlText);
  await chord('z');
  await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === text, {}, htmlText);
  console.log('Bilingual settings search passed (' + searchChecks + ' title, alias, option and shortcut checks across both languages/themes)');
  assert.deepEqual(errors, []);
  if (process.env.MEO_SETTINGS_SCREENSHOTS) {
    const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
    await page.setViewport({ width: 1100, height: 780 });
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    if (await page.$('.settings-search-clear:not([hidden])')) await page.click('.settings-search-clear');
    for (const [language, appearance] of [['zh-CN', 'dark'], ['zh-CN', 'light'], ['en', 'dark'], ['en', 'light']]) {
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`); await page.click('.settings-tab[data-tab="appearance"]'); await page.click(`[data-appearance-mode="${appearance}"]`);
      await page.click('.settings-tab[data-tab="about"]');
      await page.screenshot({ path: path.join(directory, `about-${language}-${appearance}.png`) });
      await page.setViewport({ width: 430, height: 740 });
      await page.screenshot({ path: path.join(directory, `about-narrow-${language}-${appearance}.png`) });
      assert.equal(await page.$eval('.settings-content', element => element.scrollWidth <= element.clientWidth), true, 'About content fits the narrow settings pane');
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.settings-tab[data-tab="typing"]');
      await page.click('.settings-jump[data-section="symbols"]');
      await page.screenshot({ path: path.join(directory, `settings-${language}-${appearance}.png`) });
      await page.setViewport({ width: 430, height: 740 });
      await page.screenshot({ path: path.join(directory, `settings-narrow-${language}-${appearance}.png`) });
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.settings-jump[data-section="paste"]');
      await page.screenshot({ path: path.join(directory, `settings-paste-${language}-${appearance}.png`) });
      await page.$eval('.image-naming-modes', element => element.scrollIntoView({block: 'center'}));
      await page.screenshot({ path: path.join(directory, `image-naming-${language}-${appearance}.png`) });
      await page.setViewport({ width: 430, height: 740 });
      await page.$eval('.image-naming-modes', element => element.scrollIntoView({block: 'center'}));
      await page.screenshot({ path: path.join(directory, `image-naming-narrow-${language}-${appearance}.png`) });
    }
    await closeSettings('button'); await page.locator('.more-tools-wrapper > .format-button').click();
    await page.screenshot({ path: path.join(directory, 'settings-menu-en-light.png') });
  }
  const largeText = '# Settings entry\n\n' + 'Paragraph for the optimized editor settings entry.\n\n'.repeat(5_000);
  assert.equal(assessLargeDocument(largeText).boundedEditorWork, true);
  await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await openFixture(largeText);
  // The feedback popover and About share one successful environment snapshot.
  // Select the remote fixture before either surface can request that snapshot.
  await page.evaluate(() => { (window as any).__environment = {appName:'Visual Studio Code',appVersion:'1.140.0',system:'Linux 6.8.0',architecture:'arm64',remoteName:'ssh-remote'}; });
  await page.waitForSelector('.cm-editor.meo-mode-source');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
    && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);
  assert.equal(await page.evaluate(() => {
    const harness = (window as any).EditingSettingsHarness;
    return harness.usesLargeDocumentDerivedWorkBudget(harness.EditorView.findFromDOM(document.querySelector('.cm-editor')).state);
  }), true, 'The settings entry smoke exercises the production large-document work budget');
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.more-tools-settings-button > svg');
  await page.waitForSelector('.settings-window[open]');
  await closeSettings('escape');
  assert.deepEqual(await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
    return { text: view.state.doc.toString(), focus: view.hasFocus };
  }), { text: largeText, focus: true }, 'The arrow opens settings and returns to the unchanged optimized document');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-feedback-prompt');
  assert.equal(await page.$eval('.more-tools-panel', element => (element as HTMLElement).hidden), true);
  assert.deepEqual(await page.evaluate(() => (window as any).__messages.at(-1)), { type: 'openLink', href: 'https://github.com/huangko555/meo-enhanced/issues/new' },
    'The feedback description activates its whole row in the optimized document');
  await page.click('.more-tools-wrapper > .format-button');
  await page.locator('.more-tools-sponsor-button').click();
  await page.waitForSelector('.settings-window[open][data-tab="about"]');
  await page.waitForSelector('.settings-about-copy:not([disabled])');
  await page.focus('.settings-about-copy'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.settings-about-copy')?.getAttribute('aria-label') === '已复制');
  assert.match(await page.evaluate(() => (window as any).__clipboard), /OS: Linux 6\.8\.0 \(arm64\)\nRemote: ssh-remote$/);
  await closeSettings('escape');
  assert.deepEqual(await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
    return { text: view.state.doc.toString(), focus: view.hasFocus };
  }), { text: largeText, focus: true }, 'The sponsor entry restores the unchanged optimized document');
  assert.deepEqual(errors, []);
  console.log('Production settings: flat sections, narrow/desktop, real controls, live search, recording/conflict, actual reassigned format operation, reset scope, modal return focus/caret/selection in prose, native cells and embedded editors; scrolled viewport, first-character input, animation/reduced motion, failure/retry, late clipboard and native key rebinding; selection toolbar toggle, drag direction, reload and native cells; full-row entry pointer/keyboard and optimized-document return passed');
} catch (error) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meo-settings-failure-'));
  await page.screenshot({ path: path.join(folder, 'settings.png') }); await fs.writeFile(path.join(folder, 'page.html'), await page.content());
  console.error('Diagnostics:', folder, errors, await page.evaluate(() => { const g = window as any, view = g.EditingSettingsHarness?.EditorView.findFromDOM(document.querySelector('.cm-editor')); return view ? { text: view.state.doc.toString(), readonly: view.state.readOnly, focus: view.hasFocus, active: document.activeElement?.outerHTML.slice(0, 200), scroll: view.scrollDOM.getBoundingClientRect().toJSON() } : { initialized: false, active: document.activeElement?.outerHTML.slice(0, 200) }; })); throw error;
} finally {
  await closeTestBrowser(browser);
  if (imagePasteRoot) await fs.rm(imagePasteRoot, {recursive: true, force: true});
}
