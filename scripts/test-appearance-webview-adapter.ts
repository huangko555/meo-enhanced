import assert from 'node:assert/strict';
import type { CodeThemeDto } from '../src/protocol/hostConfigurationEvents';
import { createAppearanceWebviewAdapter } from '../webview/src/adapters/appearanceWebviewAdapter';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { resolveFinalCodePalette } from '../webview/src/application/finalCodePalette';

const currentDark: CodeThemeDto = {
  name: 'Current Dark',
  type: 'dark',
  colors: { 'editor.foreground': '#fefefe' },
  tokenColors: [
    { scope: 'keyword', settings: { foreground: '#123456' } },
    { scope: 'string', settings: { foreground: '#abcdef' } }
  ]
};
const currentLight: CodeThemeDto = { name: 'Current Light', type: 'light', colors: {}, tokenColors: [] };
const fallbackLight: CodeThemeDto = {
  name: 'Fallback Light',
  type: 'light',
  colors: { 'editor.foreground': '#24292f' },
  tokenColors: [{ scope: 'keyword', settings: { foreground: '#cf222e' } }]
};
const sourceFallbackLight: CodeThemeDto = {
  name: 'Synthetic Source Light',
  type: 'light',
  colors: { 'editor.foreground': '#000000' },
  tokenColors: [
    { scope: 'keyword', settings: { foreground: '#0000ff' } },
    { scope: 'punctuation.definition.list.begin.markdown', settings: { foreground: '#0070c1' } }
  ]
};

const currentPalette = resolveFinalCodePalette(currentDark, fallbackLight, 'dark');
assert.equal(currentPalette.theme, currentDark);
assert.equal(currentPalette.sourceTokens.keyword, '#123456');
assert.equal(currentPalette.sourceTokens.string, '#abcdef');
assert.equal(
  currentPalette.sourceTokens.listMarker,
  '#fefefe',
  'A theme without a Markdown list rule must render list markers with the native editor foreground'
);
assert.equal(currentPalette.preview.foreground, '#fefefe');
const inversePalette = resolveFinalCodePalette(currentDark, fallbackLight, 'light', sourceFallbackLight);
assert.equal(inversePalette.theme, fallbackLight);
assert.equal(inversePalette.sourceTheme, sourceFallbackLight);
assert.notEqual(inversePalette.theme, currentDark);
assert.equal(inversePalette.theme?.type, 'light');
assert.equal(
  inversePalette.sourceTokens.keyword,
  '#0000ff',
  'Source must use the explicitly supplied light fallback when MEO is light but VS Code is dark'
);
assert.equal(inversePalette.sourceTokens.listMarker, '#0070c1');
assert.equal(
  inversePalette.preview.keyword,
  '#cf222e',
  'Preview must keep its appearance-matched palette independently from Source'
);

const sourceVariables = new Map<string, string>();
const appliedShikiThemes: unknown[] = [];
const codePaletteAdapter = createCodePaletteWebviewAdapter({
  sourceStyle: { setProperty: (name, value) => { sourceVariables.set(name, value); } },
  setShikiTheme: (theme) => appliedShikiThemes.push(theme)
});
const productionInversePalette = codePaletteAdapter.resolve(currentDark, 'light');
assert.equal(productionInversePalette.theme?.type, 'light');
assert.equal(
  productionInversePalette.theme?.name,
  'light-plus',
  'Manual light appearance must use the bundled VS Code Light+ palette'
);
assert.notEqual(
  productionInversePalette.sourceTokens.keyword,
  '#123456',
  'The production adapter must not reuse current dark tokens in light Source mode'
);
assert.equal(
  productionInversePalette.sourceTheme.name,
  'light-plus',
  'Source and fenced code must share the bundled VS Code Light+ fallback'
);
const productionDarkInversePalette = codePaletteAdapter.resolve(currentLight, 'dark');
assert.equal(
  productionDarkInversePalette.sourceTheme.name,
  'dark-plus',
  'Source and fenced code must share the bundled VS Code Dark+ fallback'
);
const unresolvedCurrentTheme = codePaletteAdapter.resolve({
  name: 'Unresolved Current Dark',
  type: 'dark',
  colors: {},
  tokenColors: []
}, 'dark');
assert.equal(
  unresolvedCurrentTheme.sourceTheme.name,
  'dark-plus',
  'An unresolved same-appearance theme must fall back instead of flattening every token to one color'
);
assert.notEqual(
  unresolvedCurrentTheme.sourceTokens.keyword,
  unresolvedCurrentTheme.sourceTokens.foreground,
  'The unresolved-theme fallback must preserve syntax color distinctions'
);
codePaletteAdapter.apply(currentPalette);
assert.equal(sourceVariables.get('--meo-token-keyword-color'), '#123456');
assert.equal(appliedShikiThemes.at(-1), currentDark);

