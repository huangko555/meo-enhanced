import assert from 'node:assert/strict';
import { projectRawThemeAppearance } from '../src/foundation/vscodeThemeTransition';

const staleDarkTheme = {
  name: 'Previous Dark Theme',
  type: 'dark' as const,
  colors: { 'editor.foreground': '#ffffff' },
  tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff00ff' } }]
};

const immediateLight = projectRawThemeAppearance(staleDarkTheme, 'light');
assert.equal(
  immediateLight.type,
  'dark',
  'A stale raw theme must keep its real type so dark token colors cannot be accepted as a light palette'
);
assert.equal(immediateLight.name, staleDarkTheme.name, 'Raw theme identity should remain unchanged');

const immediateDark = projectRawThemeAppearance({ ...staleDarkTheme, type: 'light' }, 'dark');
assert.equal(
  immediateDark.type,
  'light',
  'A stale light theme must not be relabelled as dark while VS Code configuration catches up'
);

console.log('VS Code theme transition checks passed');
