import type { EditorAppearance } from '../protocol/editorCommands';
import { normalizePreviewFontFamily } from '../protocol/editorStyleEnvironment';
import type { PreviewAppearance } from '../protocol/readyInit';
import {
  normalizeEditorFontSize,
  normalizeEditorFontSizeMode,
  type EditorFontSizeMode,
  type EditorFontSizePreference
} from '../foundation/editorFontSize';

const EDITOR_APPEARANCE_STATE_KEY = 'editorAppearance';
const PREVIEW_APPEARANCE_STATE_KEY = 'previewAppearance';
const PREVIEW_FONT_FAMILY_STATE_KEY = 'previewFontFamily';
const PREVIEW_SOURCE_COLORING_STATE_KEY = 'previewSourceColoring';
const EDITOR_FONT_SIZE_MODE_STATE_KEY = 'editorFontSizeMode';
const EDITOR_FONT_SIZE_STATE_KEY = 'editorFontSize';

const normalizeEditorAppearance = (value: unknown): EditorAppearance => (
  value === 'light' || value === 'dark' ? value : 'auto'
);
const normalizePreviewAppearance = (value: unknown): PreviewAppearance => (
  value === 'light' || value === 'dark' ? value : 'auto'
);
const normalizeStoredPreviewFontFamily = (value: unknown): string => (
  normalizePreviewFontFamily(value) ?? ''
);

export const EDITOR_APPEARANCE_SETTING_KEY = 'appearance.editor';
export const PREVIEW_APPEARANCE_SETTING_KEY = 'appearance.preview';
export const PREVIEW_FONT_FAMILY_SETTING_KEY = 'preview.fontFamily';
export const PREVIEW_SOURCE_COLORING_SETTING_KEY = 'preview.sourceColoring';
export const EDITOR_FONT_SIZE_MODE_SETTING_KEY = 'appearance.fontSizeMode';
export const EDITOR_FONT_SIZE_SETTING_KEY = 'appearance.fontSize';
export const APPEARANCE_SETTINGS_MIGRATION_STATE_KEY = 'appearanceSettingsMigration';

export type AppearanceSettings = {
  editorAppearance: EditorAppearance;
  previewAppearance: PreviewAppearance;
  previewFontFamily: string;
  previewSourceColoring: boolean;
  editorFontSizeMode: EditorFontSizeMode;
  editorFontSize: number;
};

export type AppearanceConfigurationValue = {
  readonly value: unknown;
  readonly explicit: boolean;
  readonly globalValue: unknown;
};

export type AppearanceSettingsStore = {
  readConfiguration: (key: string) => AppearanceConfigurationValue;
  updateConfiguration: (key: string, value: unknown) => Promise<void>;
  readLegacy: (key: string) => unknown;
  updateLegacy: (key: string, value: unknown) => Promise<void>;
};

export type AppearanceSettingsOwner = {
  getEditorAppearance: () => EditorAppearance;
  setEditorAppearance: (appearance: EditorAppearance) => Promise<void>;
  getPreviewAppearance: () => PreviewAppearance;
  setPreviewAppearance: (appearance: PreviewAppearance) => Promise<void>;
  getPreviewFontFamily: () => string;
  setPreviewFontFamily: (fontFamily: string) => Promise<void>;
  getPreviewSourceColoring: () => boolean;
  setPreviewSourceColoring: (enabled: boolean) => Promise<void>;
  getEditorFontSizePreference: () => EditorFontSizePreference;
  setEditorFontSizePreference: (preference: EditorFontSizePreference) => Promise<void>;
};

type Descriptor = {
  readonly settingKey: string;
  readonly legacyKey: string;
  readonly read: (settings: AppearanceSettings) => unknown;
  readonly normalizeLegacy: (value: unknown) => unknown;
};

type MigrationValue = {
  readonly key: string;
  readonly hasValue: boolean;
  readonly value?: unknown;
};

type ConfigurationMigrationValue = MigrationValue & {
  readonly hasExpectedValue: boolean;
  readonly expectedValue?: unknown;
};

type AppearanceSettingsMigration = {
  readonly version: 2;
  readonly configuration: readonly ConfigurationMigrationValue[];
  readonly legacy: readonly MigrationValue[];
};

const normalizeSourceColoring = (value: unknown): boolean => value !== false;

const descriptors: readonly Descriptor[] = [
  {
    settingKey: EDITOR_APPEARANCE_SETTING_KEY,
    legacyKey: EDITOR_APPEARANCE_STATE_KEY,
    read: (settings) => settings.editorAppearance,
    normalizeLegacy: normalizeEditorAppearance
  },
  {
    settingKey: PREVIEW_APPEARANCE_SETTING_KEY,
    legacyKey: PREVIEW_APPEARANCE_STATE_KEY,
    read: (settings) => settings.previewAppearance,
    normalizeLegacy: normalizePreviewAppearance
  },
  {
    settingKey: PREVIEW_FONT_FAMILY_SETTING_KEY,
    legacyKey: PREVIEW_FONT_FAMILY_STATE_KEY,
    read: (settings) => settings.previewFontFamily,
    normalizeLegacy: normalizeStoredPreviewFontFamily
  },
  {
    settingKey: PREVIEW_SOURCE_COLORING_SETTING_KEY,
    legacyKey: PREVIEW_SOURCE_COLORING_STATE_KEY,
    read: (settings) => settings.previewSourceColoring,
    normalizeLegacy: normalizeSourceColoring
  }
];

