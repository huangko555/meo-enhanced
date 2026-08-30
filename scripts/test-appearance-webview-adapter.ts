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

const currentPalette = resolveFinalCodePalette(currentDark, fallbackLight, 'dark');
assert.equal(currentPalette.theme, currentDark);
assert.equal(currentPalette.sourceTokens.keyword, '#123456');
assert.equal(currentPalette.sourceTokens.string, '#abcdef');
assert.equal(currentPalette.preview.foreground, '#fefefe');
const inversePalette = resolveFinalCodePalette(currentDark, fallbackLight, 'light');
assert.notEqual(inversePalette.theme, currentDark);
assert.equal(inversePalette.theme?.type, 'light');
assert.notEqual(inversePalette.sourceTokens.keyword, '#123456');

const sourceVariables = new Map<string, string>();
const appliedShikiThemes: unknown[] = [];
const codePaletteAdapter = createCodePaletteWebviewAdapter({
  sourceStyle: { setProperty: (name, value) => { sourceVariables.set(name, value); } },
  setShikiTheme: (theme) => appliedShikiThemes.push(theme)
});
const productionInversePalette = codePaletteAdapter.resolve(currentDark, 'light');
assert.equal(productionInversePalette.theme?.type, 'light');
assert.notEqual(productionInversePalette.sourceTokens.keyword, '#123456');
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
  applyCodePalette: (palette) => appliedCodePalettes.push(palette),
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
