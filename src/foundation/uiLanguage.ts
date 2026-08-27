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
