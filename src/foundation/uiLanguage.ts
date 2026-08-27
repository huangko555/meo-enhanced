export type UiLanguage = 'en' | 'zh-CN';
export type UiLanguagePreference = 'auto' | UiLanguage;

export type UiStrings = Readonly<{
  auto: string;
  light: string;
  dark: string;
  previewTitle: string;
  previewAppearance: string;
  previewSourceColoring: string;
  previewCodeColors: string;
  previewFontFamily: string;
  previewFontPlaceholder: string;
  previewGenerating: string;
  previewFailed: string;
  previewTools: string;
  exportHtml: string;
  exportPdf: string;
  exportAsHtml: string;
  exportAsPdf: string;
  findAndReplace: string;
  more: string;
  moreTools: string;
  editorAppearance: string;
}>;

const CATALOG: Readonly<Record<UiLanguage, UiStrings>> = Object.freeze({
  en: Object.freeze({
    auto: 'Auto', light: 'Light', dark: 'Dark', previewTitle: 'Markdown Preview',
    previewAppearance: 'Preview appearance', previewSourceColoring: 'Preview source coloring',
    previewCodeColors: 'Code colors', previewFontFamily: 'Preview font family',
    previewFontPlaceholder: 'VS Code editor font', previewGenerating: 'Generating preview…',
    previewFailed: 'Preview generation failed', previewTools: 'Preview tools',
    exportHtml: 'Export HTML', exportPdf: 'Export PDF', exportAsHtml: 'Export as HTML',
    exportAsPdf: 'Export as PDF', findAndReplace: 'Find and Replace', more: 'More',
    moreTools: 'More tools', editorAppearance: 'Editor appearance'
  }),
  'zh-CN': Object.freeze({
    auto: '自动', light: '浅色', dark: '深色', previewTitle: 'Markdown 预览',
    previewAppearance: '预览外观', previewSourceColoring: '预览源码着色',
    previewCodeColors: '代码着色', previewFontFamily: '预览字体',
    previewFontPlaceholder: 'VS Code 编辑器字体', previewGenerating: '正在生成预览…',
    previewFailed: '预览生成失败', previewTools: '预览工具', exportHtml: '导出 HTML',
    exportPdf: '导出 PDF', exportAsHtml: '导出为 HTML', exportAsPdf: '导出为 PDF',
    findAndReplace: '查找和替换', more: '更多', moreTools: '更多工具',
    editorAppearance: '编辑器外观'
  })
});

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

export function getUiStrings(language: UiLanguage): UiStrings {
  return CATALOG[language];
}