const resolveSettings = (store: AppearanceSettingsStore, preferLegacy: boolean): AppearanceSettings => {
  const resolve = (settingKey: string, legacyKey: string): unknown => {
    const configured = store.readConfiguration(settingKey);
    if (configured.explicit || !preferLegacy) return configured.value;
    const legacy = store.readLegacy(legacyKey);
    return legacy === undefined ? configured.value : legacy;
  };
  return {
    editorAppearance: normalizeEditorAppearance(resolve(EDITOR_APPEARANCE_SETTING_KEY, EDITOR_APPEARANCE_STATE_KEY)),
    previewAppearance: normalizePreviewAppearance(resolve(PREVIEW_APPEARANCE_SETTING_KEY, PREVIEW_APPEARANCE_STATE_KEY)),
    previewFontFamily: normalizeStoredPreviewFontFamily(resolve(PREVIEW_FONT_FAMILY_SETTING_KEY, PREVIEW_FONT_FAMILY_STATE_KEY)),
    previewSourceColoring: normalizeSourceColoring(resolve(PREVIEW_SOURCE_COLORING_SETTING_KEY, PREVIEW_SOURCE_COLORING_STATE_KEY)),
    editorFontSizeMode: normalizeEditorFontSizeMode(resolve(EDITOR_FONT_SIZE_MODE_SETTING_KEY, EDITOR_FONT_SIZE_MODE_STATE_KEY)),
    editorFontSize: normalizeEditorFontSize(resolve(EDITOR_FONT_SIZE_SETTING_KEY, EDITOR_FONT_SIZE_STATE_KEY))
  };
};

const toMigrationValue = (key: string, value: unknown): MigrationValue => ({
  key,
  hasValue: value !== undefined,
  ...(value === undefined ? {} : { value })
});

const isMigrationValue = (value: unknown): value is MigrationValue => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MigrationValue>;
  return typeof candidate.key === 'string' && typeof candidate.hasValue === 'boolean';
};

const isConfigurationMigrationValue = (value: unknown): value is ConfigurationMigrationValue => (
  isMigrationValue(value)
  && typeof (value as Partial<ConfigurationMigrationValue>).hasExpectedValue === 'boolean'
);

const readPendingMigration = (store: AppearanceSettingsStore): AppearanceSettingsMigration | null => {
  const value = store.readLegacy(APPEARANCE_SETTINGS_MIGRATION_STATE_KEY);
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Appearance settings migration journal is invalid');
  }
  const candidate = value as {
    version?: unknown;
    configuration?: unknown;
    legacy?: unknown;
  };
  if (!Array.isArray(candidate.configuration)
    || !Array.isArray(candidate.legacy)
    || !candidate.legacy.every(isMigrationValue)) {
    throw new Error('Appearance settings migration journal is invalid');
  }
  if (candidate.version === 2 && candidate.configuration.every(isConfigurationMigrationValue)) {
    return candidate as AppearanceSettingsMigration;
  }
  if (candidate.version === 1 && candidate.configuration.every(isMigrationValue)) {
    const legacy = candidate.legacy as MigrationValue[];
    const configuration = candidate.configuration.map((entry): ConfigurationMigrationValue => {
      const descriptor = descriptors.find(({ settingKey }) => settingKey === entry.key);
      const legacyEntry = descriptor
        ? legacy.find(({ key }) => key === descriptor.legacyKey)
        : undefined;
      if (!descriptor || !legacyEntry?.hasValue) {
        throw new Error('Appearance settings migration journal is invalid');
      }
      return {
        ...entry,
        hasExpectedValue: true,
        expectedValue: descriptor.normalizeLegacy(legacyEntry.value)
      };
    });
    return { version: 2, configuration, legacy };
  }
  throw new Error('Appearance settings migration journal is invalid');
};

