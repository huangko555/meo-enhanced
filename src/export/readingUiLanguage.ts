import type { UiLanguage } from '../foundation/uiLanguage';

export type ReadingUiStrings = Readonly<{
  properties: string;
  alertLabel: (type: string) => string;
  colorLabel: (value: string) => string;
  backToReference: string;
  backToNumberedReference: (number: number) => string;
}>;

const CATALOG: Readonly<Record<UiLanguage, ReadingUiStrings>> = Object.freeze({
  en: Object.freeze({
    properties: 'Properties',
    alertLabel: (type: string) => type,
    colorLabel: (value: string) => `Color ${value}`,
    backToReference: 'Back to reference',
    backToNumberedReference: (number: number) => `Back to reference ${number}`
  }),
  'zh-CN': Object.freeze({
    properties: 'Properties',
    alertLabel: (type: string) => ({ NOTE: '备注', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }[type] ?? type),
    colorLabel: (value: string) => `颜色 ${value}`,
    backToReference: '返回脚注引用',
    backToNumberedReference: (number: number) => `返回脚注引用 ${number}`
  })
});

export function getReadingUiStrings(language: UiLanguage): ReadingUiStrings {
  return CATALOG[language];
}
