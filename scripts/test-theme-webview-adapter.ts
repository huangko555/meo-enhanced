import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeThemeDto, ThemeSettingsDto } from '../src/protocol/hostConfigurationEvents';
import { createThemeWebviewAdapter } from '../webview/src/adapters/themeWebviewAdapter';

const themeA = { id: 'theme-a' } as ThemeSettingsDto;
const themeB = { id: 'theme-b' } as ThemeSettingsDto;
const codeA: CodeThemeDto = { name: 'code-a', type: 'dark', colors: {}, tokenColors: [] };
const codeB: CodeThemeDto = { name: 'code-b', type: 'light', colors: {}, tokenColors: [] };
const calls: Array<{ type: string; [key: string]: unknown }> = [];

const adapter = createThemeWebviewAdapter({
  setAppearanceControl(appearance) {
    calls.push({ type: 'control', appearance });
  },
  applyTheme(theme, appearance) {
    calls.push({ type: 'theme', theme: theme.id, appearance });
  },
  setShikiEnabled(enabled) {
    calls.push({ type: 'shiki-enabled', enabled });
  },
  resolveCodeTheme(theme, appearance) {
    calls.push({ type: 'resolve-code', theme: theme?.name ?? null, appearance });
    return theme;
  },
  setShikiTheme(theme) {
    calls.push({ type: 'shiki-theme', theme: theme?.name ?? null });
  },
  refreshMermaidTheme() {
    calls.push({ type: 'mermaid' });
  },
  applyWithEditorViewportPreserved(action) {
    calls.push({ type: 'preserve-start' });
    action();
    calls.push({ type: 'preserve-end' });
  },
  refreshEditorDecorations() {
    calls.push({ type: 'editor' });
  },
  refreshPreview() {
    calls.push({ type: 'preview' });
  },
  postEditorAppearance(appearance) {
    calls.push({ type: 'post', appearance });
  },
  reportUnexpectedError(context, error) {
    calls.push({ type: 'error', context, message: error instanceof Error ? error.message : String(error) });
  }
});

adapter.start({ theme: themeA, codeTheme: codeA, appearance: 'dark', shikiEnabled: true });
assert.deepEqual(calls.splice(0), [
  { type: 'control', appearance: 'dark' },
  { type: 'theme', theme: 'theme-a', appearance: 'dark' },
  { type: 'shiki-enabled', enabled: true },
  { type: 'resolve-code', theme: 'code-a', appearance: 'dark' },
  { type: 'shiki-theme', theme: 'code-a' }
]);
assert.equal(adapter.getAppearance(), 'dark');

adapter.setAppearance('dark', { post: true });
assert.deepEqual(calls.splice(0), [
  { type: 'control', appearance: 'dark' },
  { type: 'post', appearance: 'dark' }
]);

adapter.setAppearance('light', { post: true });
assert.deepEqual(calls.splice(0), [
  { type: 'control', appearance: 'light' },
  { type: 'preserve-start' },
  { type: 'theme', theme: 'theme-a', appearance: 'light' },
  { type: 'resolve-code', theme: 'code-a', appearance: 'light' },
  { type: 'shiki-theme', theme: 'code-a' },
  { type: 'mermaid' },
  { type: 'editor' },
  { type: 'preserve-end' },
  { type: 'post', appearance: 'light' }
]);
assert.equal(adapter.getAppearance(), 'light');

assert.equal(adapter.accept({ type: 'themeChanged', theme: themeB, codeTheme: codeB }), true);
assert.deepEqual(calls.splice(0), [
  { type: 'preserve-start' },
  { type: 'theme', theme: 'theme-b', appearance: 'light' },
  { type: 'mermaid' },
  { type: 'resolve-code', theme: 'code-b', appearance: 'light' },
  { type: 'shiki-theme', theme: 'code-b' },
  { type: 'editor' },
  { type: 'preview' },
  { type: 'preserve-end' }
]);

assert.equal(adapter.accept({ type: 'shikiCodeBlocksChanged', enabled: false, codeTheme: codeA }), true);
assert.deepEqual(calls.splice(0), [
  { type: 'resolve-code', theme: 'code-a', appearance: 'light' },
  { type: 'shiki-theme', theme: 'code-a' },
  { type: 'shiki-enabled', enabled: false }
]);
assert.equal(adapter.accept({ type: 'focusEditor' }), false);

const reported: string[] = [];
const failingAdapter = createThemeWebviewAdapter({
  setAppearanceControl() {},
  applyTheme(theme) {
    if (theme.id === 'theme-b') throw new Error('theme failed');
  },
  setShikiEnabled() {},
  resolveCodeTheme: (theme) => theme,
  setShikiTheme() {},
  refreshMermaidTheme() {},
  applyWithEditorViewportPreserved: (action) => action(),
  refreshEditorDecorations() {},
  refreshPreview() {},
  postEditorAppearance() {},
  reportUnexpectedError(context, error) {
    reported.push(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
});
failingAdapter.start({ theme: themeA, codeTheme: null, appearance: 'dark', shikiEnabled: false });
assert.equal(failingAdapter.accept({ type: 'themeChanged', theme: themeB, codeTheme: null }), true);
assert.deepEqual(reported, ['themeChanged handler: theme failed']);

const repoRoot = path.resolve(import.meta.dir, '..');
const bootstrap = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
assert.equal((bootstrap.match(/createThemeWebviewAdapter\s*\(/g) ?? []).length, 1);
for (const forbidden of [
  'currentThemeSettings',
  'currentCodeTheme',
  'currentEditorAppearance',
  "message.type === 'themeChanged'",
  "message.type === 'shikiCodeBlocksChanged'"
]) {
  assert.equal(bootstrap.includes(forbidden), false, `Theme lifecycle leaked into Bootstrap: ${forbidden}`);
}
assert.doesNotMatch(bootstrap, /const setEditorAppearance\s*=/);
assert.match(bootstrap, /themeAdapter\.start\s*\(/);
assert.match(bootstrap, /themeAdapter\.accept\s*\(message\)/);
assert.match(bootstrap, /themeAdapter\.setAppearance\s*\(/);
assert.match(bootstrap, /themeAdapter\.getAppearance\s*\(\s*\)/);

console.log('Theme Webview Adapter checks passed');
