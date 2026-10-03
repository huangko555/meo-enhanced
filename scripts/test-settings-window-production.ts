import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const page = await browser.newPage();
const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
try {
  const chord = async (key: string) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
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
      if(message.type==='editorService') {
        const value=message.action==='links'?{candidates:[]}:{text:message.action==='readClipboard'?window.__clipboard:''};
        if(message.action==='writeClipboard') window.__clipboard=message.text;
        const reply=()=>queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorServiceResult',requestId:message.requestId,result:{ok:true,value}}})));
        if(message.action==='readClipboard' && window.__holdNextClipboardRead) { window.__holdNextClipboardRead=false; window.__flushClipboardRead=reply; } else reply();
      }
    }});
  ` });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  await page.evaluate(() => {
    const global = window as any; global.__preferences = { input: { ...global.EditingSettingsHarness.defaultInputAssistance }, shortcuts: {} };
    const text = 'hello\n\n# Heading\n\ntext';
    global.__initMessage = { type: 'init', documentId: 'file:///settings.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'zh-CN', uiLanguagePreference: 'zh-CN', automaticUiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, previewShowComments: false, editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null, editingPreferences: global.__preferences, editingPreferencesRevision: 0 };
    window.dispatchEvent(new MessageEvent('message', { data: global.__initMessage }));
  });
  await page.waitForSelector('.cm-editor');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  await page.click('.more-tools-wrapper > .format-button');
  assert.equal(await page.$eval('.more-tools-panel', element => element.getBoundingClientRect().width), 288);
  assert.equal(await page.$$eval('.more-tools-panel .more-tools-option', elements => elements.length), 6);
  assert.deepEqual(await page.$$eval('.more-tools-panel .more-tools-section-label', elements => elements.map(element => element.textContent)), ['文档显示', '界面设置', '偏好设置']);
  await page.click('.more-tools-settings-button');
  assert.equal(await page.$eval('.settings-window', element => (element as HTMLDialogElement).open), true);
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 11);
  assert.equal(await page.$eval('.settings-footer', element => (element as HTMLElement).hidden), true);
  const height = await page.$eval('.settings-window', element => element.getBoundingClientRect().height);
  await page.click('.settings-tab[data-tab="typing"]');
  assert.equal(await page.$$eval('.settings-item', elements => elements.length), 12);
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
    return pill.getAnimations().map(animation => ({ duration: animation.effect?.getTiming().duration, keyframes: (animation.effect as KeyframeEffect).getKeyframes().map(frame => frame.transform) }));
  });
  assert.ok(animation.some(value => value.duration === 150 && value.keyframes[0] !== value.keyframes[1]), 'the production segmented pill moves and resizes');
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
  assert.ok(height > 500);
  assert.deepEqual(errors, []);
  if (process.env.MEO_SETTINGS_SCREENSHOTS) {
    const directory = path.resolve(process.env.MEO_SETTINGS_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
    await page.setViewport({ width: 1100, height: 780 });
    await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button');
    for (const [language, appearance] of [['zh-CN', 'dark'], ['en', 'light']]) {
      await page.click('.settings-tab[data-tab="general"]'); await page.click(`[data-setting="language"] [data-value="${language}"]`); await page.click(`[data-setting="theme"] [data-value="${appearance}"]`);
      await page.click('.settings-tab[data-tab="typing"]');
      await page.click('.settings-jump[data-section="symbols"]');
      await page.screenshot({ path: path.join(directory, `settings-${language}-${appearance}.png`) });
      await page.click('.settings-jump[data-section="paste"]');
      await page.screenshot({ path: path.join(directory, `settings-paste-${language}-${appearance}.png`) });
    }
    await page.click('.settings-close'); await page.click('.more-tools-wrapper > .format-button');
    await page.screenshot({ path: path.join(directory, 'settings-menu-en-light.png') });
  }
  console.log('Production settings: flat sections, narrow/desktop, real controls, live search, recording/conflict, actual reassigned format operation, reset scope and focus; animation/reduced motion, failure/retry, late clipboard and native key rebinding; selection toolbar toggle, drag direction, reload and native cells passed');
} catch (error) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meo-settings-failure-'));
  await page.screenshot({ path: path.join(folder, 'settings.png') }); await fs.writeFile(path.join(folder, 'page.html'), await page.content());
  console.error('Diagnostics:', folder, errors); throw error;
} finally { await closeTestBrowser(browser); }
