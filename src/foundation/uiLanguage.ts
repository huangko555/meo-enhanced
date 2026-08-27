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
  findAndReplacePanel: string;
  find: string;
  replace: string;
  clearFind: string;
  clearReplace: string;
  wholeWord: string;
  caseSensitive: string;
  previousMatch: string;
  nextMatch: string;
  closeFind: string;
  replaceCurrentMatch: string;
  replaceAllMatches: string;
  noMatches: string;
  enterText: string;
  replaced: string;
  findMatches: (count: number) => string;
  replacedCurrent: (current: number, total: number) => string;
  replacedRemaining: (count: number) => string;
  replacedMatches: (count: number) => string;
  documentOutline: string;
  outline: string;
  outlineCollapseTopTwo: string;
  outlineExpandAll: string;
  outlineSwitchFixed: string;
  outlineSwitchFloating: string;
  outlineSwitchLeft: string;
  outlineSwitchRight: string;
  outlineClose: string;
  outlineResize: string;
  outlineEmptyHeading: string;
  outlineExpand: string;
  outlineCollapse: string;
  outlineNoHeadings: string;
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
    moreTools: 'More tools', editorAppearance: 'Editor appearance',
    findAndReplacePanel: 'Find and replace', find: 'Find', replace: 'Replace',
    clearFind: 'Clear Find', clearReplace: 'Clear Replace', wholeWord: 'Whole Word',
    caseSensitive: 'Case Sensitive', previousMatch: 'Previous Match', nextMatch: 'Next Match',
    closeFind: 'Close Find', replaceCurrentMatch: 'Replace Current Match',
    replaceAllMatches: 'Replace All Matches', noMatches: 'No matches', enterText: 'Enter text',
    replaced: 'Replaced', findMatches: (count: number) => `${count} matches`,
    replacedCurrent: (current: number, total: number) => `Replaced • ${current}/${total}`,
    replacedRemaining: (count: number) => `Replaced • ${count} remaining`,
    replacedMatches: (count: number) => `Replaced ${count} matches`,
    documentOutline: 'Document outline', outline: 'Outline', outlineCollapseTopTwo: 'Show top two levels',
    outlineExpandAll: 'Expand all', outlineSwitchFixed: 'Switch to fixed outline',
    outlineSwitchFloating: 'Switch to floating outline', outlineSwitchLeft: 'Switch to left side',
    outlineSwitchRight: 'Switch to right side', outlineClose: 'Close outline',
    outlineResize: 'Drag to resize outline',
    outlineEmptyHeading: '(Empty heading)',
    outlineExpand: 'Expand', outlineCollapse: 'Collapse', outlineNoHeadings: 'No headings'
  }),
  'zh-CN': Object.freeze({
    auto: '自动', light: '浅色', dark: '深色', previewTitle: 'Markdown 预览',
    previewAppearance: '预览外观', previewSourceColoring: '预览源码着色',
    previewCodeColors: '代码着色', previewFontFamily: '预览字体',
    previewFontPlaceholder: 'VS Code 编辑器字体', previewGenerating: '正在生成预览…',
    previewFailed: '预览生成失败', previewTools: '预览工具', exportHtml: '导出 HTML',
    exportPdf: '导出 PDF', exportAsHtml: '导出为 HTML', exportAsPdf: '导出为 PDF',
    findAndReplace: '查找和替换', more: '更多', moreTools: '更多工具',
    editorAppearance: '编辑器外观', findAndReplacePanel: '查找和替换', find: '查找',
    replace: '替换', clearFind: '清除查找内容', clearReplace: '清除替换内容',
    wholeWord: '全字匹配', caseSensitive: '区分大小写', previousMatch: '上一个匹配项',
    nextMatch: '下一个匹配项', closeFind: '关闭查找', replaceCurrentMatch: '替换当前匹配项',
    replaceAllMatches: '替换全部匹配项', noMatches: '无匹配项', enterText: '请输入文本',
    replaced: '已替换', findMatches: (count: number) => `${count} 个匹配项`,
    replacedCurrent: (current: number, total: number) => `已替换 • ${current}/${total}`,
    replacedRemaining: (count: number) => `已替换 • 剩余 ${count} 个`,
    replacedMatches: (count: number) => `已替换 ${count} 个匹配项`,
    documentOutline: '文档目录', outline: '目录', outlineCollapseTopTwo: '只展开前两层',
    outlineExpandAll: '展开全部', outlineSwitchFixed: '切换到固定目录',
    outlineSwitchFloating: '切换到浮动目录', outlineSwitchLeft: '切换到左侧',
    outlineSwitchRight: '切换到右侧', outlineClose: '关闭目录',
    outlineResize: '拖动调整目录宽度',
    outlineEmptyHeading: '(空标题)',
    outlineExpand: '展开', outlineCollapse: '折叠', outlineNoHeadings: '暂无标题'
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
