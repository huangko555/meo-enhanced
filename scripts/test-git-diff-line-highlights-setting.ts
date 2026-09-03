import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';

const repoRoot = path.resolve(import.meta.dir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const setting = packageJson.contributes.configuration.properties['meoEnhanced.gitChanges.lineHighlights'];
assert.equal(setting.default, false, 'Source diff line backgrounds must default to disabled');
const gutterSetting = packageJson.contributes.configuration.properties['meoEnhanced.gitChanges.visible'];
assert.equal(gutterSetting.default, false, 'Change location markers must default to hidden');
const detailsSetting = packageJson.contributes.configuration.properties['meoEnhanced.changes.showBeforeContent'];
assert.equal(detailsSetting.default, false, 'Original changed content must default to hidden');

let configuredValue: boolean | undefined;
let configuredGutterValue: boolean | undefined;
let configuredDetailsValue: boolean | undefined;
let gutterExplicit = false;

mock.module('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T): T => (
        key === 'gitChanges.visible'
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
  false,
  'a new user must start with change location markers hidden'
);
gutterExplicit = true;
configuredGutterValue = true;
assert.equal(
  getGitChangesGutterEnabled(createContext().context as never),
  true,
  'an explicit user setting must override the new default'
);
gutterExplicit = false;
configuredGutterValue = undefined;
const legacyGutter = createContext();
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
