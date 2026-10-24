import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { createAppearanceSettingsOwner, type AppearanceSettingsStore } from '../src/host/appearanceSettings';
import { decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { UpdateUiColorsRequest, UiColorsResult } from '../src/protocol/uiColors';

const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const configuration = new Map<string, unknown>();
let fail = false;
const store: AppearanceSettingsStore = {
  readConfiguration: key => ({ value: configuration.get(key), explicit: configuration.has(key), globalValue: configuration.get(key) }),
  updateConfiguration: async (key, value) => { if (fail) throw new Error('fixture write failure'); configuration.set(key, value); },
  readLegacy: () => undefined, updateLegacy: async () => {}
};
const owner = await createAppearanceSettingsOwner(store);
const browser = await launchTestBrowser(); const page = await browser.newPage();
const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
try {
  await page.exposeFunction('__saveColors', async (input: UpdateUiColorsRequest): Promise<UiColorsResult> => {
    const request = decodeWebviewToHostMessage(input);
    assert.equal(request?.type, 'updateUiColors');
    try { return { type: 'uiColorsResult', requestId: input.requestId, result: { ok: true, value: await owner.setUiColors(input.colors) } }; }
    catch (error) { return { type: 'uiColorsResult', requestId: input.requestId, result: { ok: false, error: { code: 'operation-failed', message: String(error) } } }; }
  });
  await page.exposeFunction('__savedColors', () => owner.getUiColors());
  const openFixture = async () => {
    await page.setViewport({ width: 1100, height: 820 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark"><div id="app"></div></body>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: ':root{--vscode-editor-background:#22272e;--vscode-editorWidget-background:#22272e;--vscode-foreground:#e5e5e5;--vscode-editor-foreground:#ddd;--vscode-textLink-foreground:#79b8ff;--vscode-button-background:#2472c8;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}' });
    await page.addScriptTag({ content: `
      window.__messages=[];
      window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
        window.__messages.push(message);
        if(message.type==='updateUiColors') {
          window.__saveColors(message).then(response=>{
            const reply=()=>{ if(response.result.ok) window.dispatchEvent(new MessageEvent('message',{data:{type:'uiColorsChanged',colors:response.result.value}})); window.dispatchEvent(new MessageEvent('message',{data:response})); };
            if(window.__holdColorsReply) {window.__holdColorsReply=false;window.__releaseColorsReply=reply;} else reply();
          });
        }
      }});
    ` });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    await page.evaluate(colors => {
      const global = window as any; const text = '# Heading\n\nbody text\n\n- List item';
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', documentId: 'file:///colors.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'auto', uiColors: colors, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: {name: 'fixture', type: 'dark', colors: {}, tokenColors: []}, editingPreferences: {input: {...global.EditingSettingsHarness.defaultInputAssistance},shortcuts:{}} } }));
    }, owner.getUiColors());
    await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));
  };
  const openSettings = async () => { await page.click('.more-tools-wrapper > .format-button'); await page.click('.more-tools-settings-button'); await page.click('[data-tab="appearance"]'); };
  const input = (key: string) => `[data-setting="${key}"] .appearance-color-hex`;
  const edit = async (key: string, color: string) => {
    await page.click(input(key), {clickCount: 3}); await page.keyboard.type(color);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  const value = (key: string) => page.$eval(input(key), element => (element as HTMLInputElement).value);
  const role = (key: string) => page.evaluate(key => { const probe = document.createElement('span'); probe.style.color = 'var(--meo-ui-' + key + ')'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, key);
  const channels = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const saturation = (color: string) => { const rgb = channels(color); return (Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb); };
  const luminance = (color: string) => channels(color).map(value => {
    const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const checkSemanticColors = async (label: string) => {
    const surfaces = await Promise.all(['surface', 'surface-raised', 'surface-field', 'surface-hover'].map(role));
    for (const [name, floor] of [['success', 0.60], ['warning', 0.85], ['danger', 0.55]] as const) {
      const color = await role(name); const [red, green, blue] = channels(color);
      assert.ok(saturation(color) >= floor, `${label}: ${name} retains a recognizable saturated color (${color})`);
      assert.ok(name === 'success' ? green! > red! && green! > blue! : name === 'warning' ? red! >= green! && green! > blue! : red! > green! && red! > blue!, `${label}: ${name} preserves its semantic hue`);
      for (const surface of surfaces) {
        const values = [luminance(color), luminance(surface)];
        assert.ok((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05) >= 4.5, `${label}: ${name} remains readable on ${surface}`);
      }
      assert.equal(await page.$eval(`[data-setting="${name}"] .appearance-color-chip`, element => getComputedStyle(element).backgroundColor), color, `${label}: appearance swatches show the actual semantic role`);
      assert.equal(await value(name), '', `${label}: derived colors are not saved as user overrides`);
    }
    const warning = await role('warning'); const selected = await role('surface-selected');
    const values = [luminance(warning), luminance(selected)];
    assert.ok((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05) >= 3, `${label}: a selected comparison warning icon remains distinguishable`);
  };
  const resetColors = '.appearance-footer > button:first-child';
  const source = () => page.$$eval('.cm-content, .cm-line, .cm-line span, .cm-gutters', elements => elements.map(element => [element.textContent, getComputedStyle(element).color, getComputedStyle(element).backgroundColor]));
  await openFixture(); await openSettings();
  await checkSemanticColors('native dark');
  assert.deepEqual(await page.$$eval('.settings-tab-label', elements => elements.map(e => e.textContent)), ['常规', '外观', '输入', '预览预设', '快捷键']);
  await page.click('[data-tab="general"]'); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval('.settings-tab[aria-selected="true"]', e => (e as HTMLElement).dataset.tab), 'shortcuts');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('.settings-tab[aria-selected="true"]', e => (e as HTMLElement).dataset.tab), 'appearance');
  assert.equal(await value('surface'), '');
  assert.equal(await page.$eval('[data-appearance-mode="auto"]', e => e.textContent), '自动');
  const checkControlLayout = async () => {
    await page.waitForFunction(() => document.querySelector('.appearance-mode-control')!.getAnimations({subtree: true}).every(animation => animation.playState !== 'running'));
    assert.deepEqual(await page.evaluate(() => {
      const mode = document.querySelector<HTMLElement>('.appearance-mode-control')!;
      const rect = mode.getBoundingClientRect();
      const title = document.querySelector('[data-setting="mode"] .settings-item-text')!.getBoundingClientRect();
      const colors = [...document.querySelectorAll<HTMLElement>('.appearance-color-controls')].filter(e => e.getBoundingClientRect().width > 0);
      return {
        aligned: colors.every(e => { const color = e.getBoundingClientRect(); return Math.abs(color.left - rect.left) < 1 && Math.abs(color.right - rect.right) < 1; }),
        rightOfTitle: title.right < rect.left && title.top < rect.bottom && title.bottom > rect.top,
        compact: rect.width === 240 && rect.height === 32,
        icons: mode.querySelectorAll('svg[width="12"][height="12"]').length,
        labelsFit: [...mode.querySelectorAll<HTMLElement>('.segmented-control-button-content')].every(e => e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e.querySelector('span')!).whiteSpace === 'nowrap')
      };
    }), {aligned: true, rightOfTitle: true, compact: true, icons: 2, labelsFit: true}, 'mode reuses the menu control and aligns with the color column');
  };
  const checkColorFocus = async () => {
    await page.focus('[data-setting="surface"] .appearance-color-swatch');
    assert.deepEqual(await page.$eval('[data-setting="surface"] .appearance-color-field', field => {
      const chip = field.querySelector<HTMLElement>('.appearance-color-chip')!;
      const bounds = field.getBoundingClientRect(); const dot = chip.getBoundingClientRect();
      const style = getComputedStyle(field);
      return {
        contained: dot.left >= bounds.left && dot.right <= bounds.right && dot.top >= bounds.top && dot.bottom <= bounds.bottom,
        noOuterRing: getComputedStyle(chip).outlineStyle === 'none',
        insetFocus: style.boxShadow.includes('inset') && style.borderWidth === '0px'
      };
    }), {contained: true, noOuterRing: true, insetFocus: true}, 'color focus stays inside the borderless field');
  };
  await checkControlLayout();
  await checkColorFocus();
  assert.deepEqual(await page.$$eval('.settings-jump', elements => elements.map(e => e.textContent)), ['界面模式', '文档排版', '基础颜色', '高级颜色']);
  const screenshots = process.env.MEO_UI_COLORS_SCREENSHOT_DIR;
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  for (const [index, tab] of ['general', 'appearance', 'typing', 'presets', 'shortcuts'].entries()) {
    await page.click(`[data-tab="${tab}"]`);
    assert.deepEqual(await page.evaluate(() => {
      const navigation = document.querySelector('.settings-navigation')!;
      const content = document.querySelector('.settings-content')!;
      const jumps = [...navigation.querySelectorAll<HTMLButtonElement>('.settings-jump')];
      const sections = [...content.querySelectorAll<HTMLElement>('.settings-section')];
      return {
        twoColumns: navigation.getBoundingClientRect().width > 0 && navigation.getBoundingClientRect().right <= content.getBoundingClientRect().left,
        matchingSections: jumps.length > 0 && jumps.length === sections.length && jumps.every((jump, index) => sections[index].id === 'meo-settings-' + jump.dataset.section)
      };
    }), {twoColumns: true, matchingSections: true}, tab + ' shares the left navigation/right settings layout');
    if (screenshots) await page.screenshot({path: path.join(screenshots, `${String(53 + index).padStart(3, '0')}-${tab}-layout.png`)});
  }
  await page.click('[data-tab="appearance"]');
  await page.click('[data-section="appearanceAdvanced"]');
  assert.ok(await page.$eval('.settings-content', e => e.scrollTop > 0), 'advanced navigation scrolls the same settings surface');
  await page.waitForFunction(() => document.querySelector('.settings-jump.is-active')?.getAttribute('data-section') === 'appearanceAdvanced');
  assert.equal(await page.$eval('[data-setting="success"]', e => {const item = e.getBoundingClientRect(); const content = document.querySelector('.settings-content')!.getBoundingClientRect(); return item.top >= content.top && item.bottom <= content.bottom;}), true, 'advanced navigation reveals its settings');
  if (screenshots) await page.screenshot({path: path.join(screenshots, '057-appearance-advanced.png')});
  await page.click('[data-section="appearanceMode"]');
  await page.click('.settings-search'); await page.keyboard.type('危险');
  assert.deepEqual(await page.$$eval('.settings-jump', elements => elements.map(e => e.textContent)), ['高级颜色'], 'filtered navigation contains only matching sections');
  await page.click('.settings-search-clear');
  await page.click('[data-tab="general"]'); await page.click('[data-setting="language"] [data-value="en"]'); await page.click('[data-tab="appearance"]');
  assert.equal(await page.$eval('[data-appearance-mode="auto"]', e => e.textContent), 'Auto');
  await checkControlLayout();
  await checkColorFocus();
  if (screenshots) await page.screenshot({ path: path.join(screenshots, '058-appearance-english.png') });
  await page.setViewport({width: 360, height: 740});
  assert.equal(await page.$eval('.settings-content', e => e.scrollWidth <= e.clientWidth), true, 'English color controls fit a narrow window');
  assert.equal(await page.$$eval('.appearance-color-reset svg', elements => elements.every(e => e.getBoundingClientRect().width === 14)), true, 'reset icons remain legible inside compact buttons');
  await checkColorFocus();
  if (screenshots) await page.screenshot({path: path.join(screenshots, '059-appearance-narrow.png')});
  await page.setViewport({width: 1100, height: 820});
  await page.click('[data-tab="general"]'); await page.click('[data-setting="language"] [data-value="zh-CN"]'); await page.click('[data-tab="appearance"]');
  // A manual appearance must not inherit UI colors from the opposite host.
  const hostInputs = ['editor-background', 'editorWidget-background', 'foreground', 'button-background', 'textLink-foreground', 'testing-iconPassed', 'editorWarning-foreground', 'errorForeground'];
  const originalHostInputs = await page.evaluate(ids => ids.map(id => {
    const key = '--vscode-' + id; const style = document.documentElement.style;
    return [key, style.getPropertyValue(key), style.getPropertyPriority(key)];
  }), hostInputs);
  const changeHost = async (appearance: 'light' | 'dark', color?: string) => page.evaluate(({appearance, ids, color}) => {
    document.body.className = 'vscode-' + appearance;
    if (color) for (const id of ids) document.documentElement.style.setProperty('--vscode-' + id, color);
    window.dispatchEvent(new MessageEvent('message', {data: {type: 'vscodeCodeThemeChanged', appearance, vscodeTheme: {name: 'fixture', type: appearance, colors: {}, tokenColors: []}}}));
  }, {appearance, ids: hostInputs, color});
  const uiRoles = () => page.evaluate(() => [...document.documentElement.style]
    .filter(key => key.startsWith('--meo-ui-'))
    .map(key => [key, document.documentElement.style.getPropertyValue(key)]));
  await page.click('[data-appearance-mode="light"]');
  assert.equal(await role('accent'), 'rgb(0, 105, 204)', 'VS Code dark/MEO light uses the Light 2026 accent');
  assert.equal(await page.$eval(input('surface'), e => (e as HTMLInputElement).placeholder), '默认浅色配色');
  assert.match(await page.$eval('.appearance-color-reset', e => e.getAttribute('aria-label')!), /默认浅色配色/);
  if (screenshots) await page.screenshot({path: path.join(screenshots, '064-default-light.png')});
  const defaultLightRoles = await uiRoles(); const lightSource = await source();
  await checkSemanticColors('default light');
  if (screenshots) {
    await page.click('[data-section="appearanceAdvanced"]');
    await page.screenshot({path: path.join(screenshots, '066-semantic-light.png')});
    await page.click('[data-section="appearanceMode"]');
  }
  await changeHost('dark', '#EE2266');
  assert.deepEqual(await uiRoles(), defaultLightRoles, 'all default light UI roles ignore opposite host inputs');
  assert.deepEqual(await source(), lightSource, 'opposite host UI input changes do not alter Source content');
  await edit('accent', '#8844AA');
  assert.equal(await role('accent'), 'rgb(136, 68, 170)', 'custom input overrides the bundled default');
  await page.click(resetColors);
  assert.deepEqual(await uiRoles(), defaultLightRoles, 'reset restores the default palette');
  await changeHost('light', '#33BB88'); await page.click('[data-appearance-mode="dark"]');
  assert.equal(await role('accent'), 'rgb(41, 122, 160)', 'VS Code light/MEO dark uses the Dark 2026 accent');
  assert.equal(await page.$eval(input('surface'), e => (e as HTMLInputElement).placeholder), '默认深色配色');
  if (screenshots) await page.screenshot({path: path.join(screenshots, '065-default-dark.png')});
  const defaultDarkRoles = await uiRoles(); const darkSource = await source();
  await checkSemanticColors('default dark');
  if (screenshots) {
    await page.click('[data-section="appearanceAdvanced"]');
    await page.screenshot({path: path.join(screenshots, '067-semantic-dark.png')});
    await page.click('[data-section="appearanceMode"]');
  }
  await edit('danger', '#F48771');
  assert.notEqual(await role('danger'), defaultDarkRoles.find(([key]) => key === '--meo-ui-danger')![1], 'an explicit color matching the native input bypasses chroma enhancement and invalidates the palette cache');
  assert.equal(await page.$eval('[data-setting="danger"] .appearance-color-swatch', element => (element as HTMLInputElement).value), '#f48771', 'the color picker preserves the explicit user color');
  await page.click(resetColors);
  assert.deepEqual(await uiRoles(), defaultDarkRoles, 'reset restores the vivid defaults after a semantic override');
  await page.click('[data-section="appearanceMode"]');
  await changeHost('light', '#DD3355');
  assert.deepEqual(await uiRoles(), defaultDarkRoles, 'all default dark UI roles ignore opposite host inputs');
  assert.deepEqual(await source(), darkSource);
  await page.click('[data-tab="general"]'); await page.click('[data-setting="language"] [data-value="en"]'); await page.click('[data-tab="appearance"]');
  assert.equal(await page.$eval(input('surface'), e => (e as HTMLInputElement).placeholder), 'Default dark palette');
  assert.match(await page.$eval('.appearance-note', e => e.textContent!), /dark default palette/);
  assert.match(await page.$eval('.appearance-color-reset', e => e.getAttribute('aria-label')!), /Default dark palette/);
  await page.click('.settings-search'); await page.keyboard.type('Default dark palette');
  assert.equal(await page.$$eval('.appearance-item', elements => elements.length), 9, 'default palette searches expose all color inputs');
  await page.click('.settings-search-clear');
  await page.evaluate(inputs => { for (const [key, value, priority] of inputs) document.documentElement.style.setProperty(key!, value!, priority!); }, originalHostInputs);
  await changeHost('dark'); await page.click('[data-appearance-mode="auto"]');
  assert.equal(await role('accent'), 'rgb(36, 114, 200)', 'Auto resumes the active VS Code colors');
  assert.equal(await page.$eval(input('surface'), e => (e as HTMLInputElement).placeholder), 'Follow VS Code theme');
  await page.click('[data-tab="general"]'); await page.click('[data-setting="language"] [data-value="zh-CN"]'); await page.click('[data-tab="appearance"]');
  assert.deepEqual(owner.getUiColors(), {light: {}, dark: {}}, 'bundled defaults and previews are never persisted as overrides');
  const saved = async (mode: 'light' | 'dark', key: string, color: string | null) => {
    try {
      await page.waitForFunction(async ({mode, key, color}) => ((await (window as any).__savedColors())[mode][key] ?? null) === color, {}, {mode, key, color});
    } catch (error) {
      throw new Error(`Save ${mode}/${key}=${color}: ${JSON.stringify({saved: owner.getUiColors(), ui: await page.evaluate(() => ({status: document.querySelector('.appearance-status')?.textContent, messages: (window as any).__messages.filter((m: any) => m.type === 'updateUiColors').slice(-3)}))})}`, {cause: error});
    }
  };
  const originalSurface = await role('surface'); const sourceBefore = await source();
  assert.equal(await page.$('.appearance-footer .settings-primary'), null, 'appearance has no Apply action');
  assert.equal(await page.$('.appearance-footer .settings-actions'), null, 'appearance has no Cancel action');
  assert.equal(await page.$eval('.appearance-save-retry', el => getComputedStyle(el).display), 'none', 'retry is invisible until a save fails');
  await edit('documentBackground', '#182C38');
  assert.equal(await page.$eval('body', e => getComputedStyle(e).backgroundColor), 'rgb(24, 44, 56)');
  assert.equal(await role('surface'), originalSurface, 'document background is independent of UI surface');
  assert.deepEqual((await source()).map(([text, color]) => [text, color]), sourceBefore.map(([text, color]) => [text, color]), 'background changes preserve Source ink');
  await saved('dark', 'documentBackground', '#182C38');
  await edit('documentBackground', '#FFFFFF');
  assert.equal(await page.$eval('.appearance-background-warning', e => (e as HTMLElement).hidden), false);
  assert.equal(await value('documentBackground'), '#FFFFFF', 'contrast advice retains the chosen color');
  await page.click(resetColors); await saved('dark', 'documentBackground', null);
  const drag = await page.evaluate(async () => {
    const swatch = document.querySelector<HTMLInputElement>('[data-setting="surface"] .appearance-color-swatch')!;
    const readback = CanvasRenderingContext2D.prototype.getImageData;
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let samples = 0, feedbackWrites = 0, userWriting = false;
    CanvasRenderingContext2D.prototype.getImageData = function(...args: Parameters<typeof readback>) { samples++; return readback.apply(this, args); };
    Object.defineProperty(HTMLInputElement.prototype, 'value', {...value, set(input) {
      if (this === swatch && !userWriting) feedbackWrites++;
      value.set!.call(this, input);
    }});
    try {
      for (let index = 0; index < 12; index++) {
        userWriting = true; swatch.value = '#2848' + (43 + index).toString(16); userWriting = false;
        swatch.dispatchEvent(new Event('input', {bubbles: true}));
      }
      const synchronousSamples = samples;
      const latestHex = document.querySelector<HTMLInputElement>('[data-setting="surface"] .appearance-color-hex')!.value;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const appliedSamples = samples;
      swatch.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {synchronousSamples, appliedSamples, duplicateSamples: samples - appliedSamples, feedbackWrites, latestHex};
    } finally {
      CanvasRenderingContext2D.prototype.getImageData = readback;
      Object.defineProperty(HTMLInputElement.prototype, 'value', value);
    }
  });
  assert.equal(drag.synchronousSamples, 0, 'drag callbacks defer expensive color sampling to the next frame');
  assert.ok(drag.appliedSamples > 0 && drag.appliedSamples < 400, 'one frame derives only the latest selection, rather than every intermediate color');
  assert.equal(drag.duplicateSamples, 0, 'an unchanged selection does not refresh the palette');
  assert.equal(drag.feedbackWrites, 0, 'presenting a draft does not write back into an active color input');
  assert.equal(drag.latestHex, '#284836', 'HEX feedback follows the latest drag event immediately');
  assert.equal(await role('surface'), 'rgb(40, 72, 54)');
  assert.deepEqual(await source(), sourceBefore, 'continuous UI preview retains the Source palette');
  await saved('dark', 'surface', '#284836');
  await page.click(resetColors); await saved('dark', 'surface', null);
  const writesBefore = await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'updateUiColors').length);
  await page.evaluate(() => {
    const swatch = document.querySelector<HTMLInputElement>('[data-setting="surface"] .appearance-color-swatch')!;
    for (const color of ['#102537', '#112638', '#122739']) { swatch.value = color; swatch.dispatchEvent(new Event('input', {bubbles: true})); }
  });
  await saved('dark', 'surface', '#122739');
  assert.equal(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'updateUiColors').length), writesBefore + 1, 'one drag burst makes one persisted write');
  for (const close of ['button', 'escape', 'backdrop'] as const) {
    const color = close === 'button' ? '#102537' : close === 'escape' ? '#112638' : '#122739';
    await edit('surface', color);
    if (close === 'button') await page.click('.settings-close');
    else if (close === 'escape') await page.keyboard.press('Escape');
    else await page.mouse.click(1, 1);
    await saved('dark', 'surface', color); await openSettings();
    assert.equal(await value('surface'), color, close + ' flushes and retains the latest valid value');
  }
  await edit('accent', '#1234');
  assert.equal(await page.$eval(input('accent'), e => e.getAttribute('aria-invalid')), 'true');
  await page.click('.settings-close'); await openSettings();
  assert.equal(owner.getUiColors().dark.accent, undefined, 'an invalid HEX prefix cannot overwrite the saved color');
  fail = true;
  await edit('textEmphasis', '#99CCAA');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.appearance-status')!.hidden);
  assert.equal(owner.getUiColors().dark.textEmphasis, undefined);
  fail = false; await page.click('.appearance-save-retry'); await saved('dark', 'textEmphasis', '#99CCAA');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.appearance-save-retry')!.hidden);
  await page.click('.settings-close'); await openFixture(); await openSettings();
  assert.equal(await value('surface'), '#122739', 'reload receives persisted values');
  assert.equal(await value('textEmphasis'), '#99CCAA');
  await page.click('.settings-close'); await page.click('[data-mode="live"]');
  await page.waitForSelector('.meo-md-heading-content');
  assert.equal(await page.$eval('.meo-md-heading-content', e => getComputedStyle(e).color), await role('text-emphasis-content'), 'saved content emphasis projects its contrast-corrected role onto the actual Live heading');
  const headingContrast = await page.evaluate(() => {
    const ink = getComputedStyle(document.querySelector('.meo-md-heading-content')!).color;
    const probe = document.createElement('span'); probe.style.color = 'var(--meo-document-inline)'; document.body.append(probe);
    const surface = getComputedStyle(probe).color; probe.remove();
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
      const channel = v / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(ink), luminance(surface)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  assert.ok(headingContrast >= 4.5, 'content emphasis stays readable on the stronger inline surface without rewriting the saved color');
  await openSettings();
  await page.click('[data-appearance-mode="light"]');
  assert.equal(await value('surface'), '', 'light and dark profiles are independent');
  await checkControlLayout(); await checkColorFocus();
  await edit('surface', '#F8F4EF'); await saved('light', 'surface', '#F8F4EF');
  if (screenshots) await page.screenshot({path: path.join(screenshots, '060-appearance-light.png')});
  // Untouched fields accept external configuration while local edits are pending.
  await edit('surface', '#112638');
  const external = {...owner.getUiColors(), light: {...owner.getUiColors().light, accent: '#005588'}};
  await owner.setUiColors(external);
  await page.evaluate(colors => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors}})), external);
  await saved('light', 'surface', '#112638');
  assert.equal(owner.getUiColors().light.accent, '#005588');
  // A held acknowledgement cannot erase newer edits, even an edit back to the previously saved value.
  await page.evaluate(() => { (window as any).__holdColorsReply = true; });
  await edit('accent', '#4477CC');
  await page.waitForFunction(() => typeof (window as any).__releaseColorsReply === 'function');
  await edit('accent', '#005588');
  await page.click('.settings-close'); await openSettings();
  await page.evaluate(() => (window as any).__releaseColorsReply());
  await saved('light', 'accent', '#005588');
  assert.equal(await value('accent'), '#005588', 'late acknowledgements preserve the latest intent');
  await page.click('[data-appearance-mode="auto"]');
  await page.evaluate(() => { document.body.className = 'vscode-high-contrast'; window.dispatchEvent(new MessageEvent('message', {data: {type: 'vscodeCodeThemeChanged', appearance: 'dark', vscodeTheme: {name: 'HC', type: 'dark', colors: {}, tokenColors: []}}})); });
  assert.equal(await role('surface'), 'rgb(34, 39, 46)', 'high contrast uses the native palette');
  assert.ok(await page.$eval('.appearance-note', e => e.textContent?.includes('高对比度')));
  await page.evaluate(() => { document.body.className = 'vscode-dark'; window.dispatchEvent(new MessageEvent('message', {data: {type: 'vscodeCodeThemeChanged', appearance: 'dark', vscodeTheme: {name: 'dark', type: 'dark', colors: {}, tokenColors: []}}})); });
  assert.equal(await value('surface'), '#122739');
  await page.click(resetColors); await saved('dark', 'surface', null); await saved('light', 'surface', null);
  assert.deepEqual(owner.getUiColors(), {light: {}, dark: {}}, 'reset immediately clears both profiles');
  // Distinct syntax colors must reach actual reading content, not just swatches.
  await page.click('.settings-close');
  const fixture = '# Heading [**heading link**](https://example.com)\n\n- List body\n1. Numbered body\n\n[Link **bold**](https://example.com) and [^note]\n\n| Item | Value |\n| --- | --- |\n| Link | [Table link](https://example.com) |\n\n[^note]: Footnote\n\nEnd';
  const ink = (selector: string) => page.$eval(selector, element => getComputedStyle(element).color);
  for (const scheme of ['dark', 'light'] as const) {
    const heading = scheme === 'dark' ? '#DDEE66' : '#445500';
    const link = scheme === 'dark' ? '#66CCFF' : '#004477';
    await page.evaluate(({ scheme, heading, link, fixture }) => {
      document.body.className = `vscode-${scheme}`;
      const root = document.documentElement.style;
      root.setProperty('--vscode-editor-background', scheme === 'dark' ? '#22272e' : '#ffffff');
      root.setProperty('--vscode-editor-foreground', scheme === 'dark' ? '#dddddd' : '#222222');
      root.setProperty('--vscode-editorWidget-background', scheme === 'dark' ? '#22272e' : '#fafafa');
      window.dispatchEvent(new MessageEvent('message', { data: {type: 'vscodeCodeThemeChanged', appearance: scheme,
        vscodeTheme: {name: 'Distinct accents', type: scheme, colors: {'editor.foreground': scheme === 'dark' ? '#dddddd' : '#222222'}, tokenColors: [
          {scope: 'markup.heading', settings: {foreground: heading}},
          {scope: 'markup.underline.link', settings: {foreground: link}}
        ]}
      }}));
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: fixture}, selection: {anchor: fixture.length}});
    }, {scheme, heading, link, fixture});
    await page.click('[data-mode="live"]');
    await page.waitForSelector('.meo-md-html-table-cell-preview .meo-md-link');
    const expectedHeading = scheme === 'dark' ? 'rgb(221, 238, 102)' : 'rgb(68, 85, 0)';
    const expectedLink = scheme === 'dark' ? 'rgb(102, 204, 255)' : 'rgb(0, 68, 119)';
    assert.equal(await ink('.meo-md-heading-content'), expectedHeading, 'readable Source heading color is preserved');
    assert.equal(await ink('.meo-md-list-marker-ordered'), expectedHeading, 'numbered lists share the heading color');
    for (const selector of ['.meo-md-link', '.meo-md-link .meo-md-strong, .meo-md-strong.meo-md-link', '.meo-md-html-table-cell-preview .meo-md-link', '.meo-md-footnote-ref', '.meo-md-footnote-backref']) {
      assert.equal(await ink(selector), expectedLink, `${scheme}: ${selector} uses the independent Source link color`);
    }
    if (screenshots) await page.screenshot({path: path.join(screenshots, `split-colors-${scheme}.png`)});
    await openSettings();
    if (screenshots) {
      await page.$eval('[data-setting="link"]', element => element.scrollIntoView({block: 'center'}));
      await page.screenshot({path: path.join(screenshots, `split-settings-${scheme}.png`)});
    }
    await edit('link', scheme === 'dark' ? '#FFBBCC' : '#660033');
    await saved(scheme, 'link', scheme === 'dark' ? '#FFBBCC' : '#660033');
    assert.equal(await ink('.meo-md-heading-content'), expectedHeading, 'link overrides leave headings unchanged');
    assert.notEqual(await ink('.meo-md-link'), expectedLink);
    await page.click('[data-setting="link"] .appearance-color-reset');
    await saved(scheme, 'link', null);
    assert.equal(await ink('.meo-md-link'), expectedLink, 'reset returns to Source link color');
    await edit('textEmphasis', scheme === 'dark' ? '#FFBBCC' : '#660033');
    await saved(scheme, 'textEmphasis', scheme === 'dark' ? '#FFBBCC' : '#660033');
    assert.equal(await ink('.meo-md-link'), expectedLink, 'heading overrides leave links unchanged');
    assert.notEqual(await ink('.meo-md-heading-content'), expectedHeading);
    await page.click('[data-setting="textEmphasis"] .appearance-color-reset');
    await saved(scheme, 'textEmphasis', null);
    assert.equal(await ink('.meo-md-heading-content'), expectedHeading, 'reset returns to Source heading color');
    await page.click('.settings-close');
  }
  for (const large of [false, true]) {
    await page.evaluate(text => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: 10}, scrollIntoView: true});
    }, fixture + (large ? '\n\n' + 'A plain paragraph for the large document color projection.\n\n'.repeat(5000) : ''));
    await page.waitForSelector('.meo-md-link');
    const stable = await page.evaluate(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      await frame(); await frame();
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      const state = view.state;
      const line = document.querySelector('.cm-line');
      const link = document.querySelector('.meo-md-link')!;
      const before = getComputedStyle(link).color;
      const top = view.scrollDOM.scrollTop;
      window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {link: '#660033'}, dark: {}}}}));
      await frame(); await frame();
      return {state: view.state === state, line: document.querySelector('.cm-line') === line,
        link: document.querySelector('.meo-md-link') === link, scroll: Math.abs(view.scrollDOM.scrollTop - top) < 1,
        recolored: getComputedStyle(link).color !== before};
    });
    assert.deepEqual(stable, {state: true, line: true, link: true, scroll: true, recolored: true}, `${large ? 'large' : 'ordinary'} document color changes preserve editor state, DOM and viewport`);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {}, dark: {}}}})));
  }
  assert.deepEqual(errors, []);
  console.log('Production appearance: bilingual light/dark layout, defaults, semantic colors, drag projection/coalescing, autosave, all close paths, validation, retry, reload, external changes, delayed acknowledgements and high contrast passed');
} finally { await closeTestBrowser(browser); }
