import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';

const repoRoot = path.resolve(import.meta.dir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const setting = packageJson.contributes.configuration.properties['meoEnhanced.gitChanges.lineHighlights'];
assert.equal(setting.default, false, 'Source diff line backgrounds must default to disabled');
const gutterSetting = packageJson.contributes.configuration.properties['meoEnhanced.gitChanges.visible'];
assert.equal(gutterSetting.default, true, 'Comparison must default to enabled');
const baselineSetting = packageJson.contributes.configuration.properties['meoEnhanced.changes.baseline'];
assert.equal(baselineSetting.default, 'current-edit', 'New users must compare with the last saved version');
const detailsSetting = packageJson.contributes.configuration.properties['meoEnhanced.changes.showBeforeContent'];
assert.equal(detailsSetting.default, false, 'Original changed content must default to hidden');

let configuredValue: boolean | undefined;
let configuredGutterValue: boolean | undefined;
let configuredDetailsValue: boolean | undefined;
let configuredBaseline: string | undefined;
let gutterExplicit = false;

mock.module('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T): T => (
        key === 'changes.baseline'
          ? configuredBaseline ?? fallback
          : key === 'gitChanges.visible'
            ? configuredGutterValue ?? fallback
            : key === 'changes.showBeforeContent'
              ? configuredDetailsValue ?? fallback
              : configuredValue ?? fallback
      ) as T,
      inspect: (key: string) => key === 'gitChanges.visible' && gutterExplicit
        ? { globalValue: configuredGutterValue }
        : {}
    })
  }
}));

const {
  GIT_CHANGES_GUTTER_KEY,
  getGitChangesGutterEnabled,
  getDiffBaselineMode,
  getGitDiffDetailsVisible,
  getGitDiffLineHighlightsEnabled
} = await import('../src/shared/extensionConfig');

const createContext = () => {
  const state = new Map<string, unknown>();
  return {
    context: {
      globalState: {
        get: <T>(key: string, fallback?: T): T | undefined => (state.has(key) ? state.get(key) as T : fallback),
        update: async (key: string, value: unknown) => {
          state.set(key, value);
        }
      }
    },
    state
  };
};

gutterExplicit = false;
configuredGutterValue = undefined;
assert.equal(
  getGitChangesGutterEnabled(createContext().context as never),
  true,
  'a new user must start with comparison enabled'
);
assert.equal(getDiffBaselineMode(), 'current-edit', 'runtime baseline must select the second menu option for new users');
for (const mode of ['recent-save', 'git-head'] as const) {
  configuredBaseline = mode;
  assert.equal(getDiffBaselineMode(), mode, 'an existing comparison baseline must remain effective');
}
configuredBaseline = undefined;
gutterExplicit = true;
configuredGutterValue = false;
assert.equal(
  getGitChangesGutterEnabled(createContext().context as never),
  false,
  'an explicit disabled setting must override the new enabled default'
);
gutterExplicit = false;
configuredGutterValue = undefined;
const legacyGutter = createContext();
await legacyGutter.context.globalState.update(GIT_CHANGES_GUTTER_KEY, false);
assert.equal(
  getGitChangesGutterEnabled(legacyGutter.context as never),
  false,
  'an existing disabled legacy preference must remain disabled'
);
await legacyGutter.context.globalState.update(GIT_CHANGES_GUTTER_KEY, true);
assert.equal(
  getGitChangesGutterEnabled(legacyGutter.context as never),
  true,
  'an existing legacy user preference must remain effective'
);

configuredValue = undefined;
assert.equal(getGitDiffLineHighlightsEnabled(), false, 'runtime fallback must match the package default');

configuredValue = true;
assert.equal(getGitDiffLineHighlightsEnabled(), true, 'an existing explicit line-background preference must remain enabled');

configuredDetailsValue = undefined;
assert.equal(getGitDiffDetailsVisible(), false, 'runtime fallback for original changed content must match the package default');

configuredDetailsValue = true;
assert.equal(getGitDiffDetailsVisible(), true, 'an explicit original-content preference must remain enabled');

console.log('Git diff display defaults and preference preservation checks passed');
