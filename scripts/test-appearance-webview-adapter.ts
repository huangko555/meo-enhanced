import assert from 'node:assert/strict';
import type { CodeThemeDto } from '../src/protocol/hostConfigurationEvents';
import { createAppearanceWebviewAdapter } from '../webview/src/adapters/appearanceWebviewAdapter';
import { resolveCodeTheme } from '../webview/src/themes/editorLightTheme';

const currentDark: CodeThemeDto = { name: 'Current Dark', type: 'dark', colors: {}, tokenColors: [] };
const currentLight: CodeThemeDto = { name: 'Current Light', type: 'light', colors: {}, tokenColors: [] };

assert.equal(resolveCodeTheme(currentDark, 'dark'), currentDark);
assert.equal(resolveCodeTheme(currentLight, 'light'), currentLight);
assert.notEqual(resolveCodeTheme(currentDark, 'light'), currentDark);
assert.equal(resolveCodeTheme(currentDark, 'light')?.type, 'light');
assert.notEqual(resolveCodeTheme(currentLight, 'dark'), currentLight);
assert.equal(resolveCodeTheme(currentLight, 'dark')?.type, 'dark');

const appliedAppearances: string[] = [];
const appliedCodeThemes: Array<CodeThemeDto | null | undefined> = [];
const appearanceControls: string[] = [];
let previewRefreshes = 0;
let decorationRefreshes = 0;
let previewAutoSyncs = 0;
const adapter = createAppearanceWebviewAdapter({
  setAppearanceControl: (appearance) => appearanceControls.push(appearance),
  applyAppearance: (appearance) => appliedAppearances.push(appearance),
  resolveCodeTheme,
  setCodeTheme: (theme) => appliedCodeThemes.push(theme),
  refreshMermaidTheme: () => undefined,
  applyWithEditorViewportPreserved: (action) => action(),
  refreshEditorDecorations: () => { decorationRefreshes += 1; },
  refreshPreview: () => { previewRefreshes += 1; },
  syncPreviewAutoAppearance: () => { previewAutoSyncs += 1; },
  postEditorAppearance: () => undefined,
  reportUnexpectedError: (_context, error) => { throw error; }
});

adapter.start({ vscodeTheme: currentDark, appearance: 'auto' });
assert.equal(adapter.getAppearance(), 'dark');
assert.deepEqual(appearanceControls, ['auto']);
assert.deepEqual(appliedAppearances, ['dark']);
assert.equal(appliedCodeThemes.at(-1), currentDark);
assert.equal(adapter.accept({ type: 'vscodeCodeThemeChanged', vscodeTheme: currentLight }), true);
assert.equal(adapter.getAppearance(), 'light');
assert.deepEqual(appliedAppearances, ['dark', 'light']);
assert.equal(appliedCodeThemes.at(-1), currentLight);
assert.equal(previewRefreshes, 1);
assert.equal(decorationRefreshes, 1);
assert.equal(previewAutoSyncs, 1);
adapter.setAppearance('dark');
assert.equal(adapter.getAppearance(), 'dark');
assert.deepEqual(appearanceControls, ['auto', 'dark']);
assert.equal(appliedCodeThemes.at(-1)?.type, 'dark');
assert.equal(decorationRefreshes, 2);
assert.equal(previewAutoSyncs, 2);
assert.equal(adapter.accept({ type: 'toggleMode' }), false);

console.log('Appearance Webview Adapter and final code palette checks passed');