const appliedAppearances: string[] = [];
const appliedCodePalettes: ReturnType<typeof resolveFinalCodePalette>[] = [];
const appearanceControls: string[] = [];
let decorationRefreshes = 0;
let previewAutoSyncs = 0;
const adapter = createAppearanceWebviewAdapter({
  setAppearanceControl: (appearance) => appearanceControls.push(appearance),
  applyAppearance: (appearance) => appliedAppearances.push(appearance),
  resolveCodePalette: codePaletteAdapter.resolve,
  applyCodePalette: (palette) => {
    appliedCodePalettes.push(palette);
    codePaletteAdapter.apply(palette);
  },
  refreshMermaidTheme: () => undefined,
  applyWithEditorViewportPreserved: (action) => action(),
  refreshEditorDecorations: () => { decorationRefreshes += 1; },
  syncPreviewAutoAppearance: () => { previewAutoSyncs += 1; },
  postEditorAppearance: () => undefined,
  reportUnexpectedError: (_context, error) => { throw error; }
});

adapter.start({ vscodeTheme: currentDark, appearance: 'auto' });
assert.equal(adapter.getAppearance(), 'dark');
assert.deepEqual(appearanceControls, ['auto']);
assert.deepEqual(appliedAppearances, ['dark']);
assert.equal(appliedCodePalettes.at(-1)?.theme, currentDark);
assert.equal(adapter.accept({
  type: 'vscodeCodeThemeChanged',
  appearance: 'light',
  vscodeTheme: currentDark
} as never), true);
assert.equal(adapter.getAppearance(), 'light');
assert.deepEqual(appliedAppearances, ['dark', 'light']);
assert.equal(
  appliedCodePalettes.at(-1)?.theme?.type,
  'light',
  'Auto must switch appearance immediately while rejecting stale dark token colors'
);
assert.notEqual(appliedCodePalettes.at(-1)?.theme, currentDark);
assert.notEqual(
  appliedCodePalettes.at(-1)?.sourceTokens.keyword,
  '#123456',
  'A stale raw theme must not briefly recolor Source during a VS Code theme transition'
);
assert.equal(sourceVariables.get('--meo-token-heading-color'), appliedCodePalettes.at(-1)?.sourceTokens.heading);
assert.equal((appliedShikiThemes.at(-1) as CodeThemeDto).type, 'light');
assert.equal(decorationRefreshes, 1);
assert.equal(previewAutoSyncs, 1);
adapter.setAppearance('dark');
assert.equal(adapter.getAppearance(), 'dark');
assert.deepEqual(appearanceControls, ['auto', 'dark']);
assert.equal(appliedCodePalettes.at(-1)?.theme?.type, 'dark');
assert.equal(adapter.getCodePalette('light').theme?.type, 'light');
assert.equal(decorationRefreshes, 2);
assert.equal(previewAutoSyncs, 2);
assert.equal(adapter.accept({ type: 'toggleMode' }), false);

console.log('Appearance Webview Adapter and final code palette checks passed');
