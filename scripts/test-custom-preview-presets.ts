import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPreviewPresetLibrary, validatePresetCss, type StoredPreviewPreset } from '../src/host/customPreviewPresets';
import { createCustomPreviewPreset, decodeCustomPreviewPresets, parseCustomPreviewPresetManifest } from '../src/foundation/customPreviewPreset';
import { decodePreviewPresetState, getPreviewPreset, getPreviewPresetCodeTheme, isPreviewPresetEnabled, replaceCustomPreviewPresets, resolvePresetAppearance, resolvePreviewPresetSettings } from '../src/foundation/previewPresets';
import { buildPresetPreviewStyles } from '../src/preview/presetStyles';
import { decodeDisabledPreviewPresets, decodePreviewPresetsChanged, decodePreviewPresetRequest, decodePreviewPresetResponse } from '../src/protocol/previewPresets';
import { decodePreviewRenderRequest } from '../src/protocol/previewRender';
import exportRuntime from '../src/export/runtime';

const saved = new Map<string, unknown>();
let failWrite = false;
let writes = 0;
const storage = { list: async () => [...saved.keys()], read: async (id: string) => saved.get(id)!, write: async (id: string, value: StoredPreviewPreset) => { if (failWrite) throw new Error('Disk unavailable'); writes++; saved.set(id, structuredClone(value)); }, remove: async (id: string) => { saved.delete(id); } };
const library = createPreviewPresetLibrary(storage);
const importExample = async (name: string) => {
  const directory = path.resolve('preview-presets/examples', name);
  return library.import(await readFile(path.join(directory, 'preset.jsonc'), 'utf8'), file => readFile(path.join(directory, file), 'utf8'));
};
const dual = await importExample('paper-notes');
const single = await importExample('github-paper');
assert.equal((saved.get('paper-notes') as StoredPreviewPreset).files['common.css'], await readFile(path.resolve('preview-presets/examples/paper-notes/common.css'), 'utf8'), 'Stored CSS preserves its actual line breaks');
assert.equal(library.list().length, 2);
assert.equal(dual.renderer, 'meo');
assert.equal(single.renderer, 'meo');
assert.equal(single.controls.htmlComments.mode, 'editable');
assert.deepEqual(single.controls.codeColoring, { mode: 'fixed', value: true });
assert.equal(dual.controls.codeColoring.mode, 'editable', 'A named palette does not lock coloring');
assert.equal(resolvePresetAppearance(dual, 'auto', 'dark'), 'dark');
assert.equal(resolvePresetAppearance(single, 'dark', 'dark'), 'light');
assert.equal(single.controls.appearance.mode, 'fixed');
assert.equal(dual.controls.fontFamily.mode, 'fixed');
assert.deepEqual(decodeCustomPreviewPresets(library.list()), library.list());
assert.ok(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), selected: dual.id }));
assert.equal(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), selected: 'user:missing' }), null);
assert.equal(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), disabled: ['default'] }), null, 'Default cannot be hidden over the protocol');
assert.equal(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), disabled: [dual.id], selected: dual.id }), null, 'A disabled preset cannot become selected');
const hideableBuiltIns = ['github-readme', 'newsprint', 'whitey', 'obsidian-minimal'] as const;
for (const id of hideableBuiltIns) {
  assert.deepEqual(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), disabled: [id] })?.disabled, [id]);
  assert.equal(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: library.list(), disabled: [id], selected: id }), null, 'A hidden built-in cannot become selected');
  for (const enabled of [false, true]) assert.ok(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: 'test', action: 'setEnabled', preset: id, enabled, language: 'en' }));
}
for (const id of ['default', ...hideableBuiltIns]) for (const action of ['remove', 'export']) assert.equal(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: 'test', action, preset: id, language: 'en' }), null);
assert.equal(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: 'test', action: 'setEnabled', preset: 'default', enabled: false, language: 'en' }), null);
const allHidden = [...hideableBuiltIns, ...Array.from({ length: 100 }, (_, index) => `user:test-${index}`)];
assert.deepEqual(decodeDisabledPreviewPresets(allHidden), allHidden, 'Hiding built-ins does not consume the 100 custom-preset slots');
assert.equal(decodeDisabledPreviewPresets([...allHidden, 'user:overflow']), null);
assert.ok(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: 'test', action: 'setEnabled', preset: dual.id, enabled: false, language: 'zh-CN' }));
assert.equal(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: 'test', action: 'guide', language: 'auto' }), null, 'Guide routing requires the resolved panel language');
assert.equal(decodePreviewPresetRequest({ type: 'previewPresetRequest', requestId: '', action: 'import', language: 'en' }), null);
assert.equal(decodePreviewPresetResponse({ type: 'previewPresetResult', requestId: 'test', result: { ok: true, value: { changed: 'true' } } }), null);
assert.ok(decodePreviewPresetResponse({ type: 'previewPresetResult', requestId: 'test', result: { ok: false, error: { code: 'operation-failed', message: 'Failed' } } }));
assert.equal(await readFile('preview-presets/preset.schema.json', 'utf8'), await readFile('schemas/custom-preview-preset.schema.json', 'utf8'), 'The online authoring schema stays synchronized with the offline runtime schema');
for (const [filename, alternate] of [['README.md', 'README.zh-CN.md'], ['README.zh-CN.md', 'README.md']]) {
  const guide = await readFile(path.resolve('preview-presets', filename), 'utf8');
  assert.ok(guide.includes(`](${alternate})`), 'Both guides provide a language switch');
  for (const [, href] of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const target = path.resolve('preview-presets', href);
    const file = href.endsWith('/') ? path.join(target, 'preset.jsonc') : target;
    assert.ok(await readFile(file), `${filename}: ${href} resolves inside the standalone catalog`);
  }
}
replaceCustomPreviewPresets(library.list(), ['default', ...hideableBuiltIns]);
assert.equal(isPreviewPresetEnabled('default'), true, 'Default remains available even if a caller passes it as disabled');
for (const id of hideableBuiltIns) {
  assert.equal(isPreviewPresetEnabled(id), false);
  const preferences = { [id]: { appearance: 'dark', contentWidth: 'responsive' } };
  const state = decodePreviewPresetState({ preset: id, preferences });
  assert.equal(state?.preset, 'default', 'A hidden built-in restores to Default');
  assert.ok(state?.preferences[id], 'Hiding retains the preset preferences');
}
replaceCustomPreviewPresets(library.list());
for (const id of hideableBuiltIns) assert.equal(isPreviewPresetEnabled(id), true);
assert.equal(getPreviewPreset('default').custom, undefined);
const preference = { preset: single.id, preferences: { [single.id]: { appearance: 'dark', contentWidth: 'reference' } } };
assert.equal(decodePreviewPresetState(preference)?.preferences[single.id]?.appearance, 'light');
assert.ok(decodePreviewRenderRequest({ type: 'requestPreviewRender', requestId: 'custom', text: '# Test', uiLanguage: 'en', environment: { previewFontFamily: '' }, preset: dual.id, presetRevision: dual.custom!.revision }));
assert.equal(decodePreviewRenderRequest({ type: 'requestPreviewRender', requestId: 'custom', text: '# Test', uiLanguage: 'en', environment: { previewFontFamily: '' }, preset: dual.id, presetRevision: 'invalid' }), null);

