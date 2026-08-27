export type UiLanguage = 'en' | 'zh-CN';
export type UiLanguagePreference = 'auto' | UiLanguage;

export function normalizeUiLanguagePreference(value: unknown): UiLanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'auto';
}

export function resolveUiLanguage(preference: unknown, vscodeLanguage: unknown): UiLanguage {
  const normalized = normalizeUiLanguagePreference(preference);
  if (normalized !== 'auto') return normalized;
  return typeof vscodeLanguage === 'string' && vscodeLanguage.toLowerCase() === 'zh-cn'
    ? 'zh-CN'
    : 'en';
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'en' || value === 'zh-CN';
}

export type GeneratedUiStrings = {
  readonly properties: string;
  readonly resyncFailureNotice: string;
  readonly externalConflictNotice: string;
  readonly alertLabel: (type: string) => string;
};

const generatedUiStrings: Record<UiLanguage, GeneratedUiStrings> = {
  en: {
    properties: 'Properties',
    resyncFailureNotice: 'Could not resynchronize the document. Local edits were kept.',
    externalConflictNotice: 'The document changed externally while local edits were pending. Local edits were kept.',
    alertLabel: (type) => type
  },
  'zh-CN': {
    properties: '属性',
    resyncFailureNotice: '无法重新同步文档，已保留本地编辑。',
    externalConflictNotice: '存在本地编辑时文档发生了外部变更，已保留本地编辑。',
    alertLabel: (type) => ({ NOTE: '备注', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }[type] ?? type)
  }
};

export function getGeneratedUiStrings(language: UiLanguage): GeneratedUiStrings {
  return generatedUiStrings[language];
}