const restoreMigration = async (
  store: AppearanceSettingsStore,
  migration: AppearanceSettingsMigration
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const entry of [...migration.legacy].reverse()) {
    try {
      await store.updateLegacy(entry.key, entry.hasValue ? entry.value : undefined);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const entry of [...migration.configuration].reverse()) {
    try {
      const current = store.readConfiguration(entry.key).globalValue;
      const expected = entry.hasExpectedValue ? entry.expectedValue : undefined;
      if (!Object.is(current, expected)) continue;
      await store.updateConfiguration(entry.key, entry.hasValue ? entry.value : undefined);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

const recoverPendingMigration = async (store: AppearanceSettingsStore): Promise<void> => {
  const migration = readPendingMigration(store);
  if (migration === null) return;
  const primary = new Error('Appearance settings migration recovery failed');
  const errors = await restoreMigration(store, migration);
  if (errors.length === 0) {
    try {
      await store.updateLegacy(APPEARANCE_SETTINGS_MIGRATION_STATE_KEY, undefined);
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError([primary, ...errors], primary.message, { cause: primary });
};

const compensate = async (
  store: AppearanceSettingsStore,
  migration: AppearanceSettingsMigration,
  primary: unknown
): Promise<void> => {
  const errors = [primary, ...await restoreMigration(store, migration)];
  if (errors.length === 1) {
    try {
      await store.updateLegacy(APPEARANCE_SETTINGS_MIGRATION_STATE_KEY, undefined);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Appearance settings migration compensation failed', { cause: primary });
  }
};

export async function createAppearanceSettingsOwner(
  store: AppearanceSettingsStore
): Promise<AppearanceSettingsOwner> {
  await recoverPendingMigration(store);
  const legacySnapshot = resolveSettings(store, true);
  const legacyEntries = descriptors.flatMap((descriptor) => {
    const value = store.readLegacy(descriptor.legacyKey);
    return value === undefined ? [] : [{ descriptor, value }];
  });
  const configurationEntries = legacyEntries.flatMap(({ descriptor }) => {
    const configured = store.readConfiguration(descriptor.settingKey);
    return configured.explicit
      ? []
      : [{
          ...toMigrationValue(descriptor.settingKey, configured.globalValue),
          hasExpectedValue: true,
          expectedValue: descriptor.read(legacySnapshot)
        }];
  });
  const migration: AppearanceSettingsMigration = {
    version: 2,
    configuration: configurationEntries,
    legacy: legacyEntries.map(({ descriptor, value }) => toMigrationValue(descriptor.legacyKey, value))
  };
  let migrationJournalWritten = false;
  let fallback: AppearanceSettings | null = null;

  try {
    if (legacyEntries.length > 0) {
      await store.updateLegacy(APPEARANCE_SETTINGS_MIGRATION_STATE_KEY, migration);
      migrationJournalWritten = true;
    }
    for (const { descriptor } of legacyEntries) {
      const configured = store.readConfiguration(descriptor.settingKey);
      if (configured.explicit) continue;
      await store.updateConfiguration(descriptor.settingKey, descriptor.read(legacySnapshot));
    }
    for (const { descriptor } of legacyEntries) {
      await store.updateLegacy(descriptor.legacyKey, undefined);
    }
    if (migrationJournalWritten) {
      await store.updateLegacy(APPEARANCE_SETTINGS_MIGRATION_STATE_KEY, undefined);
      migrationJournalWritten = false;
    }
  } catch (primary) {
    if (migrationJournalWritten) await compensate(store, migration, primary);
    fallback = legacySnapshot;
  }

  const readSettings = (): AppearanceSettings => fallback ?? resolveSettings(store, false);
  const write = async <K extends keyof AppearanceSettings>(
    key: K,
    settingKey: string,
    value: AppearanceSettings[K]
  ): Promise<void> => {
    if (Object.is(readSettings()[key], value)) return;
    await store.updateConfiguration(settingKey, value);
    if (fallback) fallback = { ...fallback, [key]: value };
  };

  return {
    getEditorAppearance: () => readSettings().editorAppearance,
    setEditorAppearance: (appearance) => write(
      'editorAppearance',
      EDITOR_APPEARANCE_SETTING_KEY,
      normalizeEditorAppearance(appearance)
    ),
    getPreviewAppearance: () => readSettings().previewAppearance,
    setPreviewAppearance: (appearance) => write(
      'previewAppearance',
      PREVIEW_APPEARANCE_SETTING_KEY,
      normalizePreviewAppearance(appearance)
    ),
    getPreviewFontFamily: () => readSettings().previewFontFamily,
    setPreviewFontFamily: async (fontFamily) => {
      const normalized = normalizePreviewFontFamily(fontFamily);
      if (normalized !== null) {
        await write('previewFontFamily', PREVIEW_FONT_FAMILY_SETTING_KEY, normalized);
      }
    },
    getPreviewSourceColoring: () => readSettings().previewSourceColoring,
    setPreviewSourceColoring: (enabled) => write(
      'previewSourceColoring',
      PREVIEW_SOURCE_COLORING_SETTING_KEY,
      enabled === true
    ),
    getEditorFontSizePreference: () => ({
      mode: readSettings().editorFontSizeMode,
      value: readSettings().editorFontSize
    }),
    setEditorFontSizePreference: async (preference) => {
      const mode = normalizeEditorFontSizeMode(preference.mode);
      const value = normalizeEditorFontSize(preference.value);
      await write('editorFontSize', EDITOR_FONT_SIZE_SETTING_KEY, value);
      await write('editorFontSizeMode', EDITOR_FONT_SIZE_MODE_SETTING_KEY, mode);
    }
  };
}
