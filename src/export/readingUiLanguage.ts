import type { UiLanguage } from '../foundation/uiLanguage';

export type ReadingUiStrings = Readonly<{
  properties: string;
  tableOfContents: string;
  untitledSection: string;
  alertLabel: (type: string) => string;
  colorLabel: (value: string) => string;
  backToReference: string;
  backToNumberedReference: (number: number) => string;
  backToReferenceOccurrence: (number: number, occurrence: number) => string;
}>;

const CATALOG: Readonly<Record<UiLanguage, ReadingUiStrings>> = Object.freeze({
  en: Object.freeze({
    properties: 'Properties',
    tableOfContents: 'Contents',
    untitledSection: 'Untitled section',
    alertLabel: (type: string) => type,
    colorLabel: (value: string) => `Color ${value}`,
    backToReference: 'Back to reference',
    backToNumberedReference: (number: number) => `Back to reference ${number}`,
    backToReferenceOccurrence: (number: number, occurrence: number) => `Back to footnote ${number}, citation ${occurrence}`
  }),
  'zh-CN': Object.freeze({
    properties: 'Properties',
    tableOfContents: '目录',
    untitledSection: '未命名章节',
    alertLabel: (type: string) => ({ NOTE: '备注', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }[type] ?? type),
    colorLabel: (value: string) => `颜色 ${value}`,
    backToReference: '返回脚注引用',
    backToNumberedReference: (number: number) => `返回脚注引用 ${number}`,
    backToReferenceOccurrence: (number: number, occurrence: number) => `返回脚注 ${number} 的第 ${occurrence} 处引用`
  })
});

export function getReadingUiStrings(language: UiLanguage): ReadingUiStrings {
  return CATALOG[language];
}