const basic = { schemaVersion: 1, id: 'test-style', name: 'Test', description: 'Example', themes: { light: { css: 'light.css' } } };
const adjustable = await library.import(JSON.stringify({ ...basic, id: 'adjustable-font', controls: { fontFamily: { mode: 'editable' } } }), async () => '.meo-export-doc { font-family: Georgia, serif; }');
assert.equal(adjustable.controls.fontFamily.mode, 'editable');
assert.deepEqual(decodeCustomPreviewPresets([adjustable]), [adjustable], 'Font policy survives catalog transport');
const adjustableReload = createPreviewPresetLibrary(storage);
assert.deepEqual(await adjustableReload.load(), []);
assert.equal(adjustableReload.get(adjustable.id)?.controls.fontFamily.mode, 'editable');
for (const base of ['default', 'github-readme'] as const) {
  const preset = createCustomPreviewPreset(parseCustomPreviewPresetManifest({ ...basic, base, controls: { fontFamily: { mode: 'editable' } } }), { light: '.meo-export-doc { font-family: Georgia, serif; }' }, 'a'.repeat(64));
  const styles = buildPresetPreviewStyles(preset.id, { previewFontFamily: 'Arial' }, 'light', 'responsive', preset);
  assert.ok(styles.lastIndexOf('"Arial"') > styles.lastIndexOf('font-family: Georgia'), 'Selected body font wins over preset CSS on both bases');
  assert.ok(!buildPresetPreviewStyles(preset.id, { previewFontFamily: '' }, 'light', 'responsive', preset).includes('"Arial"'));
}
await library.remove(adjustable.id);
const bilingualText = { en: 'A reading style. Differences belong in this explanation.', 'zh-CN': '阅读样式，相关差异也写在这段说明中。' };
const bilingualName = { en: 'Paper notes', 'zh-CN': '纸面笔记' };
const bilingual = await library.import(JSON.stringify({ ...basic, id: 'bilingual', name: bilingualName, description: bilingualText }), async () => '.meo-export-doc { color: #333; }');
assert.deepEqual(bilingual.name, bilingualName);
assert.deepEqual((saved.get('bilingual') as StoredPreviewPreset).manifest.name, bilingualName);
assert.deepEqual(decodeCustomPreviewPresets([bilingual])?.[0].name, bilingualName);
assert.deepEqual(bilingual.description, bilingualText);
assert.deepEqual((saved.get('bilingual') as StoredPreviewPreset).manifest.description, bilingualText, 'Saving preserves both description translations');
assert.deepEqual(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: [bilingual] })?.presets[0].description, bilingualText, 'Catalog transport preserves both languages');
const bilingualReload = createPreviewPresetLibrary(storage);
assert.deepEqual(await bilingualReload.load(), []);
assert.deepEqual(bilingualReload.get(bilingual.id)?.description, bilingualText, 'Reloading preserves both languages');
assert.deepEqual(bilingualReload.get(bilingual.id)?.name, bilingualName, 'Reloading preserves both names');
await library.remove(bilingual.id);
for (const provided of ['Example', { en: 'Example' }, { 'zh-CN': 'Example' }]) {
  const manifest = parseCustomPreviewPresetManifest({ ...basic, name: provided, description: provided });
  const preset = createCustomPreviewPreset(manifest, { light: '.meo-export-doc { color: #333; }' }, 'a'.repeat(64));
  assert.deepEqual(preset.description, { en: 'Example', 'zh-CN': 'Example' }, 'Plain text and a single translation work in both UI languages');
  assert.deepEqual(preset.name, { en: 'Example', 'zh-CN': 'Example' });
  assert.deepEqual(decodeCustomPreviewPresets([preset]), [preset]);
}
for (const value of [
  { ...basic, themes: {} }, { ...basic, base: 'user:paper-notes' }, { ...basic, id: '../escape' },
  { ...basic, themes: { light: { css: '../escape.css' } } }, { ...basic, themes: { light: { css: 'C:/escape.css' } } },
  { ...basic, themes: { light: { css: 'light.css', codeTheme: 'unknown' } } },
  ...[null, [], {}, { fr: 'Example' }, { en: '' }, { en: ' ' }, { en: 1 }, { en: 'x'.repeat(501) }, { en: 'Example', 'zh-CN': null }]
    .map(description => ({ ...basic, description })),
  ...[null, [], {}, { fr: 'Example' }, { en: '' }, { en: 1 }, { en: 'x'.repeat(81) }]
    .map(name => ({ ...basic, name })),
  ...[null, [], { unknown: {} }, { htmlComments: {} }, { htmlComments: { mode: 'unsupported' } },
    { fontFamily: null }, { fontFamily: {} }, { fontFamily: { mode: 'unsupported' } }, { fontFamily: { mode: 'fixed', value: true } },
    { htmlComments: { mode: 'editable', value: true } }, { codeColoring: { mode: 'fixed' } },
    { codeColoring: { mode: 'fixed', value: 'false' } }, { codeColoring: { mode: 'fixed', value: true, extra: 1 } }
  ].map(controls => ({ ...basic, controls }))
]) assert.throws(() => parseCustomPreviewPresetManifest(value));
assert.deepEqual(parseCustomPreviewPresetManifest({ ...basic, controls: {} }).controls, {});
for (const base of ['default', 'github-readme'] as const) {
  for (const controls of [undefined, { htmlComments: { mode: 'editable' }, codeColoring: { mode: 'editable' } },
    { htmlComments: { mode: 'fixed', value: true }, codeColoring: { mode: 'fixed', value: false } },
    { htmlComments: { mode: 'fixed', value: false }, codeColoring: { mode: 'fixed', value: true } }]) {
    const manifest = parseCustomPreviewPresetManifest({ ...basic, base, controls, themes: { light: { css: 'light.css', codeTheme: 'light-plus' } } });
    const preset = createCustomPreviewPreset(manifest, { light: ':root { --meo-bg: #fafafa; }' }, 'a'.repeat(64));
    assert.equal(preset.renderer, 'meo');
    assert.deepEqual(decodeCustomPreviewPresets([preset]), [preset], 'Control policies survive protocol decoding');
    assert.equal(decodeCustomPreviewPresets([{ ...preset, controls: { ...preset.controls, codeColoring: { mode: 'fixed' } } }]), null);
    for (const userValue of [true, false]) {
      const settings = resolvePreviewPresetSettings(preset.id, { previewFontFamily: '', previewShowComments: userValue, previewSourceColoring: userValue }, preset);
      const comments = preset.controls.htmlComments.mode === 'editable' ? userValue : preset.controls.htmlComments.value;
      const coloring = preset.controls.codeColoring.mode === 'editable' ? userValue : preset.controls.codeColoring.value;
      assert.equal(settings.previewShowComments, comments);
      assert.equal(settings.previewSourceColoring, coloring);
      const markdownText = 'first\nsecond\n\n<!-- visible preset comment -->\n\n```typescript\nconst answer = 42;\n```';
      const environment = { previewFontFamily: '', previewShowComments: userValue, previewSourceColoring: userValue };
      const preview = exportRuntime.renderPreviewDocument({ markdownText, sourceDocumentPath: 'C:/tmp/test.md', uiLanguage: 'en', styleEnvironment: environment, preset: preset.id, presetDefinition: preset });
      assert.equal(preview.html.includes('visible preset comment'), comments);
      assert.match(preview.html, /<br(?:\s|>)/, 'Both style bases use MEO line breaks');
      for (const target of ['html', 'pdf'] as const) {
        const result = await exportRuntime.renderExportHtmlDocument({ readingSnapshot: { snapshotId: 'controls', text: markdownText, appearance: 'light', uiLanguage: 'en', environment, preset: preset.id, presetRevision: preset.custom!.revision }, presetDefinition: preset,
          sourceDocumentPath: 'C:/tmp/test.md', outputFilePath: `C:/tmp/test.${target}`, target, mermaidRuntimeSrc: '', baseHref: '', title: 'Controls', shikiLanguageAssetsRoot: path.resolve('webview/dist') });
        assert.equal(result.htmlDocument.includes('visible preset comment'), comments, `${base}: ${target} honors comments`);
        assert.equal(/<span[^>]+style="color:/i.test(result.htmlDocument), coloring, `${base}: ${target} honors coloring even with a named palette`);
        if (base === 'github-readme') assert.ok(result.htmlDocument.includes('class="meo-export-doc markdown-body"'), 'GitHub CSS remains active in exports');
      }
    }
  }
}
const builtinGithub = exportRuntime.renderPreviewDocument({ markdownText: 'first\nsecond\n\n<!-- visible preset comment -->', sourceDocumentPath: 'C:/tmp/test.md', uiLanguage: 'en', styleEnvironment: { previewFontFamily: '', previewShowComments: true }, preset: 'github-readme' });
assert.ok(!builtinGithub.html.includes('visible preset comment') && !/<br(?:\s|>)/.test(builtinGithub.html), 'Built-in GitHub retains its rendering rules');
for (const css of [
  'body { background: red; }', '.toolbar { color: red; }', '.meo-export-doc + div { color: red; }',
  '@import "remote.css";', '@font-face { font-family: test; src: url(font.woff2); }',
  '.meo-export-doc { background: url(https://example.com/image.png); }',
  String.raw`.meo-export-doc { background: \75rl(secret.png); }`,
  '.meo-export-doc { h1 { color: red; } }', '.meo-export-doc { color: red;',
  '@page { size: Letter; }', '@page :first { margin: 10mm; }',
  '@page { @top-left { content: "header"; } }', '@page { margin: url(secret.png); }'
]) assert.throws(() => validatePresetCss(css, 'invalid.css'));
assert.ok(validatePresetCss('@media (max-width: 600px) { .meo-export-doc :is(th, td) { padding: 8px; } }', 'valid.css'));
assert.ok(validatePresetCss('@page { margin: 0; margin-left: 12mm; }', 'legacy-page.css'));
assert.ok(validatePresetCss('@media print { @page { margin: var(--legacy-page-margin); } }', 'legacy-page.css'));
const marginCss = ':root { --legacy-page-margin: 12mm; } @media print { @page { margin: 0; margin-left: var(--legacy-page-margin); } }';
const marginPreset = await library.import(JSON.stringify({ ...basic, id: 'page-margins' }), async () => marginCss);
const marginExport = await exportRuntime.renderExportHtmlDocument({
  readingSnapshot: { snapshotId: 'margins', text: '# Page margins', appearance: 'light', uiLanguage: 'en', environment: { previewSourceColoring: false }, preset: marginPreset.id },
  presetDefinition: marginPreset, sourceDocumentPath: 'C:/tmp/test.md', outputFilePath: 'C:/tmp/test.pdf', target: 'pdf',
  mermaidRuntimeSrc: '', baseHref: '', title: 'Page margins', shikiLanguageAssetsRoot: ''
});
assert.ok(marginExport.htmlDocument.includes(marginCss), 'Imported page margins reach the PDF renderer without losing zero values or variables');
const defaultPageRule = marginExport.htmlDocument.indexOf('@page { size: A4; margin: 20mm;');
assert.ok(defaultPageRule >= 0 && defaultPageRule < marginExport.htmlDocument.indexOf(marginCss), 'User page margins follow the defaults in the CSS cascade');
await library.remove(marginPreset.id);

const before = saved.get('paper-notes');
await assert.rejects(library.import(JSON.stringify({ ...basic, id: 'paper-notes' }), async () => 'body { color: red; }'));
await assert.rejects(library.import('{ invalid JSON }', async () => ''));
await assert.rejects(library.import(JSON.stringify({ ...basic, id: 'paper-notes' }), async () => { throw new Error('Missing CSS'); }));
failWrite = true;
await assert.rejects(library.import(JSON.stringify({ ...basic, id: 'paper-notes' }), async () => '.meo-export-doc { color: red; }'));
failWrite = false;
assert.ok(library.diagnostics().some(issue => issue.preset === dual.id && issue.message === 'Disk unavailable'));
assert.equal(saved.get('paper-notes'), before);
assert.equal(library.get(dual.id), dual);
const beforeReload = writes;
const restarted = createPreviewPresetLibrary(storage);
assert.deepEqual(await restarted.load(), []);
assert.deepEqual(restarted.list(), library.list(), 'Saved packages restore identical styles and revisions without original files');
assert.equal(writes, beforeReload, 'Loading complete packages does not rewrite their contents');
failWrite = true;
const readOnlyLibrary = createPreviewPresetLibrary(storage);
assert.deepEqual(await readOnlyLibrary.load(), []);
assert.deepEqual(readOnlyLibrary.list(), library.list(), 'Read-only storage can still load saved packages');
failWrite = false;
assert.deepEqual(await restarted.load(), []);

const environment = { previewFontFamily: 'Georgia', previewSourceColoring: true, editorBackgroundColor: '#23272b' };
const text = '# Test\n\n> [!NOTE]\n> Note\n\n```typescript\nconst value = 42;\n```';
const changedEditorEnvironment = { ...environment, editorBackgroundColor: '#302010', editorForegroundColor: '#fedcba',
  codeBlockBackgroundColor: '#503010', sideBarBackgroundColor: '#403010', panelBorderColor: '#ebba99',
  frontmatterKeyColor: '#edbc98', frontmatterValueColor: '#cba987', frontmatterPillBackgroundColor: '#543210',
  meoThemeColors: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`base0${index + 1}`, '#ff0099'])),
  previewCodePalettes: { light: { foreground: '#ff0099', comment: '#ff0099', keyword: '#ff0099', string: '#ff0099', number: '#ff0099', type: '#ff0099', property: '#ff0099', link: '#ff0099' },
    dark: { foreground: '#ff0099', comment: '#ff0099', keyword: '#ff0099', string: '#ff0099', number: '#ff0099', type: '#ff0099', property: '#ff0099', link: '#ff0099' } } };
