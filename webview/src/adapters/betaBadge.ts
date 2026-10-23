import type { UiLanguage } from '../../../src/foundation/uiLanguage';

export function createBetaBadge(language: UiLanguage): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'meo-beta-badge';
  badge.textContent = 'Beta';
  badge.tabIndex = 0;
  badge.dataset.tooltipKind = 'description';
  badge.dataset.tooltip = language === 'zh-CN'
    ? '此功能仍在完善中，可能存在交互或显示问题。'
    : 'This feature is still being refined and may have interaction or display issues.';
  return badge;
}
