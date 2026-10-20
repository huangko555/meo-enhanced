import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
const artifacts = path.resolve('.local/html-completion-acceptance');
let step = 'initial';
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, marked = '<div |></div>', input = {}) => {
    await page.evaluate(({ mode, marked, input }) => {
      const g = window as any, position = marked.indexOf('|');
      g.editor?.destroy();
      g.editor = g.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!,
        text: marked.replace('|', ''), initialMode: mode, initialCursorPos: position,
        initialInputAssistance: input, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: position } }); g.editor.view.focus();
    }, { mode, marked, input: { ...defaultInputAssistance, ...input } });
  };
  const menu = '.meo-html-suggestions:not([hidden])';
  const open = () => page.waitForSelector(menu, { timeout: 3000 });
  const closed = () => page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])'), { timeout: 2000 });
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const manual = async () => { await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control'); };
  const choose = async (label: string) => {
    await open();
    await page.evaluate(label => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('.meo-html-suggestions .meo-input-suggestion')]
        .find(row => row.querySelector('.meo-suggestion-label')?.textContent === label);
      if (!row) throw new Error('Missing HTML candidate: ' + label);
      row.click();
    }, label);
    await closed();
  };
  for (const mode of ['source', 'live']) {
    step = mode + ': attributes and history';
    await prepare(mode); await page.keyboard.type('ti'); await open();
    assert.equal(await page.$eval(menu + ' [aria-selected="true"] .meo-suggestion-label', node => node.textContent), 'title');
    assert.equal(await page.$('.cm-tooltip-autocomplete'), null, 'only the shared menu owns HTML completion');
    await page.keyboard.press('Enter'); await closed();
    assert.equal(await text(), '<div title></div>');
    await page.evaluate(() => (window as any).editor.undo());
    assert.equal(await text(), '<div ti></div>', 'one undo restores the typed prefix');
    await page.evaluate(() => (window as any).editor.redo());
    assert.equal(await text(), '<div title></div>');

    step = mode + ': attribute values and Tab';
    await prepare(mode, '<div dir="|"></div>');
    await page.keyboard.type('r'); await open(); await page.keyboard.press('Tab'); await closed();
    assert.equal(await text(), '<div dir="rtl"></div>', 'enumerated values retain existing quotes');

    step = mode + ': explicit completion and Escape';
    await prepare(mode, '<div ti|></div>'); await manual(); await open();
    const before = await text();
    await page.keyboard.press('Escape'); await closed();
    assert.equal(await text(), before);
    assert.equal(await page.evaluate(() => (window as any).editor.view.state.selection.main.head), 7, 'Escape dismisses without moving the HTML caret');
    await manual(); await choose('title');
    assert.equal(await text(), '<div title></div>');

    step = mode + ': disabled and live reconfiguration';
    await prepare(mode, '<div |></div>', { html: false }); await page.keyboard.type('ti'); await manual();
    await new Promise(resolve => setTimeout(resolve, 160)); await closed();
    assert.equal(await text(), '<div ti></div>');
    await page.evaluate(defaults => (window as any).editor.setInputAssistance(defaults), defaultInputAssistance);
    await manual(); await open();
    await page.evaluate(defaults => (window as any).editor.setInputAssistance({ ...defaults, html: false }), defaultInputAssistance);
    await closed();
    await prepare(mode, '<div|', { html: false }); await page.keyboard.type('>');
    assert.equal(await text(), '<div></div>', 'disabling candidates preserves automatic tag closing');

    step = mode + ': closing tags';
    await prepare(mode, '<div>\n</|'); await manual(); await choose('div');
    assert.equal(await text(), '<div>\n</div>');

    step = mode + ': tags in HTML code and ordinary prose';
    await prepare(mode, '```html\n<di|\n```'); await page.keyboard.type('v'); await choose('div');
    assert.equal(await text(), '```html\n<div\n```');
    await page.keyboard.type('>');
    assert.equal(await text(), '```html\n<div></div>\n```', 'automatic closing stays independent of the menu');
    await prepare(mode, 'Plain text |'); await page.keyboard.type('<d'); await manual();
    await new Promise(resolve => setTimeout(resolve, 160)); await closed();

    step = mode + ': IME ownership';
    await prepare(mode); await page.keyboard.type('ti'); await open();
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 0, selectionEnd: 5 });
    const beforeImeEnter = await text();
    await page.evaluate(() => (window as any).editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await text(), beforeImeEnter, 'IME confirmation never accepts an HTML candidate');
    assert.equal(await page.$eval(menu + ' [aria-selected="true"] .meo-suggestion-label', node => node.textContent), 'title');
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await ime.detach();
    await page.waitForFunction(() => !(window as any).editor.view.compositionStarted);
    await manual();
    await choose('title');
  }
  await fs.mkdir(artifacts, { recursive: true });
  for (const language of ['zh-CN', 'en']) for (const appearance of ['light', 'dark']) {
    step = language + '/' + appearance + ': shared placement and visual smoke';
    await prepare('source', 'First paragraph\n\n<div |></div>', { slashPreferAbove: true });
    await page.evaluate(({ language, appearance }) => {
      const g = window as any;
      document.documentElement.dataset.editorAppearance = appearance;
      g.editor.setUiLanguage(language);
      g.EditingFeaturesHarness.applyUiTheme(appearance, false);
    }, { language, appearance });
    // Place the input low enough to exercise the preferred side without a fallback.
    await page.addStyleTag({ content: '.cm-content{padding-top:340px!important}' });
    await page.keyboard.type('ti'); await open();
    const geometry = await page.evaluate(() => {
      const view = (window as any).editor.view, popup = document.querySelector<HTMLElement>('.meo-html-suggestions')!;
      const bounds = popup.getBoundingClientRect(), caret = view.coordsAtPos(view.state.selection.main.head);
      const selected = popup.querySelector('[aria-selected="true"]')!;
      return { top: bounds.top, bottom: bounds.bottom, caretTop: caret.top,
        rowHeight: selected.getBoundingClientRect().height, radius: getComputedStyle(popup).borderRadius,
        detail: selected.querySelector('.meo-input-suggestion-detail')?.textContent };
    });
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.caretTop, 'HTML obeys the shared above preference');
    assert.equal(geometry.radius, '10px');
    assert.equal(geometry.rowHeight, 28);
    assert.equal(geometry.detail, language === 'zh-CN' ? '属性' : 'Attribute');
    const selected = () => page.$eval(menu + ' [aria-selected="true"]', node => Number((node as HTMLElement).dataset.suggestionIndex));
    await page.keyboard.press('ArrowUp'); assert.equal(await selected(), 1, 'above-menu arrows follow the visible order');
    await page.keyboard.press('ArrowDown'); assert.equal(await selected(), 0);
    await page.screenshot({ path: path.join(artifacts, language + '-' + appearance + '.png') });
    await page.keyboard.press('Escape'); await closed();
    await page.setViewport({ width: 360, height: 640 });
    await manual(); await open();
    assert.ok(await page.$eval(menu, node => { const bounds = node.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth; }), 'narrow menu stays in the viewport');
    await page.screenshot({ path: path.join(artifacts, language + '-' + appearance + '-narrow.png') });
    await page.setViewport({ width: 1000, height: 720 });
  }
  assert.deepEqual(errors, []);
  console.log('HTML shared suggestion menu contracts passed; screenshots: ' + artifacts);
} catch (error) {
  console.error('HTML completion step:', step);
  console.error(await page.evaluate(() => ({ text: (window as any).editor?.getText(), menu: document.querySelector('.meo-input-suggestions')?.outerHTML.slice(0, 2000) })));
  throw error;
} finally {
  await closeTestBrowser(browser);
}
