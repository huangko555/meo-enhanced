import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { createAppearanceSettingsOwner, type AppearanceSettingsStore } from '../src/host/appearanceSettings';
import { decodeEditorCommand } from '../src/protocol/editorCommands';

const configuration = new Map<string, unknown>([['appearance.fontSizeMode', 'auto'], ['appearance.fontSize', 20]]);
const store: AppearanceSettingsStore = {
  readConfiguration: key => ({ value: configuration.get(key), explicit: configuration.has(key), globalValue: configuration.get(key) }),
  updateConfiguration: async (key, value) => { await new Promise(resolve => setTimeout(resolve, 15)); configuration.set(key, value); },
  readLegacy: () => undefined, updateLegacy: async () => {}
};
const owner = await createAppearanceSettingsOwner(store);
assert.equal(owner.getEditorMouseWheelZoom(), true);
const build = await Bun.build({ entrypoints: ['scripts/test-font-size-full-document-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const page = await browser.newPage();
const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
await page.exposeFunction('__saveFontSetting', async (raw: unknown) => {
  const command = decodeEditorCommand(raw); assert.ok(command);
  if (command.type === 'setEditorFontSize') await owner.setEditorFontSizePreference(command);
  else if (command.type === 'setEditorMouseWheelZoom') await owner.setEditorMouseWheelZoom(command.enabled);
});
const fixture = async (language = 'zh-CN', appearance = 'light', mac = false) => {
  await page.setViewport({ width: 1100, height: 780 });
  await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${appearance}"><div id="app"></div></body>`);
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--vscode-editor-font-size:15px;--vscode-editor-font-family:monospace;--vscode-font-family:Arial}' });
  await page.evaluate(isMac => Object.defineProperty(navigator, 'platform', { configurable: true, value: isMac ? 'MacIntel' : 'Win32' }), mac);
  await page.addScriptTag({ content: `
    window.__hostMessages=[];window.__completed=[];
    window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
      window.__hostMessages.push(message);
      if(message.type==='setEditorFontSize'||message.type==='setEditorMouseWheelZoom') {
        window.__saveFontSetting(message).then(()=>window.__completed.push(message));
      }
      if(message.type==='requestPreviewRender') {
        const size=message.environment.editorFontSizePx;
        const styles='html,body{margin:0}.meo-export-doc{font-size:'+size+'px;line-height:1.5}p{margin:0}';
        const html=Array.from({length:220},(_,i)=>'<p data-source-line="'+(i+1)+'">stable line '+(i+1)+'</p>').join('');
        queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'previewRenderResult',requestId:message.requestId,result:{ok:true,value:{html,hasMermaid:false,styles:{light:styles,dark:styles}}}}})));
      }
    }});
  ` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(({ preference, enabled, language, appearance }) => {
    const text = Array.from({ length: 220 }, (_, i) => `stable line ${i + 1}`).join('\n');
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///font-wheel.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'source', uiLanguage: language, sourceLineNumbers: 'on', previewAppearance: appearance,
      previewFontFamily: '', previewSourceColoring: true, editorAppearance: appearance,
      editorFontSizeMode: preference.mode, editorFontSize: preference.value, editorMouseWheelZoom: enabled,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false,
      outlineWidth: 260, vscodeTheme: null
    } }));
  }, { preference: owner.getEditorFontSizePreference(), enabled: owner.getEditorMouseWheelZoom(), language, appearance });
  await page.waitForSelector('.editor-host > .cm-editor');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
};
const size = () => page.$eval('.editor-host > .cm-editor', element => Number.parseFloat(getComputedStyle(element).fontSize));
const waitSize = async (expected: number) => page.waitForFunction(value =>
  Number.parseFloat(getComputedStyle(document.querySelector('.editor-host > .cm-editor')!).fontSize) === value, {}, expected);
