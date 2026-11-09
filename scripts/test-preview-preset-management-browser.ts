import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreviewPresetLibrary, type StoredPreviewPreset } from '../src/host/customPreviewPresets';
import type { PreviewPresetRequest } from '../src/protocol/previewPresets';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser } from './browser-test-helpers';

const storage = new Map<string, StoredPreviewPreset>();
const library = createPreviewPresetLibrary({ list: async () => [...storage.keys()], read: async id => storage.get(id)!, write: async (id, preset) => { storage.set(id, preset); }, remove: async id => { storage.delete(id); } });
const example = path.resolve('preview-presets/examples/paper-notes');
const manifest = readFileSync(path.join(example, 'preset.jsonc'), 'utf8');
const readCss = async (file: string) => readFileSync(path.join(example, file), 'utf8');
const preset = await library.import(manifest, readCss);
const disabled = new Set<string>();
const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const errors: string[] = [];
const actions: PreviewPresetRequest[] = [];
let failNext = false;
let visibilityGate: Promise<void> | undefined;
let fileGate: Promise<void> | undefined;
let fileOutcome: 'success' | 'cancel' | 'error' = 'success';
let importCss = '';
let importName = preset.name['zh-CN'];
mkdirSync('tmp/preset-management', { recursive: true });
const fixture = path.resolve('tmp/preset-management/fixture.html');
writeFileSync(fixture, '<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
try {
  const broadcast = async () => {
    const event = { type: 'previewPresetsChanged', presets: library.list(), disabled: [...disabled], diagnostics: library.diagnostics() };
    for (const page of await browser.pages()) await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), event);
  };
  const open = async (language = 'zh-CN', appearance = 'dark') => {
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1100, height: 780 });
    await page.goto(pathToFileURL(fixture).href);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.exposeFunction('__presetHost', async (message: any) => {
      if (message.type === 'requestPreviewRender') {
        const definition = message.preset?.startsWith('user:') ? library.get(message.preset) : undefined;
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: 'C:/tmp/preset-management.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment, preset: message.preset, presetDefinition: definition }) } };
      }
      if (message.type !== 'previewPresetRequest') return null;
      actions.push(message);
      if (message.action === 'setEnabled') await visibilityGate;
      if (message.action === 'import' || message.action === 'remove') {
        await fileGate;
        if (fileOutcome === 'cancel') return { type: 'previewPresetResult', requestId: message.requestId, result: { ok: true, value: { changed: false } } };
        if (fileOutcome === 'error') {
          if (message.action === 'import') library.reportError('user:imported-notes', 'Import update failed');
          await broadcast();
          return { type: 'previewPresetResult', requestId: message.requestId, result: { ok: false, error: { code: 'operation-failed', message: 'Preset file operation failed' } } };
        }
      }
      if (failNext) { failNext = false; return { type: 'previewPresetResult', requestId: message.requestId, result: { ok: false, error: { code: 'operation-failed', message: 'Visibility save failed' } } }; }
      if (message.action === 'setEnabled') { if (message.enabled) disabled.delete(message.preset); else disabled.add(message.preset); }
      if (message.action === 'import') await library.import(manifest.replace('"id": "paper-notes"', '"id": "imported-notes"').replace(preset.name['zh-CN'], importName), async file => (await readCss(file)) + importCss);
      if (message.action === 'remove') { await library.remove(message.preset); disabled.delete(message.preset); }
      const changed = ['setEnabled', 'import', 'remove'].includes(message.action);
      if (changed) await broadcast();
      return { type: 'previewPresetResult', requestId: message.requestId, result: { ok: true, value: { changed } } };
    });
    await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__presetHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    const text = '# Preset management\n\nPreview content stays in its selected preset.';
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), { type: 'init', documentId: 'file:///preset-management.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: language, editorAppearance: appearance, sourceLineNumbers: 'on', previewAppearance: 'auto', previewFontFamily: '', previewSourceColoring: true, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null, customPreviewPresets: library.list(), disabledPreviewPresets: [...disabled] });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1'));
    console.log('Preset management fixture ready');
    return page;
  };
  const page = await open(); const sibling = await open();
  const choose = async (target: typeof page, id: string) => { await target.bringToFront(); await target.click('.preview-preset-dropdown'); await target.click(`.preview-preset-dropdown-panel [data-value="${id}"]`); await target.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === id, {}, id); };
  const waitForVisibility = async (id: string) => page.waitForFunction(id => {
    const input = document.querySelector<HTMLInputElement>(`[data-preset="${id}"] input`);
    return input && !input.disabled && input.getAttribute('aria-busy') !== 'true';
  }, {}, id);
  const fileOperation = async (action: 'import' | 'remove', replacedIds: string[] = [], outcome: typeof fileOutcome = 'success') => {
    const nodes = await page.evaluateHandle(() => ({
      rows: [...document.querySelectorAll<HTMLElement>('.settings-preset-row[data-preset]')],
      files: [...document.querySelectorAll('.settings-preset-row[data-preset-action] button')],
      navigation: [...document.querySelectorAll('.settings-navigation button')]
    }));
    const inspect = () => page.evaluate(saved => ({
      replacedIds: saved.rows.filter(node => !node.isConnected).map(node => node.dataset.preset),
      keptControls: [...saved.files, ...saved.navigation].every(node => node.isConnected)
    }), nodes);
    fileOutcome = outcome;
    let release!: () => void;
    fileGate = new Promise(resolve => { release = resolve; });
    if (action === 'import') await page.click('.settings-item[data-preset-action="import"] button');
    else { await page.click('[data-preset="user:imported-notes"] [data-preset-action="remove"]'); await page.click('[data-preset-confirm="remove"]'); }
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="guide"] button')!.disabled);
    assert.deepEqual(await inspect(), { replacedIds: [], keptControls: true }, 'Pending file operations preserve all rows, file controls and navigation');
    fileGate = undefined; release();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="guide"] button')!.disabled);
    assert.deepEqual(await inspect(), { replacedIds, keptControls: true }, 'File operations replace only the changed preset row');
    await nodes.dispose(); fileOutcome = 'success';
  };
  await choose(page, preset.id); await choose(sibling, preset.id);
  await page.bringToFront();
  console.log('Both documents selected the custom preset');
  await page.click('.preview-preset-dropdown');
  assert.equal(await page.$('.preview-preset-dropdown-panel .preview-preset-option-info'), null, 'Preset rows do not add information buttons');
  await page.hover('.preview-preset-dropdown-panel [data-value="default"]');
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.meo-tooltip.is-visible')].some(el => getComputedStyle(el).opacity === '1' && el.textContent?.includes('使用编辑器的阅读样式')));
  assert.equal(await page.$eval('.meo-tooltip.is-visible', el => (el as HTMLElement).dataset.side), 'right');
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector('.meo-tooltip.is-visible')!.getBoundingClientRect().top - document.querySelector('.preview-preset-dropdown-panel [data-value="default"]')!.getBoundingClientRect().top) <= 1), 'The preset hint aligns with the hovered row top');
  assert.equal(await page.$eval('.preview-preset-dropdown-panel', el => (el as HTMLElement).hidden), false, 'Viewing information keeps the menu open');
  assert.equal(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.documentElement.dataset.meoPreviewPreset), preset.id, 'Viewing another preset does not select it');
  await page.hover(`.preview-preset-dropdown-panel [data-value="${preset.id}"]`);
  await page.waitForFunction(description => [...document.querySelectorAll<HTMLElement>('.meo-tooltip.is-visible')].some(el => getComputedStyle(el).opacity === '1' && el.textContent?.includes(description)), {}, preset.description['zh-CN']);
  await page.hover('.preview-preset-dropdown-panel .preview-dropdown-footer');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'Leaving the preset row hides its information');
  await page.focus('.preview-preset-dropdown-panel [data-value="default"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.value), 'github-readme', 'Arrow navigation follows preset rows');
  await page.click('.preview-preset-dropdown-panel .preview-dropdown-footer');
  assert.equal(await page.$eval('.settings-tab[data-tab="presets"]', el => el.getAttribute('aria-selected')), 'true');
  assert.deepEqual(await page.$$eval('.settings-tab', els => els.map(el => (el as HTMLElement).dataset.tab)), ['general', 'appearance', 'typing', 'presets', 'shortcuts', 'about']);
  assert.equal(await page.$('.settings-tab[data-tab="extensions"]'), null, 'Preset management keeps unpublished Extras hidden');
  assert.equal(await page.$eval('.preview-preset-dropdown-panel', el => (el as HTMLElement).hidden), true);
  for (const id of ['default', 'github-readme', 'newsprint', 'whitey', 'obsidian-minimal']) {
    assert.deepEqual(await page.$eval(`[data-preset="${id}"] input`, el => ({ checked: (el as HTMLInputElement).checked, disabled: (el as HTMLInputElement).disabled })), { checked: true, disabled: id === 'default' });
    assert.equal(await page.$(`[data-preset="${id}"] [data-preset-action="remove"]`), null, 'Built-ins do not expose removal');
  }
  await page.hover(`[data-preset="${preset.id}"] .settings-preset-info`);
  await page.waitForFunction(description => [...document.querySelectorAll<HTMLElement>('.settings-window .meo-tooltip.is-visible')].some(el => getComputedStyle(el).opacity === '1' && el.textContent?.includes(description)), {}, preset.description['zh-CN']);
  const info = await page.$eval('.settings-window .meo-tooltip.is-visible', el => el.textContent!);
  assert.equal(info, preset.description['zh-CN']);
  await page.screenshot({ path: 'tmp/preset-management/01-zh-dark-info.png' });
  await page.mouse.move(20, 20);
  await page.setViewport({ width: 1100, height: 650 });
  const visibilityScroll = await page.$eval('.settings-content', el => { el.scrollTop = 40; return el.scrollTop; });
  const visibilityNodes = await page.evaluateHandle(() => [...document.querySelectorAll('.settings-preset-row, .settings-preset-row input, .settings-preset-row button')]);
  let finishVisibility!: () => void;
  visibilityGate = new Promise(resolve => { finishVisibility = resolve; });
  await page.click(`[data-preset="${preset.id}"] input`);
  await page.waitForFunction(() => document.querySelector('[data-preset="user:paper-notes"] input')?.getAttribute('aria-busy') === 'true');
  assert.equal(await page.evaluate(nodes => nodes.every(node => node.isConnected), visibilityNodes), true, 'Starting a save does not rebuild the list');
  assert.equal(await page.$$eval('.settings-preset-row button', buttons => buttons.some(button => (button as HTMLButtonElement).disabled)), false, 'Visibility saves do not dim unrelated action buttons');
  assert.equal(await page.$eval('[data-preset="whitey"] input', el => (el as HTMLInputElement).disabled), false, 'Other presets remain usable during a save');
  assert.equal(await page.$eval('[data-preset="user:paper-notes"] input', el => el === document.activeElement), true, 'The clicked checkbox keeps focus');
  await page.keyboard.press('Space');
  assert.equal(await page.$eval('[data-preset="user:paper-notes"] input', el => (el as HTMLInputElement).checked), false, 'The checkbox retains its requested value while saving');
  assert.equal(actions.filter(action => action.action === 'setEnabled').length, 1, 'A pending checkbox does not send duplicate saves');
  await page.click('[data-preset="github-readme"] input');
  await page.waitForFunction(() => document.querySelector('[data-preset="github-readme"] input')?.getAttribute('aria-busy') === 'true');
  await page.screenshot({ path: 'tmp/preset-management/05-saving-visibility.png' });
  visibilityGate = undefined; finishVisibility();
  await waitForVisibility(preset.id); await waitForVisibility('github-readme');
  assert.equal(await page.evaluate(nodes => nodes.every(node => node.isConnected), visibilityNodes), true, 'Changing visibility preserves preset rows, checkboxes and unrelated buttons');
  assert.equal(await page.$eval('.settings-content', el => el.scrollTop), visibilityScroll, 'Visibility updates retain the scroll position');
  await visibilityNodes.dispose();
  await page.click('[data-preset="github-readme"] input'); await waitForVisibility('github-readme');
  await page.setViewport({ width: 1100, height: 780 });
  for (const target of [page, sibling]) await target.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'default');
  assert.equal(await page.$(`.preview-preset-dropdown-panel [data-value="${preset.id}"]`), null);
  await page.click(`[data-preset="${preset.id}"] input`);
  await waitForVisibility(preset.id);
  assert.equal(await page.$eval(`[data-preset="${preset.id}"] input`, el => (el as HTMLInputElement).checked), true);
  assert.equal(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.documentElement.dataset.meoPreviewPreset), 'default', 'Enabling is not selection');
  failNext = true; await page.click(`[data-preset="${preset.id}"] input`);
  await page.waitForFunction(() => document.querySelector('.settings-status')?.textContent === 'Visibility save failed');
  assert.equal(await page.$eval(`[data-preset="${preset.id}"] input`, el => (el as HTMLInputElement).checked), true, 'A rejected save restores the authoritative checkbox value');
  await page.click('.settings-close');
  await choose(page, 'whitey'); await choose(sibling, 'whitey');
  await page.bringToFront(); await page.click('.preview-preset-dropdown'); await page.click('.preview-dropdown-footer');
  await page.click('[data-preset="whitey"] input');
  await waitForVisibility('whitey');
  for (const target of [page, sibling]) await target.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'default');
  assert.equal(await page.$('.preview-preset-dropdown-panel [data-value="whitey"]'), null);
  assert.equal(await page.$eval('[data-preset="whitey"] input', el => (el as HTMLInputElement).checked), false);
  await page.screenshot({ path: 'tmp/preset-management/04-hidden-builtin.png' });
  const reopened = await open();
  assert.equal(await reopened.$('.preview-preset-dropdown-panel [data-value="whitey"]'), null, 'A new document respects hidden built-ins');
  await reopened.close(); await page.bringToFront();
  await page.click('[data-preset="github-readme"] input');
  await waitForVisibility('github-readme');
  assert.equal(await page.$('.preview-preset-dropdown-panel [data-value="github-readme"]'), null, 'The fixed GitHub preset can also be hidden');
  for (const id of ['whitey', 'github-readme']) {
    await page.click(`[data-preset="${id}"] input`);
    await waitForVisibility(id);
    assert.equal(await page.$eval(`[data-preset="${id}"] input`, el => (el as HTMLInputElement).checked), true);
  }
  assert.equal(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.documentElement.dataset.meoPreviewPreset), 'default', 'Showing a built-in does not select it');
  await page.click('.settings-close'); await choose(page, 'whitey'); await choose(page, 'default');
  await page.click('.preview-preset-dropdown'); await page.click('.preview-dropdown-footer');
  await fileOperation('import', [], 'cancel');
  await fileOperation('import');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-preset="user:imported-notes"] input')?.checked && !document.querySelector<HTMLInputElement>('[data-preset="user:imported-notes"] input')?.disabled);
  await fileOperation('import');
  importCss = '\n/* Updated preset CSS */';
  importName = '更新后的测试预设';
  await fileOperation('import', ['user:imported-notes']);
  assert.equal(await page.$eval('[data-preset="user:imported-notes"] .settings-item-title', el => el.textContent), importName, 'Updated names reach the replaced row');
  await fileOperation('import', [], 'error');
  assert.equal(await page.$eval('[data-preset="user:imported-notes"] .settings-preset-info', el => el.classList.contains('has-error')), true, 'Failed updates change the existing information button');
  await page.hover('[data-preset="user:imported-notes"] .settings-preset-info');
  await page.waitForFunction(() => [...document.querySelectorAll('.meo-tooltip.is-visible')].some(el => el.textContent?.includes('Import update failed')));
  await fileOperation('import');
  assert.equal(await page.$eval('[data-preset="user:imported-notes"] .settings-preset-info', el => el.classList.contains('has-error')), false, 'Successful updates clear errors in place');
  assert.equal(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.documentElement.dataset.meoPreviewPreset), 'default', 'Import does not change preview selection');
  await page.click('[data-preset="user:imported-notes"] [data-preset-action="export"]');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="import"] button')!.disabled);
  assert.equal(actions.at(-1)!.action, 'export');
  const beforeRemoval = actions.length;
  await page.click('[data-preset="user:imported-notes"] [data-preset-action="remove"]');
  assert.equal(actions.length, beforeRemoval, 'Opening confirmation does not send a removal request');
  await page.click('[data-preset-confirm="cancel"]');
  assert.ok(await page.$('[data-preset="user:imported-notes"]'), 'Canceling keeps the preset');
  await page.click('[data-preset="user:imported-notes"] [data-preset-action="remove"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.settings-preset-remove-popover'), null);
  assert.equal(await page.$eval('.settings-window', el => (el as HTMLDialogElement).open), true, 'Escape closes only the confirmation');
  await page.click('[data-preset="user:imported-notes"] [data-preset-action="remove"]');
  await page.click('.settings-title');
  assert.equal(await page.$('.settings-preset-remove-popover'), null, 'Clicking outside dismisses confirmation');
  assert.equal(actions.length, beforeRemoval, 'Dismissing confirmation does not remove a preset');
  await fileOperation('remove', [], 'error');
  await fileOperation('remove', ['user:imported-notes']);
  await page.waitForFunction(() => !document.querySelector('[data-preset="user:imported-notes"]'));
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="guide"] button')!.disabled);
  await page.click('.settings-item[data-preset-action="guide"] button');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="guide"] button')!.disabled);
  assert.equal(actions.at(-1)!.language, 'zh-CN');
  await page.click('.settings-close');
  await page.focus('.preview-preset-dropdown'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  assert.equal(await page.$eval('.settings-tab[data-tab="presets"]', el => el.getAttribute('aria-selected')), 'true', 'Keyboard can reach the footer action');
  await page.click('.settings-tab[data-tab="general"]');
  await page.click('[data-setting="language"] [data-value="en"]');
  await page.click('.settings-tab[data-tab="appearance"]'); await page.click('[data-appearance-mode="light"]');
  await page.click('.settings-tab[data-tab="presets"]');
  await page.click('.settings-item[data-preset-action="guide"] button');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-item[data-preset-action="guide"] button')!.disabled);
  assert.equal(actions.at(-1)!.language, 'en', 'Guide requests use the current panel language');
  await page.screenshot({ path: 'tmp/preset-management/02-en-light.png' });
  await page.type('.settings-search', 'paper-notes');
  assert.equal(await page.$$eval('.settings-preset-row[data-preset]', els => els.length), 1);
  assert.equal(await page.$eval('.settings-tab[data-tab="presets"] .settings-tab-badge', el => el.textContent), '1');
  await page.click('.settings-search-clear'); await page.setViewport({ width: 360, height: 780 });
  const bounds = await page.$eval('.settings-window', el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, right: el.getBoundingClientRect().right }));
  assert.ok(bounds.scrollWidth <= bounds.width && bounds.right <= 360, 'Management fits a narrow window');
  await page.screenshot({ path: 'tmp/preset-management/03-en-light-narrow.png' });
  await page.setViewport({ width: 1100, height: 780 });
  await page.type('.settings-search', 'imported-notes');
  assert.ok(await page.$('.settings-empty'), 'Removing the last search match shows an empty result');
  await library.import(manifest.replace('"id": "paper-notes"', '"id": "imported-notes"').replace(preset.name['zh-CN'], importName), async file => (await readCss(file)) + importCss);
  await broadcast();
  await page.waitForSelector('[data-preset="user:imported-notes"]');
  assert.equal(await page.$$eval('.settings-preset-row[data-preset]', els => els.length), 1, 'Adding a matching preset restores only the filtered result');
  await page.click('[data-preset="user:imported-notes"] [data-preset-action="remove"]');
  await page.click('[data-preset-confirm="remove"]');
  await page.waitForSelector('.settings-empty');
  assert.equal(await page.$eval('.settings-search', el => (el as HTMLInputElement).value), 'imported-notes', 'Removing a search match retains the query');
  await page.click('.settings-search-clear');
  assert.equal(await page.$$eval('.settings-preset-row[data-preset]', els => els.length), 6, 'Clearing search restores the remaining catalog');
  assert.deepEqual(errors, []);
  await page.close(); await sibling.close();
  console.log('Preset management: stable DOM during visibility and file operations, keyed add/update/remove, live diagnostics, cancellation/failure, filtered empty results, Default protection, document fallback, keyboard, bilingual search and narrow layout passed.');
} finally { await browser.close(); }
