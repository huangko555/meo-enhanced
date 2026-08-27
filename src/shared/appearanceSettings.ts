import {
  EDITOR_APPEARANCE_STATE_KEY,
  normalizeEditorAppearance,
  type EditorAppearance
} from './editorAppearance';
import {
  normalizePreviewAppearance,
  normalizePreviewFontFamily,
  normalizeStoredPreviewFontFamily,
  PREVIEW_APPEARANCE_STATE_KEY,
  PREVIEW_FONT_FAMILY_STATE_KEY,
  PREVIEW_SOURCE_COLORING_STATE_KEY,
  type PreviewAppearance
} from './preview';

export const EDITOR_APPEARANCE_SETTING_KEY = 'appearance.editor';
export const PREVIEW_APPEARANCE_SETTING_KEY = 'appearance.preview';
export const PREVIEW_FONT_FAMILY_SETTING_KEY = 'preview.fontFamily';
export const PREVIEW_SOURCE_COLORING_SETTING_KEY = 'preview.sourceColoring';

export type AppearanceSettings = {
  editorAppearance: EditorAppearance;
  previewAppearance: PreviewAppearance;
  previewFontFamily: string;
  previewSourceColoring: boolean;
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
};

type Descriptor = {
  readonly settingKey: string;
  readonly legacyKey: string;
  readonly read: (settings: AppearanceSettings) => unknown;
};

const descriptors: readonly Descriptor[] = [
  {
    settingKey: EDITOR_APPEARANCE_SETTING_KEY,
    legacyKey: EDITOR_APPEARANCE_STATE_KEY,
    read: (settings) => settings.editorAppearance
  },
  {
    settingKey: PREVIEW_APPEARANCE_SETTING_KEY,
    legacyKey: PREVIEW_APPEARANCE_STATE_KEY,
    read: (settings) => settings.previewAppearance
  },
  {
    settingKey: PREVIEW_FONT_FAMILY_SETTING_KEY,
    legacyKey: PREVIEW_FONT_FAMILY_STATE_KEY,
    read: (settings) => settings.previewFontFamily
  },
  {
    settingKey: PREVIEW_SOURCE_COLORING_SETTING_KEY,
    legacyKey: PREVIEW_SOURCE_COLORING_STATE_KEY,
    read: (settings) => settings.previewSourceColoring
  }
];

const normalizeSourceColoring = (value: unknown): boolean => value !== false;

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
    previewSourceColoring: normalizeSourceColoring(resolve(PREVIEW_SOURCE_COLORING_SETTING_KEY, PREVIEW_SOURCE_COLORING_STATE_KEY))
  };
};

const compensate = async (
  store: AppearanceSettingsStore,
  clearedLegacy: ReadonlyArray<{ key: string; value: unknown }>,
  writtenConfiguration: ReadonlyArray<{ key: string; value: unknown }>,
  primary: unknown
): Promise<void> => {
  const errors = [primary];
  for (const entry of [...clearedLegacy].reverse()) {
    try {
      await store.updateLegacy(entry.key, entry.value);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const entry of [...writtenConfiguration].reverse()) {
    try {
      await store.updateConfiguration(entry.key, entry.value);
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
  const legacySnapshot = resolveSettings(store, true);
  const legacyEntries = descriptors.flatMap((descriptor) => {
    const value = store.readLegacy(descriptor.legacyKey);
    return value === undefined ? [] : [{ descriptor, value }];
  });
  const writtenConfiguration: Array<{ key: string; value: unknown }> = [];
  const clearedLegacy: Array<{ key: string; value: unknown }> = [];
  let fallback: AppearanceSettings | null = null;

  try {
    for (const { descriptor } of legacyEntries) {
      const configured = store.readConfiguration(descriptor.settingKey);
      if (configured.explicit) continue;
      writtenConfiguration.push({ key: descriptor.settingKey, value: configured.globalValue });
      await store.updateConfiguration(descriptor.settingKey, descriptor.read(legacySnapshot));
    }
    for (const { descriptor, value } of legacyEntries) {
      clearedLegacy.push({ key: descriptor.legacyKey, value });
      await store.updateLegacy(descriptor.legacyKey, undefined);
    }
  } catch (primary) {
    await compensate(store, clearedLegacy, writtenConfiguration, primary);
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
    )
  };
}
