import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { getPreviewPreset } from '../src/foundation/previewPresets';
import { createPreviewPresetPreferences } from '../src/host/previewPresetPreferences';
import { createCustomPreviewPreset, parseCustomPreviewPresetManifest } from '../src/foundation/customPreviewPreset';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const text = '# Preset memory\n\nInline `npm install` and 中文 `路径`\n\n```typescript\nconst value = 42;\n```\n\n<!-- memory comment -->';
let fontRequests = 0;
let fontFailure = false;
const fonts = [
  { family: 'Arial', aliases: [] }, { family: 'Georgia', aliases: [] }, { family: 'Consolas', aliases: [] },
  { family: 'Microsoft YaHei', aliases: ['微软雅黑'], localizedFamilies: { 'zh-CN': '微软雅黑' } },
  { family: 'SimSun', aliases: [], localizedFamilies: { 'zh-CN': '宋体' } },
  { family: 'Example JP', aliases: ['漢字名'] },
  ...Array.from({ length: 220 }, (_, index) => ({ family: `Example Font ${String(index).padStart(3, '0')}`, aliases: index === 50 ? ['示例字体'] : [] }))
];
let selected: string | undefined;
let preferences: Record<string, any> | undefined;
const custom = createCustomPreviewPreset(parseCustomPreviewPresetManifest({ schemaVersion: 1, id: 'memory', name: 'Memory', description: 'Memory fixture', base: 'default', controls: { fontFamily: { mode: 'editable' } }, themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } } }), { light: ':root { --meo-bg: #fafafa; }', dark: ':root { --meo-bg: #222222; }' }, 'a'.repeat(64));
const createOwner = () => createPreviewPresetPreferences({ readStored: () => preferences, writeStored: async value => { preferences = structuredClone(value); }, getPreset: id => id === custom.id ? custom : getPreviewPreset(id) });
let owner = createOwner();
const defaults = { previewAppearance: 'auto', previewFontFamily: 'Georgia', previewCodeFontFamily: '', previewSourceColoring: true, previewShowComments: false };
const browser = await launchTestBrowser();
try {
  const open = async (state: unknown = {}, editorAppearance = 'dark', uiLanguage = 'en') => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 760 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.exposeFunction('__sendHostMessage', async (message: any) => {
      if (message.type === 'getPreviewFonts') { fontRequests++; return { type: 'previewFontsResult', requestId: message.requestId, result: fontFailure ? { ok: false, error: { code: 'operation-failed', message: 'Unavailable' } } : { ok: true, value: fonts } }; }
      if (message.type === 'setPreviewPreset') selected = message.preset;
      if (message.type === 'setPreviewPresetPreference') {
        await owner.update(message.preset, message.preference, message.initialPreference, message.onlyIfMissing);
      }
      if (message.type === 'requestPreviewRender') return {
        type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
          markdownText: message.text, sourceDocumentPath: 'C:/notes/memory.md', uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth,
          presetDefinition: message.preset === custom.id ? custom : undefined
        }) }
      };
      return null;
    });
    await page.addScriptTag({ content: `
      window.__presetState=${JSON.stringify(state)};window.__presetMessages=[];window.__pendingHostMessages=0;
      window.acquireVsCodeApi=()=>({getState(){return window.__presetState},setState(state){window.__presetState=state},postMessage(message){
        window.__presetMessages.push(message);window.__pendingHostMessages++;
        window.__sendHostMessage(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));}).finally(()=>window.__pendingHostMessages--);
      }});
    ` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), {
      type: 'init', documentId: 'file:///preset-memory.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'preview', uiLanguage, sourceLineNumbers: 'on', ...defaults, editorAppearance,
      previewPreset: selected, previewPresetPreferences: await owner.read(),
      customPreviewPresets: [custom],
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
    });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Preset memory'));
    return page;
  };
  type Page = Awaited<ReturnType<typeof open>>;
  const settle = (page: Page) => page.waitForFunction(() => (window as any).__pendingHostMessages === 0);
  const select = async (page: Page, preset: string) => {
    await page.select('.preview-preset-control select', preset);
    try {
      await page.waitForFunction(preset => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, preset);
    } catch (error) { throw new Error(`Failed to present preset ${preset}`, { cause: error }); }
    await settle(page);
  };
  const controls = (page: Page) => page.evaluate(() => ({
    appearance: document.querySelector<HTMLSelectElement>('.preview-appearance-select')!.value,
    fontFamily: document.querySelector<HTMLSelectElement>('.preview-font-family-control select')!.value,
    sourceColoring: document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')!.value === 'true',
    showComments: document.querySelector('[data-preview-comments="true"]')!.getAttribute('aria-pressed') === 'true'
  }));
  const booleans = async (page: Page, sourceColoring: boolean, showComments: boolean) => {
    if (await page.$eval('.preview-options-panel', element => (element as HTMLElement).hidden)) await page.click('.preview-options-trigger');
    await page.click(`[data-preview-source-coloring="${sourceColoring}"]`);
    await page.click(`[data-preview-comments="${showComments}"]`);
    await settle(page);
  };
  const waitWhitey = (page: Page, appearance: 'light' | 'dark') => page.waitForFunction(appearance => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const root = doc?.querySelector('.meo-export-doc');
    return root && doc!.defaultView!.getComputedStyle(root).backgroundColor === (appearance === 'dark' ? 'rgb(30, 34, 42)' : 'rgb(254, 254, 254)');
  }, {}, appearance);
  const verifyFontPickerViewport = async () => {
    const previousPreset = selected;
    const previousFonts = [defaults.previewFontFamily, defaults.previewCodeFontFamily];
    selected = 'default'; defaults.previewFontFamily = 'Example Font 218'; defaults.previewCodeFontFamily = 'Example Font 219';
    const page = await open({}, 'dark', 'zh-CN');
    const frame = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const chrome = () => page.evaluate(() => {
      const toolbar = document.querySelector('.mode-toolbar')!.getBoundingClientRect();
      return { x: toolbar.x, y: toolbar.y, windowX: scrollX, windowY: scrollY,
        bodyX: document.body.scrollLeft, bodyY: document.body.scrollTop,
        rootY: document.querySelector('.editor-root')!.scrollTop };
    });
    try {
      await settle(page); await page.setViewport({ width: 1100, height: 430 }); await frame();
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('.preview-code-font-family-select')!.options.length > 200);
      for (const mode of ['preview', 'source']) {
        if (mode === 'source') {
          await page.keyboard.press('Escape');
          await page.click('button[data-mode="source"]');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
            && (window as any).__presetMessages.findLast((message: any) => message.type === 'setMode')?.mode === 'source');
          if (await page.$eval('.source-preview-button', el => el.getAttribute('aria-pressed') !== 'true')) await page.click('.source-preview-button');
          await page.waitForFunction(() => document.querySelector('.source-preview-more-panel .preview-preset-control')
            && !document.querySelector<HTMLElement>('.preview-host')!.inert
            && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden');
          await settle(page); await frame();
        }
        await page.select('.preview-font-family-control select', 'Example Font 218');
        await page.select('.preview-code-font-family-control select', 'Example Font 219');
        await settle(page); await frame();
        await page.click(mode === 'preview' ? '.preview-options-trigger' : '.source-preview-more-button');
        const before = await chrome();
        for (const kind of ['font', 'code-font']) {
          const popup = `.preview-${kind}-family-dropdown-panel`;
          const visibleActive = () => page.$eval(popup, panel => {
            const results = panel.querySelector<HTMLElement>('.preview-font-results')!;
            const active = results.querySelector('.is-active')!.getBoundingClientRect();
            const bounds = results.getBoundingClientRect();
            const top = bounds.top + results.clientTop;
            return active.top >= top - 1 && active.bottom <= top + results.clientHeight + 1;
          });
          await page.click(`.preview-${kind}-family-dropdown`); await frame();
          assert.deepEqual(await chrome(), before, `${mode} ${kind}: opening the font list keeps toolbar and outer scroll positions`);
          assert.equal(await visibleActive(), true, `${mode} ${kind}: the restored late-catalog selection is visible after popup sizing`);
          await page.keyboard.press('ArrowDown'); await frame();
          assert.equal(await visibleActive(), true, `${mode} ${kind}: keyboard comparison scrolls the results only`);
          await page.keyboard.press('Enter'); await settle(page); await frame();
          assert.deepEqual(await chrome(), before, `${mode} ${kind}: font comparison keeps the toolbar fixed`);
          await page.type(`${popup} input`, 'Arial'); await page.keyboard.press('Enter'); await settle(page);
          await page.click(`${popup} .preview-font-clear`); await frame();
          assert.equal(await visibleActive(), true, `${mode} ${kind}: clearing the filter reveals the selected font`);
          assert.deepEqual(await chrome(), before, `${mode} ${kind}: filtering keeps outer scroll positions`);
          await page.keyboard.press('Escape'); await frame();
          assert.deepEqual(await chrome(), before, `${mode} ${kind}: closing leaves the toolbar at its original position`);
        }
      }
    } finally {
      await page.close(); selected = previousPreset;
      [defaults.previewFontFamily, defaults.previewCodeFontFamily] = previousFonts;
    }
  };
  const verifyFontPicker = async () => {
    selected = 'whitey';
    preferences!.whitey.fontFamily = 'Missing Font';
    owner = createOwner();
    const fontPage = await open();
    assert.equal(fontRequests, 0, 'Opening documents never enumerates fonts');
    assert.equal(await fontPage.$$eval('.preview-font-results button', rows => rows.length), 0,
      'Unopened font popups must not build comparison rows during document startup');
    await fontPage.click('.preview-options-trigger');
    await fontPage.click('.preview-font-family-dropdown');
    await fontPage.waitForFunction(() => document.querySelector<HTMLSelectElement>('.preview-font-family-select')!.options.length > 200);
    assert.equal(fontRequests, 1);
    assert.equal(await fontPage.$$eval('.preview-code-font-family-dropdown-panel .preview-font-results button', rows => rows.length), 0,
      'Catalog arrival builds rows only for the open font popup');
    const popup = '.preview-font-family-dropdown-panel';
    const search = `${popup} input`;
    assert.equal(await fontPage.$eval(`${popup} .preview-font-reset`, el => el.textContent), 'Default');
    assert.equal(await fontPage.$eval(`${popup} .preview-font-refresh`, el => el.textContent), 'Refresh');
    assert.deepEqual(await fontPage.$$eval(`${popup} .preview-font-search-row .preview-font-action`, els => els.map(el => el.getAttribute('aria-label'))), ['Reset font', 'Refresh font list'], 'Compact search actions retain their full accessible names');
    assert.equal(await fontPage.$eval(`${popup} [data-value="Missing Font"] .preview-font-missing`, el => el.textContent), 'Not found in the font list');
    await fontPage.type(search, '不存在的字体');
    assert.equal(await fontPage.$eval(`${popup} .preview-font-reset`, el => (el as HTMLElement).offsetHeight > 0), true);
    assert.equal(await fontPage.$$eval(`${popup} .preview-font-results button`, els => els.length), 0);
    const before = await fontPage.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).value);
    await fontPage.keyboard.press('Enter');
    assert.equal(await fontPage.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).value), before, 'No results does not submit the search text or reset to default');
    await fontPage.click(search, { clickCount: 3 }); await fontPage.keyboard.press('Backspace');
    await fontPage.type(search, '示例字体');
    assert.equal(await fontPage.$$eval(`${popup} .preview-font-results button`, els => els.length), 1, 'Localized aliases are searchable');
    await fontPage.$eval(search, element => {
      (element as HTMLInputElement).setSelectionRange(1, 3, 'backward');
      window.dispatchEvent(new Event('blur'));
      (element as HTMLElement).blur();
      window.dispatchEvent(new Event('focus'));
    });
    await fontPage.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, search);
    assert.deepEqual(await fontPage.$eval(search, element => {
      const input = element as HTMLInputElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection];
    }), [1, 3, 'backward'], 'Font search restores its own selection on window return');
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false);

    await fontPage.$eval(search, el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await fontPage.keyboard.press('Enter');
    assert.equal(await fontPage.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).value), before, 'IME confirmation never selects a font');
    await fontPage.$eval(search, el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await fontPage.click(`${popup} .preview-font-clear`);
    assert.equal(await fontPage.$eval(search, el => (el as HTMLInputElement).value), '');
    assert.equal(await fontPage.$eval(search, el => el === document.activeElement), true);
    assert.equal(await fontPage.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).value), before, 'Clearing the search never changes the saved font');
    assert.equal(await fontPage.$eval(`${popup} .preview-font-clear`, el => (el as HTMLElement).hidden), true);
    const pinnedTop = await fontPage.$eval(`${popup} .preview-font-actions`, el => el.getBoundingClientRect().top);
    await fontPage.$eval(`${popup} .preview-font-results`, el => { el.scrollTop = el.scrollHeight; });
    assert.equal(await fontPage.$eval(`${popup} .preview-font-actions`, el => el.getBoundingClientRect().top), pinnedTop, 'Both search actions stay visible while results scroll');
    await fontPage.screenshot({ path: 'tmp/preview-font-picker-large.png' });
    await fontPage.type(search, 'Example Font');
    await fontPage.$eval(`${popup} [data-value="Example Font 050"]`, el => el.scrollIntoView({ block: 'center' }));
    const scrollTop = await fontPage.$eval(`${popup} .preview-font-results`, el => el.scrollTop);
    await fontPage.click(`${popup} [data-value="Example Font 050"]`); await settle(fontPage);
    await fontPage.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-doc')!).fontFamily.startsWith('"Example Font 050"');
    });
    assert.equal(preferences!.whitey.fontFamily, 'Example Font 050');
    assert.equal(await fontPage.$eval(popup, el => (el as HTMLElement).hidden), false, 'Choosing a font keeps the comparison list open');
    assert.equal(await fontPage.$eval(search, el => (el as HTMLInputElement).value), 'Example Font', 'Choosing preserves the filter');
    assert.equal(await fontPage.$eval(search, el => el === document.activeElement), true, 'Choosing returns keyboard focus to search');
    assert.equal(await fontPage.$eval(`${popup} .preview-font-results`, el => el.scrollTop), scrollTop, 'Choosing preserves the visible comparison rows');
    await fontPage.keyboard.press('ArrowDown'); await fontPage.keyboard.press('Enter'); await settle(fontPage);
    assert.equal(preferences!.whitey.fontFamily, 'Example Font 051', 'Keyboard comparison continues from the newly selected row');
    assert.equal(await fontPage.$eval(popup, el => (el as HTMLElement).hidden), false);
    await fontPage.click(`${popup} .preview-font-clear`);
    await fontPage.type(search, 'Arial'); await fontPage.keyboard.press('Enter');
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false);
    await fontPage.keyboard.press('Escape');
    await fontPage.click('.preview-code-font-family-dropdown');
    assert.equal(fontRequests, 1, 'Both font pickers share the catalog');
    await fontPage.type('.preview-code-font-family-dropdown-panel input', 'Consolas');
    await fontPage.keyboard.press('Enter'); await settle(fontPage);
    await fontPage.keyboard.press('Escape');
    for (const [kind, key, family, otherKey, otherFamily] of [
      ['font', 'fontFamily', 'Arial', 'codeFontFamily', 'Consolas'],
      ['code-font', 'codeFontFamily', 'Consolas', 'fontFamily', 'Arial']
    ]) {
      const panel = `.preview-${kind}-family-dropdown-panel`;
      if (await fontPage.$eval(panel, el => (el as HTMLElement).hidden)) await fontPage.click(`.preview-${kind}-family-dropdown`);
      if (await fontPage.$eval(`${panel} .preview-font-clear`, el => !(el as HTMLElement).hidden)) await fontPage.click(`${panel} .preview-font-clear`);
      await fontPage.type(`${panel} input`, '不存在的字体');
      if (kind === 'font') {
        await fontPage.keyboard.press('Tab');
        assert.equal(await fontPage.$eval(`${panel} .preview-font-clear`, el => el === document.activeElement), true, 'Clear search is keyboard accessible');
        await fontPage.keyboard.press('Tab');
        assert.equal(await fontPage.$eval(`${panel} .preview-font-reset`, el => el === document.activeElement), true, 'Reset follows clear search');
        await fontPage.keyboard.press('Enter');
      } else await fontPage.click(`${panel} .preview-font-reset`);
      await settle(fontPage);
      assert.equal(preferences!.whitey[key], '', `${kind} reset restores the preset font even when search has no results`);
      assert.equal(preferences!.whitey[otherKey], otherFamily, 'Reset leaves the other font preference intact');
      assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false);
      assert.equal(await fontPage.$eval(panel, el => (el as HTMLElement).hidden), false, 'Reset keeps the list open for comparison with preset typography');
      assert.equal(await fontPage.$eval(`${panel} .preview-font-reset`, el => (el as HTMLButtonElement).disabled), true, 'Already using the default font disables reset');
      await fontPage.click(`${panel} .preview-font-clear`);
      await fontPage.type(`${panel} input`, family); await fontPage.keyboard.press('Enter'); await settle(fontPage);
      await fontPage.keyboard.press('Escape');
    }
    const readTypography = () => fontPage.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const style = (selector: string) => doc.defaultView!.getComputedStyle(doc.querySelector(selector)!);
      return { inline: style('p code').fontSize, block: style('pre code').fontSize, inlineHeight: style('p code').lineHeight, paragraphHeight: style('p').lineHeight };
    });
    for (const preset of ['default', 'newsprint', 'whitey', 'obsidian-minimal', custom.id]) {
      await select(fontPage, preset);
      await fontPage.select('.preview-font-family-select', 'Arial');
      const beforeTypography = await readTypography();
      await fontPage.select('.preview-code-font-family-select', 'Consolas');
      await fontPage.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const styles = (el: Element) => doc.defaultView!.getComputedStyle(el);
        return styles(doc.querySelector('.meo-export-doc')!).fontFamily.startsWith('Arial')
          && [...doc.querySelectorAll('code')].every(code => styles(code).fontFamily.startsWith('Consolas'));
      });
      const typography = await readTypography();
      assert.equal(typography.inlineHeight, typography.paragraphHeight, `${preset} inline code stays in paragraph line flow`);
      assert.deepEqual(typography, beforeTypography, `${preset} font changes preserve each code surface's typography`);
    }
    await select(fontPage, 'github-readme');
    for (const kind of ['font', 'code-font']) {
      assert.equal(await fontPage.$eval(`.preview-${kind}-family-control`, el => (el as HTMLElement).hidden), false);
      assert.equal(await fontPage.$eval(`.preview-${kind}-family-dropdown`, el => (el as HTMLButtonElement).disabled), true, 'Fixed fonts remain visible and disabled');
      assert.equal(await fontPage.$eval(`.preview-${kind}-family-dropdown-panel`, el => (el as HTMLElement).hidden), true, 'Switching to a fixed preset closes any font comparison');
    }
    await select(fontPage, 'whitey');
    if (await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden)) await fontPage.click('.preview-options-trigger');
    await fontPage.click('.preview-font-family-dropdown');
    fontFailure = true; await fontPage.click(`${popup} .preview-font-refresh`);
    await settle(fontPage);
    assert.ok(await fontPage.$eval(`${popup} [role="status"]`, el => el.textContent?.includes('unavailable')));
    assert.ok(await fontPage.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).options.length > 200), 'Failed refresh preserves a successful list');
    fontFailure = false;
    await fontPage.keyboard.press('Escape');
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false);
    await fontPage.keyboard.press('Escape');
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), true);
    await fontPage.click('button[data-mode="source"]');
    await fontPage.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
      && (window as any).__presetMessages.findLast((message: any) => message.type === 'setMode')?.mode === 'source');
    if (await fontPage.$eval('.source-preview-button', el => el.getAttribute('aria-pressed') !== 'true')) await fontPage.click('.source-preview-button');
    await fontPage.waitForFunction(() => document.querySelector('.source-preview-more-panel .preview-preset-control')
      && !document.querySelector<HTMLElement>('.preview-host')!.inert
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden');
    await fontPage.click('.source-preview-more-button');
    await fontPage.click('.preview-code-font-family-dropdown');
    await fontPage.type('.preview-code-font-family-dropdown-panel input', 'Arial');
    await fontPage.click('.preview-code-font-family-dropdown-panel [data-value="Arial"]');
    await settle(fontPage);
    await fontPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false, 'The first Source font change keeps its options panel open through toolbar synchronization');
    assert.equal(await fontPage.$eval('.preview-code-font-family-dropdown-panel', el => (el as HTMLElement).hidden), false);
    await fontPage.keyboard.press('Escape');
    await select(fontPage, 'github-readme');
    if (await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden)) await fontPage.click('.source-preview-more-button');
    assert.equal(await fontPage.$$eval('.source-preview-more-panel .preview-select-control', els => els.some(el => (el as HTMLElement).hidden)), false, 'Split Preview shows the same preset configuration items');
    assert.equal(await fontPage.$eval('.preview-code-font-family-control', el => (el as HTMLElement).offsetHeight > 0), true);
    assert.equal(await fontPage.$eval('.preview-font-family-dropdown', el => (el as HTMLButtonElement).disabled), true);
    await select(fontPage, 'whitey');
    if (await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden)) await fontPage.click('.source-preview-more-button');
    await fontPage.waitForSelector('.preview-code-font-family-dropdown', { visible: true });
    await fontPage.click('.preview-code-font-family-dropdown');
    const splitPopup = '.preview-code-font-family-dropdown-panel';
    const splitLeft = await fontPage.$eval(splitPopup, el => el.getBoundingClientRect().left);
    await fontPage.type(`${splitPopup} input`, 'Example Font 050');
    await fontPage.keyboard.press('Enter'); await settle(fontPage);
    assert.equal(preferences!.whitey.codeFontFamily, 'Example Font 050');
    assert.equal(await fontPage.$eval(splitPopup, el => el.getBoundingClientRect().left), splitLeft, 'A longer font name must not move the open comparison list');
    await fontPage.click(`${splitPopup} .preview-font-clear`);
    await fontPage.type(`${splitPopup} input`, 'Arial');
    await fontPage.keyboard.press('Enter'); await settle(fontPage);
    assert.equal(preferences!.whitey.codeFontFamily, 'Arial');
    assert.equal(await fontPage.$eval(splitPopup, el => el.getBoundingClientRect().left), splitLeft, 'A shorter font name keeps the same horizontal anchor');
    await fontPage.keyboard.press('Escape');
    await fontPage.click('.preview-code-font-family-dropdown');
    assert.equal(await fontPage.$eval(splitPopup, el => el.getBoundingClientRect().left), await fontPage.evaluate(() => {
      const control = document.querySelector('.preview-code-font-family-dropdown')!.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>('.preview-code-font-family-dropdown-panel')!;
      return Math.max(8, Math.min(control.left, window.innerWidth - panel.offsetWidth - 8));
    }), 'Reopening anchors to the current control position');
    await fontPage.type(`${splitPopup} input`, 'Consolas');
    await fontPage.mouse.move(2, 400);
    assert.equal(await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false, 'Split Preview keeps the search open after pointer exit');
    await fontPage.setViewport({ width: 420, height: 700 });
    await fontPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (await fontPage.$eval('.preview-options-panel', el => (el as HTMLElement).hidden)) await fontPage.click('.source-preview-more-button');
    if (await fontPage.$eval('.preview-code-font-family-dropdown-panel', el => (el as HTMLElement).hidden)) await fontPage.click('.preview-code-font-family-dropdown');
    await fontPage.type('.preview-code-font-family-dropdown-panel input', 'Consolas');
    assert.equal(await fontPage.$eval('.preview-code-font-family-dropdown-panel', el => (el as HTMLElement).hidden), false);
    await fontPage.screenshot({ path: 'tmp/preview-font-picker-narrow.png' });
    await fontPage.close();
  };
  const verifyLocalizedFontNames = async () => {
    selected = 'whitey';
    const page = await open({}, 'light', 'zh-CN');
    const openPicker = async (kind: 'font' | 'code-font') => {
      if (await page.$eval('.preview-options-panel', element => (element as HTMLElement).hidden)) await page.click('.preview-options-trigger');
      await page.click(`.preview-${kind}-family-dropdown`);
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('.preview-font-family-select')!.options.length > 200);
      return `.preview-${kind}-family-dropdown-panel`;
    };
    const popup = await openPicker('font');
    assert.equal(await page.$eval(`${popup} [data-value="Microsoft YaHei"] .preview-font-option-name`, el => el.textContent), '微软雅黑');
    assert.equal(await page.$eval(`${popup} [data-value="Arial"] .preview-font-option-name`, el => el.textContent), 'Arial', 'Families without a Chinese name retain their original name');
    assert.equal(await page.$eval(`${popup} [data-value="Example JP"] .preview-font-option-name`, el => el.textContent), 'Example JP', 'Unlabelled Han aliases are not assumed to be Chinese');
    for (const query of ['Microsoft YaHei', '微软雅黑']) {
      await page.click(`${popup} input`, { clickCount: 3 }); await page.keyboard.press('Backspace');
      await page.type(`${popup} input`, query);
      assert.deepEqual(await page.$$eval(`${popup} .preview-font-results button`, els => els.map(el => [el.getAttribute('data-value'), el.textContent])), [['Microsoft YaHei', '微软雅黑']], `Chinese UI finds the same canonical family using ${query}`);
    }
    await page.keyboard.press('Enter'); await settle(page);
    assert.equal(preferences!.whitey.fontFamily, 'Microsoft YaHei', 'Choosing a Chinese label persists the canonical family');
    assert.equal(await page.$eval('.preview-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), '微软雅黑');
    await page.keyboard.press('Escape');
    const codePopup = await openPicker('code-font');
    await page.type(`${codePopup} input`, '宋体'); await page.keyboard.press('Enter'); await settle(page);
    assert.equal(preferences!.whitey.codeFontFamily, 'SimSun', 'Code fonts use the same localized labels and canonical persistence');
    const language = async (value: string) => {
      await page.click('.more-tools-wrapper > .format-button');
      await page.click(`.ui-language-button[data-ui-language="${value}"]`);
      await page.click('.more-tools-wrapper > .format-button');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    };
    await language('en');
    assert.equal(await page.$eval('.preview-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), 'Microsoft YaHei');
    assert.equal(await page.$eval('.preview-code-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), 'SimSun');
    await openPicker('font'); await page.type(`${popup} input`, '微软雅黑');
    assert.deepEqual(await page.$$eval(`${popup} .preview-font-results button`, els => els.map(el => [el.getAttribute('data-value'), el.textContent])), [['Microsoft YaHei', 'Microsoft YaHei']], 'Chinese names remain searchable in English UI');
    await page.keyboard.press('Escape');
    await language('zh-CN');
    assert.equal(await page.$eval('.preview-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), '微软雅黑');
    assert.equal(await page.$eval('.preview-code-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), '宋体');
    await page.close();
    owner = createOwner();
    const requestsBeforeReopen = fontRequests;
    const reopened = await open({}, 'dark', 'zh-CN');
    await reopened.waitForFunction(() => document.querySelector('.preview-font-family-dropdown .preview-toolbar-dropdown-value')!.textContent === '微软雅黑'
      && document.querySelector('.preview-code-font-family-dropdown .preview-toolbar-dropdown-value')!.textContent === '宋体', { timeout: 2000 });
    assert.equal(await reopened.$eval('.preview-font-family-dropdown-panel', el => (el as HTMLElement).hidden), true, 'Restored localized labels do not require opening either picker');
    assert.equal(fontRequests, requestsBeforeReopen + 1, 'Both restored font labels share one catalog query');
    assert.equal(await reopened.evaluate(() => (window as any).__presetMessages.some((message: any) => ['setPreviewFontFamily', 'setPreviewCodeFontFamily', 'setPreviewPresetPreference'].includes(message.type))), false, 'Resolving labels never rewrites saved font identifiers');
    await reopened.click('.preview-options-trigger'); await reopened.click('.preview-font-family-dropdown');
    await reopened.waitForFunction(() => document.querySelector('.preview-font-family-dropdown .preview-toolbar-dropdown-value')!.textContent === '微软雅黑');
    assert.equal(await reopened.$eval('.preview-font-family-select', el => (el as HTMLSelectElement).value), 'Microsoft YaHei');
    assert.equal(await reopened.$eval('.preview-code-font-family-dropdown .preview-toolbar-dropdown-value', el => el.textContent), '宋体', 'Reopened documents restore both localized labels');
    await reopened.keyboard.press('Escape');
    await reopened.click('button[data-mode="source"]');
    await reopened.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
      && (window as any).__presetMessages.findLast((message: any) => message.type === 'setMode')?.mode === 'source');
    if (await reopened.$eval('.source-preview-button', el => el.getAttribute('aria-pressed') !== 'true')) await reopened.click('.source-preview-button');
    await reopened.waitForFunction(() => document.querySelector('.source-preview-more-panel .preview-preset-control') && !document.querySelector<HTMLElement>('.preview-host')!.inert);
    await reopened.click('.source-preview-more-button'); await reopened.click('.preview-code-font-family-dropdown');
    await reopened.type('.preview-code-font-family-dropdown-panel input', 'Arial');
    await reopened.click('.preview-code-font-family-dropdown-panel [data-value="Arial"]'); await settle(reopened);
    await reopened.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await reopened.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false, 'Chinese Source keeps its panel open when the first font change refreshes the toolbar layout');
    assert.equal(await reopened.$eval('.preview-code-font-family-dropdown-panel', el => (el as HTMLElement).hidden), false);
    await reopened.close();
    const requestsBeforeDefaults = fontRequests;
    selected = 'whitey'; preferences!.whitey.fontFamily = ''; preferences!.whitey.codeFontFamily = ''; owner = createOwner();
    const originalFonts = await open({}, 'light', 'zh-CN'); await settle(originalFonts);
    assert.equal(fontRequests, requestsBeforeDefaults, 'Preset typography without overrides remains lazy');
    await originalFonts.close();
    selected = 'github-readme';
    const fixedFonts = await open({}, 'light', 'zh-CN'); await settle(fixedFonts);
    assert.equal(fontRequests, requestsBeforeDefaults, 'Fixed fonts do not enumerate the catalog while initialization applies Default settings');
    await fixedFonts.close();
  };
  const page = await open();
  for (const id of ['default', 'github-readme', 'newsprint', 'obsidian-minimal', custom.id, 'whitey']) {
    await select(page, id);
    assert.equal((await controls(page)).appearance, id === 'newsprint' ? 'light' : 'auto', `${id} derives its initial appearance from theme support`);
  }
  await waitWhitey(page, 'dark');
  const staleState = await page.evaluate(() => (window as any).__presetState);
  await page.click('[data-preview-appearance-choice="dark"]');
  await page.select('.preview-font-family-control select', 'Arial');
  await page.select('.preview-code-font-family-control select', 'Georgia');
  await booleans(page, false, true);
  const whitey = { appearance: 'dark', fontFamily: 'Arial', sourceColoring: false, showComments: true };
  assert.deepEqual(await controls(page), whitey);
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-comment'));
  await select(page, 'obsidian-minimal');
  await page.select('.preview-font-family-control select', 'Georgia');
  await page.click('[data-preview-appearance-choice="light"]');
  await booleans(page, true, false);
  await select(page, custom.id);
  await page.select('.preview-font-family-control select', 'Arial');
  await page.click('[data-preview-appearance-choice="light"]');
  await booleans(page, false, true);
  await select(page, 'default');
  assert.deepEqual(await controls(page), { appearance: 'auto', fontFamily: 'Georgia', sourceColoring: true, showComments: false }, 'Preset edits leave Default settings intact');
  await select(page, 'obsidian-minimal');
  assert.deepEqual(await controls(page), { appearance: 'light', fontFamily: 'Georgia', sourceColoring: true, showComments: false });
  await select(page, 'newsprint');
  await page.select('.preview-font-family-control select', 'Arial');
  await booleans(page, false, true);
  await select(page, 'github-readme');
  await page.click('[data-preview-appearance-choice="light"]');
  await settle(page);
  await select(page, 'whitey');
  assert.deepEqual(await controls(page), whitey, 'Every editable setting survives switching away and back');
  assert.equal(await page.evaluate(() => (window as any).__presetMessages.some((message: any) => ['setPreviewFontFamily', 'setPreviewSourceColoring', 'setPreviewShowComments', 'setPreviewAppearance'].includes(message.type))), false, 'Non-default edits never write Default settings');
  await page.close();
  owner = createOwner();
  const reopened = await open();
  assert.equal(await reopened.$eval('.preview-appearance-select', el => (el as HTMLSelectElement).value), 'dark',
    'Whitey appearance survives closing the file and opening another document without its Webview cache');
  assert.equal(await reopened.$eval('.preview-font-family-control select', el => (el as HTMLSelectElement).value), 'Arial');
  assert.equal(await reopened.$eval('.preview-source-coloring-select', el => (el as HTMLSelectElement).value), 'false');
  assert.deepEqual(await controls(reopened), whitey);
  assert.equal(await reopened.$eval('.preview-code-font-family-control select', el => (el as HTMLSelectElement).value), 'Georgia', 'Code font survives new documents independently of body font');
  await select(reopened, custom.id);
  assert.deepEqual(await controls(reopened), { ...whitey, appearance: 'light' }, 'Custom preset settings also survive a new document');
  await select(reopened, 'obsidian-minimal');
  assert.deepEqual(await controls(reopened), { appearance: 'light', fontFamily: 'Georgia', sourceColoring: true, showComments: false });
  await select(reopened, 'newsprint');
  assert.deepEqual(await controls(reopened), { ...whitey, appearance: 'light' }, 'Single-theme preset font and switches survive a new document');
  await select(reopened, 'github-readme');
  assert.equal((await controls(reopened)).appearance, 'light', 'GitHub retains its selected appearance across documents');
  await select(reopened, 'whitey');
  await reopened.close();
  const stale = await open(staleState);
  assert.deepEqual(await controls(stale), whitey, 'Host preferences take precedence over stale per-document caches');
  await stale.close();
  const corrupt = await open({ previewPresetState: { preset: 'invalid', preferences: { unknown: { appearance: 'dark', contentWidth: 'responsive' } } } });
  assert.deepEqual(await controls(corrupt), whitey, 'Invalid legacy cache cannot suppress valid Host preferences');
  await corrupt.close();
  const light = await open({}, 'light');
  await light.click('[data-preview-appearance-choice="auto"]');
  await settle(light);
  await waitWhitey(light, 'light');
  await light.close();
  const dark = await open();
  assert.equal((await controls(dark)).appearance, 'auto', 'Saved Auto remains Auto in a new document');
  await waitWhitey(dark, 'dark');
  await dark.close();
  preferences = undefined;
  selected = undefined;
  owner = createOwner();
  const legacy = await open({ previewPresetState: { preset: 'whitey', preferences: { whitey: { appearance: 'dark', contentWidth: 'responsive', fontFamily: 'Arial' } } } });
  await settle(legacy);
  assert.equal((await controls(legacy)).appearance, 'dark');
  await legacy.close();
  const migrated = await open();
  assert.equal((await controls(migrated)).fontFamily, 'Arial', 'Legacy per-document preferences migrate once to Host storage');
  await migrated.close();
  const otherLegacy = await open({ previewPresetState: { preset: 'obsidian-minimal', preferences: { 'obsidian-minimal': { appearance: 'light', contentWidth: 'responsive', fontFamily: 'Georgia' } } } });
  await settle(otherLegacy);
  await otherLegacy.close();
  defaults.previewSourceColoring = false;
  defaults.previewShowComments = true;
  const otherMigrated = await open();
  await select(otherMigrated, 'obsidian-minimal');
  assert.equal((await controls(otherMigrated)).fontFamily, 'Georgia', 'Legacy migration fills missing presets even when Host remembers another preset');
  assert.deepEqual(await controls(otherMigrated), { appearance: 'light', fontFamily: 'Georgia', sourceColoring: true, showComments: false }, 'Legacy migration snapshots shared switches before later Default changes');
  await otherMigrated.close();
  await verifyFontPicker();
  await verifyLocalizedFontNames();
  await verifyFontPickerViewport();
  console.log('Preview preset preferences: built-in/custom defaults, switches, new documents, stale caches, Auto and legacy migration passed.');
} finally {
  await browser.close();
}