const frames = () => page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
const wheel = async (deltaY: number, modifier: 'Control' | 'Meta' | null = 'Control', selector = '.editor-host > .cm-editor') => {
  const box = await page.$eval(selector, element => element.getBoundingClientRect().toJSON());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.wheel({ deltaY });
  if (modifier) await page.keyboard.up(modifier);
  await frames();
};
const waitSaved = (value: number) => page.waitForFunction(expected => (window as any).__completed.some((message: any) => message.type === 'setEditorFontSize' && message.value === expected), {}, value);
const openSettings = async () => {
  await page.click('.more-tools-wrapper > .format-button');
  await page.waitForSelector('.more-tools-settings-button', { visible: true });
  await page.click('.more-tools-settings-button');
  await page.click('[data-tab="appearance"]');
};
const switchSelector = '[data-setting="mouseWheelZoom"] [role="switch"]';
try {
  await fixture();
  assert.equal(await size(), 15);
  await wheel(-100); await waitSize(16); await waitSaved(16);
  assert.deepEqual(owner.getEditorFontSizePreference(), { mode: 'custom', value: 16 }, 'Auto 15 must ignore the old Custom 20');
  await wheel(100); await waitSize(15);
  await waitSaved(15);

  // A burst updates once per frame and persists only its final size.
  await page.evaluate(() => {
    (window as any).__hostMessages = [];
    const target = document.querySelector('.editor-host > .cm-editor')!;
    for (let i = 0; i < 5; i++) target.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await waitSize(20); await waitSaved(20);
  assert.equal(await page.evaluate(() => (window as any).__hostMessages.filter((message: any) => message.type === 'setEditorFontSize').length), 1);
  assert.equal(await page.evaluate(() => (window as any).__hostMessages.some((message: any) => message.type === 'edit' || message.type === 'change')), false);
  await fixture(); assert.equal(await size(), 20, 'Reopening restores the saved size');

  await openSettings();
  assert.equal(await page.$eval(switchSelector, element => element.getAttribute('aria-checked')), 'true');
  await page.click('[data-setting="mouseWheelZoom"] .settings-item-title');
  assert.equal(await page.$eval(switchSelector, element => element.getAttribute('aria-checked')), 'true', 'Only the switch changes the preference');
  await page.click(switchSelector); await page.click('.settings-close');
  await page.waitForFunction(() => (window as any).__completed.some((message: any) => message.type === 'setEditorMouseWheelZoom' && !message.enabled));
  await wheel(-100); assert.equal(await size(), 20);
  assert.equal(owner.getEditorMouseWheelZoom(), false);
  await fixture(); await wheel(100); assert.equal(await size(), 20, 'Disabled survives reopening');
  await openSettings(); await page.click(switchSelector); await page.click('.settings-close');
  await page.waitForFunction(() => (window as any).__completed.some((message: any) => message.type === 'setEditorMouseWheelZoom' && message.enabled));
  const scrollBefore = await page.$eval('.cm-scroller', element => element.scrollTop);
  await wheel(300, null);
  await page.waitForFunction(before => document.querySelector('.cm-scroller')!.scrollTop > before, {}, scrollBefore);
  assert.equal(await size(), 20, 'Ordinary scrolling leaves typography unchanged');

  await page.click('[data-mode="live"]'); await wheel(-100); await waitSize(21); await waitSaved(21);
  await page.click('[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line="75"]'));
  await wheel(-100, 'Control', '.preview-frame'); await waitSaved(22);
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return getComputedStyle(doc.querySelector('.meo-export-doc')!).fontSize === '22px';
  });
  assert.equal(await page.evaluate(() => (window as any).__hostMessages.findLast((message: any) => message.type === 'requestPreviewRender').environment.editorFontSizePx), 22, 'Preview/export use the same saved size');

  // Fine trackpad deltas accumulate; horizontal and extra-modifier gestures stay unclaimed.
  await page.click('[data-mode="source"]');
  await page.evaluate(() => {
    const target = document.querySelector('.editor-host > .cm-editor')!;
    for (let i = 0; i < 8; i++) target.dispatchEvent(new WheelEvent('wheel', { deltaY: -5, ctrlKey: true, bubbles: true, cancelable: true }));
    const horizontal = new WheelEvent('wheel', { deltaX: 100, deltaY: 1, ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(horizontal); if (horizontal.defaultPrevented) throw new Error('Horizontal wheel was claimed');
    const extra = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(extra); if (extra.defaultPrevented) throw new Error('Ctrl+Shift wheel was claimed');
  });
  await waitSize(23); await waitSaved(23);
  await owner.setEditorFontSizePreference({ mode: 'custom', value: 32 }); await fixture(); await wheel(-100); assert.equal(await size(), 32);
  await owner.setEditorFontSizePreference({ mode: 'custom', value: 10 }); await fixture(); await wheel(100); assert.equal(await size(), 10);
  await owner.setEditorFontSizePreference({ mode: 'auto', value: 20 }); await fixture();
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-font-size', '40px'));
  await wheel(-100); assert.equal(await size(), 40, 'An inherited size above the custom limit must not shrink on zoom-in');
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-font-size', '8px'));
  await wheel(100); assert.equal(await size(), 8, 'An inherited size below the custom limit must not grow on zoom-out');
  await owner.setEditorFontSizePreference({ mode: 'custom', value: 10 });

  const directory = path.resolve('.local/font-wheel-acceptance'); await fs.mkdir(directory, { recursive: true });
  for (const language of ['zh-CN', 'en']) for (const appearance of ['light', 'dark']) {
    await fixture(language, appearance, language === 'en'); await openSettings();
    await page.$eval('[data-setting="mouseWheelZoom"]', element => element.scrollIntoView({ block: 'center' }));
    const title = await page.$eval('[data-setting="mouseWheelZoom"] .settings-item-title', element => element.textContent);
    assert.ok(title?.includes(language === 'en' ? 'Cmd' : 'Ctrl'));
    await page.screenshot({ path: path.join(directory, `${language}-${appearance}.png`) });
    await page.setViewport({ width: 600, height: 700 });
    await page.$eval('[data-setting="mouseWheelZoom"]', element => element.scrollIntoView({ block: 'center' }));
    assert.equal(await page.$eval('[data-setting="mouseWheelZoom"]', element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: path.join(directory, `${language}-${appearance}-narrow.png`) });
    await page.click('.settings-close');
    if (language === 'en') { await wheel(-100, 'Meta'); await waitSize(11); await waitSaved(11); await owner.setEditorFontSizePreference({ mode: 'custom', value: 10 }); }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await fs.mkdir('.local/font-wheel-acceptance', { recursive: true });
  await page.screenshot({ path: '.local/font-wheel-acceptance/failure.png' });
  console.error(await page.evaluate(() => ({ errors: (window as any).__hostMessages?.slice(-5), menu: document.querySelector('.more-tools-wrapper')?.outerHTML.slice(-2500) })));
  throw error;
} finally { await closeTestBrowser(browser); }
console.log('Editor font wheel production checks passed');
