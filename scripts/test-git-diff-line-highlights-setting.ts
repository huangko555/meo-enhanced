import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';

const repoRoot = path.resolve(import.meta.dir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const setting = packageJson.contributes.configuration.properties['meoEnhanced.gitChanges.lineHighlights'];
assert.equal(setting.default, false, 'Source diff line backgrounds must default to disabled');

let configuredValue: boolean | undefined;
let failNextUpdate = false;
const configurationUpdates: Array<{ key: string; value: boolean; target: number }> = [];

mock.module('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T): T => (configuredValue ?? fallback) as T,
      update: async (key: string, value: boolean, target: number) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          throw new Error('synthetic configuration failure');
        }
        configuredValue = value;
        configurationUpdates.push({ key, value, target });
      }
    })
  }
}));

const {
  GIT_DIFF_LINE_HIGHLIGHTS_DEFAULT_OFF_MIGRATION_KEY,
  GIT_DIFF_LINE_HIGHLIGHTS_SETTING_KEY,
  getGitDiffLineHighlightsEnabled,
  migrateGitDiffLineHighlightsDefaultOff
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

configuredValue = undefined;
assert.equal(getGitDiffLineHighlightsEnabled(), false, 'runtime fallback must match the package default');

configuredValue = true;
const migrated = createContext();
await migrateGitDiffLineHighlightsDefaultOff(migrated.context as never);
assert.equal(configuredValue, false, 'the update migration must disable an existing enabled value');
assert.deepEqual(configurationUpdates.at(-1), {
  key: GIT_DIFF_LINE_HIGHLIGHTS_SETTING_KEY,
  value: false,
  target: 1
});
assert.equal(migrated.state.get(GIT_DIFF_LINE_HIGHLIGHTS_DEFAULT_OFF_MIGRATION_KEY), true);

configuredValue = true;
const updateCountAfterMigration = configurationUpdates.length;
await migrateGitDiffLineHighlightsDefaultOff(migrated.context as never);
assert.equal(configuredValue, true, 'a user must be able to re-enable line backgrounds after migration');
assert.equal(configurationUpdates.length, updateCountAfterMigration, 'the completed migration must be idempotent');

configuredValue = true;
failNextUpdate = true;
const retryable = createContext();
await migrateGitDiffLineHighlightsDefaultOff(retryable.context as never);
assert.equal(
  retryable.state.get(GIT_DIFF_LINE_HIGHLIGHTS_DEFAULT_OFF_MIGRATION_KEY),
  undefined,
  'a failed update must not mark the migration complete'
);
await migrateGitDiffLineHighlightsDefaultOff(retryable.context as never);
assert.equal(configuredValue, false, 'an incomplete migration must retry on the next activation');
assert.equal(retryable.state.get(GIT_DIFF_LINE_HIGHLIGHTS_DEFAULT_OFF_MIGRATION_KEY), true);

console.log('Git diff line highlight default and update migration checks passed');
