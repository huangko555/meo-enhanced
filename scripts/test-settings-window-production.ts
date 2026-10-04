import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { saveClipboardImageFile } from '../src/host/clipboardImageSave';
import { createImageStorageHost, type ImageStorageContext } from '../src/host/imageStorage';
import type { ImageLocationRequest } from '../src/protocol/imageStorage';
const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let page = await browser.newPage();
let imagePasteRoot: string | null = null;
const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
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
  const openFixture = async (text = 'hello\n\n# Heading\n\ntext', mode: 'source' | 'live' = 'source', stubMermaid = false) => {
    if (!imagePages.has(page)) {
      await page.exposeFunction('__imageLocationHost', (request: ImageLocationRequest) => imageHost.handle(request, 'settings-document'));
      await page.exposeFunction('__imageSaveHost', async (request: {requestId: string; imageData: string; fileName: string}) => {
        try {
          if (!imageContext.documentFsPath) throw new Error('Save the document as a local Markdown file before pasting images.');
          const saved = await saveClipboardImageFile({
            ...imageContext, documentFsPath: imageContext.documentFsPath,
            requestedFileName: request.fileName, contents: Buffer.from(request.imageData.replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
          });
          return {type: 'savedImagePath', requestId: request.requestId, result: {ok: true, value: {path: saved.relativePath}}};
        } catch (error) { return {type: 'savedImagePath', requestId: request.requestId, result: {ok: false, error: {code: 'operation-failed', message: String(error)}}}; }
      });
      imagePages.add(page);
    }
    await page.setViewport({ width: 1100, height: 780 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addScriptTag({ content: `
      window.__messages=[]; window.__revision=0; window.__clipboard='';
      window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
        window.__messages.push(message);
        if(message.type==='updateEditingPreferences') {
          const apply = () => {
          if(window.__failNextUpdate) {
            window.__failNextUpdate=false;
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision:window.__revision,result:{ok:false,error:{code:'operation-failed',message:'fixture write failure'}}}})));
            return;
          }
          try {
            window.__preferences=window.EditingSettingsHarness.changeEditingPreferences(window.__preferences,message.change,'other');
            const revision=++window.__revision;
            queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision,result:{ok:true,value:window.__preferences}}})));
          } catch(error) { queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'updatedEditingPreferences',requestId:message.requestId,revision:window.__revision,result:{ok:false,error:{code:'operation-failed',message:String(error)}}}}))); }
          };
          if(window.__holdNextUpdate) { window.__holdNextUpdate=false; window.__flushUpdate=apply; } else apply();
        }
        if(message.type==='saveImageFromClipboard') {
          window.__imageSaveHost(message).then(response => window.dispatchEvent(new MessageEvent('message', {data: response})));
        }
        if(message.type==='imageLocation') {
          window.__imageLocationHost(message).then(response => {
            const reply = () => window.dispatchEvent(new MessageEvent('message', {data: response}));
            if(window.__holdImageReply && message.action==='preview') { window.__holdImageReply=false; window.__releaseImageReply=reply; }
            else reply();
          });
        }
        if(message.type==='editorService') {
          const value=message.action==='links'?{candidates:[]}:{text:message.action==='readClipboard'?window.__clipboard:''};
          if(message.action==='writeClipboard') window.__clipboard=message.text;
          const reply=()=>queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorServiceResult',requestId:message.requestId,result:{ok:true,value}}})));
          if(message.action==='readClipboard' && window.__holdNextClipboardRead) { window.__holdNextClipboardRead=false; window.__flushClipboardRead=reply; } else reply();
        }
      }});
    ` });
    if (stubMermaid) await page.evaluate(() => { (window as any).mermaid = { initialize() {}, async render() { return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>' }; } }; });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    await page.evaluate(({ text, mode }) => {
      const global = window as any; global.__preferences = { input: { ...global.EditingSettingsHarness.defaultInputAssistance }, shortcuts: {} };
      global.__initMessage = { type: 'init', documentId: 'file:///settings.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'zh-CN', uiLanguagePreference: 'zh-CN', automaticUiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, previewShowComments: false, editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null, editingPreferences: global.__preferences, editingPreferencesRevision: 0 };
      window.dispatchEvent(new MessageEvent('message', { data: global.__initMessage }));
    }, { text, mode });
  };
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
    for (const method of ['button', 'backdrop', 'escape'] as const) {
      for (const [anchor, head] of [[2, 2], [1, 4], [4, 1]]) {
        const before = await page.evaluate(({ anchor, head }) => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
          view.dispatch({ selection: { anchor, head } }); view.focus();
          return { text: view.state.doc.toString(), scroll: view.scrollDOM.scrollTop };
        }, { anchor, head });
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
  assert.equal(await page.$$eval('.more-tools-panel .more-tools-option', elements => elements.length), 6);
  assert.deepEqual(await page.$$eval('.more-tools-panel .more-tools-section-label', elements => elements.map(element => element.textContent)), ['文档显示', '界面设置', '偏好设置']);
  await page.click('.more-tools-settings-button');
  assert.equal(await page.$eval('.settings-window', element => (element as HTMLDialogElement).open), true);
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 11);
  assert.equal(await page.$eval('.settings-footer', element => (element as HTMLElement).hidden), true);
  const height = await page.$eval('.settings-window', element => element.getBoundingClientRect().height);
  await page.click('.settings-jump[data-section="interface"]');
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
  await page.click('.settings-tab[data-tab="typing"]');
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 13);
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
  imageContext = { documentFsPath: path.join(imagePasteRoot, 'draft.md'), imageStorage: {mode: 'default', folder: 'images with spaces (v1) #100%', rule: '${fileDirname}/assets'} };
  await fs.writeFile(imageContext.documentFsPath!, '# Draft');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Nf8AAAAASUVORK5CYII=';
  const pasteImage = async () => {
    await page.evaluate(png => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      view.focus();
      const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
      const clipboard = new DataTransfer(); clipboard.items.add(new File([bytes], 'screenshot.png', {type: 'image/png'}));
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', {clipboardData: clipboard, bubbles: true, cancelable: true}));
    }, png);
  };
  console.log('Image settings autosave, validation, IME, stale replies, picker and close persistence passed');
  await pasteImage();
  await page.waitForFunction(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString().includes('images%20with%20spaces%20%28v1%29%20%23100%25/'));
  const images = await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder));
  assert.equal(images.length, 1);
  console.log('Image paste created a file and inserted an escaped Markdown path');
  assert.equal((await fs.readFile(path.join(imagePasteRoot, imageContext.imageStorage!.folder, images[0]))).toString('base64'), png);
  const beforeUntitledPaste = await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
  imageContext = {...imageContext, documentFsPath: null};
  await pasteImage();
  await page.waitForFunction(() => document.querySelector('.editor-notice')?.textContent?.includes('Save the document'));
  assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), beforeUntitledPaste);
  imageContext = {...imageContext, documentFsPath: path.join(imagePasteRoot, 'draft.md')};
  console.log('Untitled image paste retained the document and displayed an actionable failure');
  await pasteImage();
  await page.waitForFunction(before => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() !== before, {}, beforeUntitledPaste);
  assert.equal((await fs.readdir(path.join(imagePasteRoot, imageContext.imageStorage!.folder))).length, 2);
  await page.evaluate(text => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: 0}});
  }, textBeforeImagePaste);
  if (modeBeforeImagePaste === 'live') await page.click('button[data-mode="live"]');
  await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
  const cursors = await page.$$eval('.settings-radio-input', elements => elements.map(element => [getComputedStyle(element).cursor, getComputedStyle(element.parentElement!).cursor]));
  assert.ok(cursors.every(([input, label]) => input === 'pointer' && label === 'pointer'));
  await page.click('.settings-search'); await page.keyboard.type('空符号');
  assert.deepEqual(await page.$$eval('.settings-tab-badge', elements => elements.map(element => [element.textContent, (element as HTMLElement).hidden])), [['0', false], ['1', false], ['0', false]]);
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
  const animation = await page.$eval('[data-setting="theme"] [data-value="light"]', e => {
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
  assert.equal(await page.$eval('[data-setting="theme"] [data-value="dark"]', e => { (e as HTMLButtonElement).click(); return e.querySelector<HTMLElement>('.segmented-control-button-indicator')!.getAnimations().length; }), 0);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
    await page.click('.settings-tab[data-tab="general"]');
    await page.click(`[data-setting="language"] [data-value="${language}"]`);
    await page.click(`[data-setting="theme"] [data-value="${appearance}"]`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.editorAppearance), appearance);
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
  for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`); await page.click(`[data-setting="theme"] [data-value="${appearance}"]`); await page.click('.settings-close');
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    await page.click('.settings-tab[data-tab="typing"]');
    await page.click('.settings-search'); await page.keyboard.type(language === 'en' ? 'image' : '图片');
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#meo-image-rule') && !document.querySelector<HTMLInputElement>('#meo-image-rule')!.disabled);
    assert.equal(await page.$eval('.image-location-settings .settings-item-title', element => element.textContent), language === 'en' ? 'Image save location' : '图片保存位置');
    for (const mode of ['default', 'perDocument', 'advanced']) {
      await page.click('.image-location-modes input[value="' + mode + '"]');
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
          const descriptions = language === 'en'
            ? ['Document directory', 'File name with extension', 'File name without extension', 'Extension including the dot']
            : ['当前文档目录', '文档名，含扩展名', '文档名，不含扩展名', '扩展名，含点号'];
          for (const [index, description] of descriptions.entries()) {
            const selector = '.image-location-variables > button:nth-child(' + (index + 1) + ')';
            await page.hover(selector);
            const hint = await page.$eval(selector, element => {
              const tooltip = element.querySelector<HTMLElement>('[role="tooltip"]')!, style = getComputedStyle(tooltip);
              const arrow = getComputedStyle(tooltip, '::before');
              const bounds = tooltip.getBoundingClientRect(), button = element.getBoundingClientRect();
              const content = element.closest('.settings-content')!.getBoundingClientRect();
              return { text: tooltip.textContent, title: element.getAttribute('title'), described: element.getAttribute('aria-describedby') === tooltip.id,
                visible: style.visibility, opacity: style.opacity, delay: style.transitionDelay, border: style.borderTopWidth, arrow: arrow.content !== 'none' && arrow.width === '8px', centered: Math.abs((bounds.left + bounds.right) / 2 - (button.left + button.right) / 2) < 1 && Math.abs(parseFloat(arrow.left) - bounds.width / 2) < 1 && style.textAlign === 'center',
                below: bounds.top >= button.bottom, contained: bounds.left >= content.left && bounds.right <= content.right && bounds.bottom <= content.bottom };
            });
            assert.deepEqual(hint, {text: description, title: null, described: true, visible: 'visible', opacity: '1', delay: '0s', border: '0px', arrow: true, centered: true, below: true, contained: true}, language + '/' + appearance + '/' + width + ': hover immediately shows one unobstructed hint below the button');
            if (index === 2 && process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR) {
              await fs.mkdir(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, {recursive: true});
              await page.screenshot({path: path.join(process.env.MEO_IMAGE_SETTINGS_SCREENSHOT_DIR, 'image-tooltip-' + language + '-' + appearance + '-' + width + '.png')});
            }
          }
          await page.hover('.image-location-settings .settings-item-title');
          assert.ok(await page.$$eval('.image-location-token [role="tooltip"]', elements => elements.every(element => getComputedStyle(element).visibility === 'hidden')), 'moving away immediately hides the variable hints');
          await page.focus('#meo-image-rule'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
          assert.equal(await page.$eval('.image-location-token [role="tooltip"]', element => getComputedStyle(element).visibility), 'visible', 'keyboard focus exposes the same hint');
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
    assert.equal(layout.width, 360); assert.equal(layout.font, layout.editorFont); assert.equal(layout.size, layout.editorSize);
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
    { kind: 'mermaid', text: 'intro\n\n```mermaid\ngraph TD\nA --> B\n```\n\ntail', selector: '.meo-mermaid-source-editor .cm-content', button: '.meo-mermaid-mode-btn' },
    { kind: 'math', text: 'intro\n\n$$\nx^2 + y^2 = 1\n$$\n\ntail', selector: '.meo-latex-math-source-editor .cm-content', button: '.meo-latex-math-mode-btn' }
  ]) for (const clicks of [1, 2]) {
    await page.close(); page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await openFixture(fixture.text, 'live', fixture.kind === 'mermaid');
    await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
    for (let count = 0; count < clicks; count++) {
      await page.$eval(fixture.button, element => (element as HTMLButtonElement).click());
      await settleSelection();
    }
    await page.waitForSelector(fixture.selector);
    for (const method of ['button', 'backdrop', 'escape'] as const) {
      const original = await page.evaluate(selector => {
        const g = window as any, inner = g.EditingSettingsHarness.EditorView.findFromDOM(document.querySelector(selector));
        inner.dispatch({ selection: { anchor: 4, head: 2 } }); inner.focus(); return inner.state.doc.toString();
      }, fixture.selector);
      await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); await closeSettings(method);
      assert.deepEqual(await page.evaluate(selector => {
        const inner = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector(selector));
        return { focus: inner.hasFocus, anchor: inner.state.selection.main.anchor, head: inner.state.selection.main.head };
      }, fixture.selector), { focus: true, anchor: 4, head: 2 }, `${fixture.kind}/${clicks}/${method}: internal editor regains its reversed selection`);
      await page.keyboard.type('R');
      const expected = fixture.text.replace(original, original.slice(0, 2) + 'R' + original.slice(4));
      await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() === text, { timeout: 2000 }, expected);
      await chord('z');
      await page.waitForFunction(text => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString() === text, {}, fixture.text);
    }
  }
  assert.ok(height > 500);
  assert.deepEqual(errors, []);
  if (process.env.MEO_SETTINGS_SCREENSHOTS) {
    const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
    await page.setViewport({ width: 1100, height: 780 });
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    for (const [language, appearance] of [['zh-CN', 'dark'], ['zh-CN', 'light'], ['en', 'dark'], ['en', 'light']]) {
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`); await page.click(`[data-setting="theme"] [data-value="${appearance}"]`);
      await page.click('.settings-tab[data-tab="typing"]');
      await page.click('.settings-jump[data-section="symbols"]');
      await page.screenshot({ path: path.join(directory, `settings-${language}-${appearance}.png`) });
      await page.setViewport({ width: 430, height: 740 });
      await page.screenshot({ path: path.join(directory, `settings-narrow-${language}-${appearance}.png`) });
      await page.setViewport({ width: 1100, height: 780 });
      await page.click('.settings-jump[data-section="paste"]');
      await page.screenshot({ path: path.join(directory, `settings-paste-${language}-${appearance}.png`) });
    }
    await page.click('.settings-close'); await page.click('.more-tools-wrapper > .format-button');
    await page.screenshot({ path: path.join(directory, 'settings-menu-en-light.png') });
  }
  console.log('Production settings: flat sections, narrow/desktop, real controls, live search, recording/conflict, actual reassigned format operation, reset scope, modal return focus/caret/selection in prose, native cells and embedded editors; scrolled viewport, first-character input, animation/reduced motion, failure/retry, late clipboard and native key rebinding; selection toolbar toggle, drag direction, reload and native cells passed');
} catch (error) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meo-settings-failure-'));
  await page.screenshot({ path: path.join(folder, 'settings.png') }); await fs.writeFile(path.join(folder, 'page.html'), await page.content());
  console.error('Diagnostics:', folder, errors, await page.evaluate(() => { const g = window as any, view = g.EditingSettingsHarness?.EditorView.findFromDOM(document.querySelector('.cm-editor')); return view ? { text: view.state.doc.toString(), readonly: view.state.readOnly, focus: view.hasFocus, active: document.activeElement?.outerHTML.slice(0, 200), scroll: view.scrollDOM.getBoundingClientRect().toJSON() } : { initialized: false, active: document.activeElement?.outerHTML.slice(0, 200) }; })); throw error;
} finally {
  await closeTestBrowser(browser);
  if (imagePasteRoot) await fs.rm(imagePasteRoot, {recursive: true, force: true});
}
