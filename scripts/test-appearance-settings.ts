import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAppearanceSettingsOwner,
  EDITOR_APPEARANCE_SETTING_KEY,
  PREVIEW_APPEARANCE_SETTING_KEY,
  PREVIEW_FONT_FAMILY_SETTING_KEY,
  PREVIEW_SOURCE_COLORING_SETTING_KEY,
  type AppearanceSettingsStore
} from '../src/shared/appearanceSettings';
import { EDITOR_APPEARANCE_STATE_KEY } from '../src/shared/editorAppearance';
import {
  PREVIEW_APPEARANCE_STATE_KEY,
  PREVIEW_FONT_FAMILY_STATE_KEY,
  PREVIEW_SOURCE_COLORING_STATE_KEY
} from '../src/shared/preview';

const createStore = (options: {
  legacy?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  explicit?: readonly string[];
  failConfigurationOnce?: string;
  failLegacyOnce?: string;
} = {}) => {
  const legacy = new Map(Object.entries(options.legacy ?? {}));
  const configuration = new Map(Object.entries(options.configuration ?? {}));
  const explicit = new Set(options.explicit ?? []);
  let failConfigurationOnce = options.failConfigurationOnce;
  let failLegacyOnce = options.failLegacyOnce;
  const store: AppearanceSettingsStore = {
    readConfiguration: (key) => ({
      value: configuration.get(key),
      explicit: explicit.has(key),
      globalValue: configuration.get(key)
    }),
    updateConfiguration: async (key, value) => {
      if (failConfigurationOnce === key) {
        failConfigurationOnce = undefined;
        throw new Error(`configuration failure: ${key}`);
      }
      if (value === undefined) configuration.delete(key);
      else configuration.set(key, value);
    },
    readLegacy: (key) => legacy.get(key),
    updateLegacy: async (key, value) => {
      if (failLegacyOnce === key) {
        failLegacyOnce = undefined;
        throw new Error(`legacy failure: ${key}`);
      }
      if (value === undefined) legacy.delete(key);
      else legacy.set(key, value);
    }
  };
  return { store, legacy, configuration };
};

const legacyValues = {
  [EDITOR_APPEARANCE_STATE_KEY]: 'dark',
  [PREVIEW_APPEARANCE_STATE_KEY]: 'light',
  [PREVIEW_FONT_FAMILY_STATE_KEY]: '  Noto Sans  ',
  [PREVIEW_SOURCE_COLORING_STATE_KEY]: false
};

{
  const repoRoot = path.resolve(import.meta.dir, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const properties = packageJson.contributes.configuration.properties;
  assert.deepEqual(
    {
      [EDITOR_APPEARANCE_SETTING_KEY]: properties[`meoEnhanced.${EDITOR_APPEARANCE_SETTING_KEY}`]?.default,
      [PREVIEW_APPEARANCE_SETTING_KEY]: properties[`meoEnhanced.${PREVIEW_APPEARANCE_SETTING_KEY}`]?.default,
      [PREVIEW_FONT_FAMILY_SETTING_KEY]: properties[`meoEnhanced.${PREVIEW_FONT_FAMILY_SETTING_KEY}`]?.default,
      [PREVIEW_SOURCE_COLORING_SETTING_KEY]: properties[`meoEnhanced.${PREVIEW_SOURCE_COLORING_SETTING_KEY}`]?.default
    },
    {
      [EDITOR_APPEARANCE_SETTING_KEY]: 'auto',
      [PREVIEW_APPEARANCE_SETTING_KEY]: 'auto',
      [PREVIEW_FONT_FAMILY_SETTING_KEY]: '',
      [PREVIEW_SOURCE_COLORING_SETTING_KEY]: true
    },
    'settings schema defaults must match the runtime owner defaults'
  );
}

{
  const { store, legacy, configuration } = createStore({ legacy: legacyValues });
  const owner = await createAppearanceSettingsOwner(store);
  assert.deepEqual(
    [
      owner.getEditorAppearance(),
      owner.getPreviewAppearance(),
      owner.getPreviewFontFamily(),
      owner.getPreviewSourceColoring()
    ],
    ['dark', 'light', 'Noto Sans', false]
  );
  assert.equal(legacy.size, 0, 'successful migration must clear every legacy key');
  assert.deepEqual(Object.fromEntries(configuration), {
    [EDITOR_APPEARANCE_SETTING_KEY]: 'dark',
    [PREVIEW_APPEARANCE_SETTING_KEY]: 'light',
    [PREVIEW_FONT_FAMILY_SETTING_KEY]: 'Noto Sans',
    [PREVIEW_SOURCE_COLORING_SETTING_KEY]: false
  });

  await owner.setEditorAppearance('light');
  await owner.setPreviewAppearance('dark');
  await owner.setPreviewFontFamily('Inter');
  await owner.setPreviewSourceColoring(true);
  assert.deepEqual(
    [
      owner.getEditorAppearance(),
      owner.getPreviewAppearance(),
      owner.getPreviewFontFamily(),
      owner.getPreviewSourceColoring()
    ],
    ['light', 'dark', 'Inter', true]
  );
}

{
  const { store, legacy, configuration } = createStore({
    legacy: legacyValues,
    failConfigurationOnce: PREVIEW_FONT_FAMILY_SETTING_KEY
  });
  const owner = await createAppearanceSettingsOwner(store);
  assert.deepEqual(Object.fromEntries(configuration), {}, 'failed writes must roll back every new configuration value');
  assert.deepEqual(Object.fromEntries(legacy), legacyValues, 'failed writes must preserve the complete legacy bundle');
  assert.deepEqual(
    [owner.getEditorAppearance(), owner.getPreviewAppearance(), owner.getPreviewFontFamily(), owner.getPreviewSourceColoring()],
    ['dark', 'light', 'Noto Sans', false],
    'a failed migration must project one immutable legacy bundle'
  );
}

{
  const { store, legacy, configuration } = createStore({
    legacy: legacyValues,
    failLegacyOnce: PREVIEW_FONT_FAMILY_STATE_KEY
  });
  const owner = await createAppearanceSettingsOwner(store);
  assert.deepEqual(Object.fromEntries(configuration), {}, 'failed cleanup must roll back configuration writes');
  assert.deepEqual(Object.fromEntries(legacy), legacyValues, 'failed cleanup must restore already-cleared legacy keys');
  assert.equal(owner.getPreviewFontFamily(), 'Noto Sans');
}

{
  const { store, legacy, configuration } = createStore({
    legacy: legacyValues,
    configuration: { [PREVIEW_APPEARANCE_SETTING_KEY]: 'dark' },
    explicit: [PREVIEW_APPEARANCE_SETTING_KEY]
  });
  const owner = await createAppearanceSettingsOwner(store);
  assert.equal(owner.getPreviewAppearance(), 'dark', 'explicit configuration must win over legacy state');
  assert.equal(legacy.size, 0, 'superseded legacy values must still be removed');
  assert.equal(configuration.get(PREVIEW_APPEARANCE_SETTING_KEY), 'dark');
}

console.log('appearance settings migration checks passed');