assert.equal(getPreviewPresetCodeTheme(getPreviewPreset('default'), 'dark'), undefined);
assert.equal(getPreviewPresetCodeTheme(getPreviewPreset('github-readme'), 'light'), 'github-light-default');
assert.notEqual(buildPresetPreviewStyles('default', environment, 'dark'), buildPresetPreviewStyles('default', changedEditorEnvironment, 'dark'), 'Default keeps editor color inheritance');
for (const base of ['default', 'github-readme'] as const) {
  const manifest = parseCustomPreviewPresetManifest({ ...basic, base, themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } } });
  const fixedPalettePreset = createCustomPreviewPreset(manifest, { light: '', dark: '' }, 'a'.repeat(64));
  for (const appearance of ['light', 'dark'] as const) {
    const styles = buildPresetPreviewStyles(fixedPalettePreset.id, environment, appearance, 'responsive', fixedPalettePreset);
    assert.equal(styles, buildPresetPreviewStyles(fixedPalettePreset.id, changedEditorEnvironment, appearance, 'responsive', fixedPalettePreset), `${base}/${appearance}: unspecified custom colors use a fixed base`);
    assert.ok(!styles.includes('--vscode-'), 'Fixed base colors do not reference editor variables');
    const expectedTheme = base === 'default' ? appearance === 'light' ? 'light-plus' : 'dark-plus'
      : appearance === 'light' ? 'github-light-default' : 'github-dark-default';
    assert.equal(getPreviewPresetCodeTheme(fixedPalettePreset, appearance), expectedTheme);
    const renderFixedPalette = (styleEnvironment: typeof environment) => exportRuntime.renderExportHtmlDocument({
      readingSnapshot: { snapshotId: 'fixed-palette', text, appearance, uiLanguage: 'en', environment: styleEnvironment,
        preset: fixedPalettePreset.id, presetRevision: fixedPalettePreset.custom!.revision,
        codeTheme: { name: 'Editor-only palette', type: appearance, colors: {}, tokenColors: [{ scope: ['keyword', 'variable', 'constant'], settings: { foreground: '#ff0099' } }] } },
      presetDefinition: fixedPalettePreset, sourceDocumentPath: 'C:/tmp/test.md', outputFilePath: 'C:/tmp/test.html', target: 'html',
      mermaidRuntimeSrc: '', baseHref: '', title: 'Fixed palette', shikiLanguageAssetsRoot: path.resolve('webview/dist')
    });
    const fixedHtml = (await renderFixedPalette(environment)).htmlDocument;
    assert.equal(fixedHtml, (await renderFixedPalette(changedEditorEnvironment)).htmlDocument, `${base}/${appearance}: exports ignore editor colors and syntax palettes`);
    assert.ok(!fixedHtml.toLowerCase().includes('#ff0099'), 'The captured editor syntax palette cannot leak into an export');
    const explicitPalette = createCustomPreviewPreset({ ...manifest, themes: { ...manifest.themes, [appearance]: { css: `${appearance}.css`, codeTheme: 'github-light-default' } } }, fixedPalettePreset.custom!.css, 'b'.repeat(64));
    assert.equal(getPreviewPresetCodeTheme(explicitPalette, appearance), 'github-light-default', 'The author can explicitly choose a palette');
  }
}
const preview = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/tmp/test.md', uiLanguage: 'en', styleEnvironment: environment, preset: dual.id, presetDefinition: dual });
assert.equal(preview.presetRevision, dual.custom!.revision);
const options = { readingSnapshot: { snapshotId: 'custom', text, appearance: 'dark' as const, uiLanguage: 'en' as const, environment, preset: dual.id, presetRevision: dual.custom!.revision }, presetDefinition: dual, sourceDocumentPath: 'C:/tmp/test.md', outputFilePath: 'C:/tmp/test.html', target: 'html' as const, mermaidRuntimeSrc: '', baseHref: '', title: 'Test', shikiLanguageAssetsRoot: path.resolve('webview/dist') };
const exporting = exportRuntime.renderExportHtmlDocument(options);
const updated = await library.import(JSON.stringify({ ...basic, id: 'paper-notes' }), async () => ':root { --meo-bg: #eeeeee; }');
assert.ok(!library.diagnostics().some(issue => issue.preset === dual.id), 'Successful updates clear the preset error');
assert.notEqual(updated.custom!.revision, dual.custom!.revision);
const html = await exporting;
assert.ok(html.htmlDocument.includes(preview.styles.dark), 'Export freezes the exact Preview style before updates');
assert.ok(!html.htmlDocument.includes('--meo-bg: #eeeeee'));
const word = await exportRuntime.renderExportHtmlDocument({ ...options, target: 'docx' });
assert.ok(word.htmlDocument.includes('--meo-bg: #ffffff'));
assert.ok(!word.htmlDocument.includes('--paper-accent') && !word.htmlDocument.includes('paper-notes'));
const githubPreview = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/tmp/test.md', uiLanguage: 'en', preset: single.id, presetDefinition: single });
assert.ok(githubPreview.html.includes('meo-export-alert-note'));
assert.equal(githubPreview.styles.dark, githubPreview.styles.light, 'Single-theme presets use the supported style in every pipeline');
await library.remove(single.id);
replaceCustomPreviewPresets(library.list());
assert.equal(decodePreviewPresetState(preference)?.preset, 'default');
saved.set('broken', {});
const invalidReload = createPreviewPresetLibrary(storage);
assert.equal((await invalidReload.load()).length, 1);
assert.deepEqual(invalidReload.diagnostics(), [{ preset: 'user:broken', message: 'broken: preset: expected an object' }]);
assert.ok(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: invalidReload.list(), diagnostics: invalidReload.diagnostics() }));
assert.equal(decodePreviewPresetsChanged({ type: 'previewPresetsChanged', presets: [], diagnostics: [{ preset: 'default', message: 'invalid' }] }), null);
assert.equal(invalidReload.list().length, 1);
assert.deepEqual(saved.get('broken'), {}, 'Invalid records are not rewritten');
replaceCustomPreviewPresets([]);
for (const id of ['default', 'github-readme', 'newsprint', 'whitey', 'obsidian-minimal']) {
  const example = await importExample(id);
  assert.equal(example.id, `user:${id}`, 'Standard examples import as custom copies without replacing built-ins');
  assert.deepEqual(example.controls.appearance.options, id === 'newsprint' ? ['light'] : ['auto', 'light', 'dark']);
  assert.ok(!example.description.en.includes('MEO Markdown rendering'));
}
console.log('Custom preset import, persistence, recovery, CSS scope, theme support and frozen export checks passed.');
