import { Facet } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';

const stableWidgetLanguageEpoch = 0;

/**
 * Keep mounted document widgets structurally equal across panel-language
 * changes. Replacing them made gutter projections and line-number DOM flash;
 * widgets created by later document updates still read the current facet.
 */
export function getUiLanguageWidgetEpoch(): number {
  return stableWidgetLanguageEpoch;
}

export abstract class UiLanguageSensitiveWidget extends WidgetType {
  private readonly languageEpoch = stableWidgetLanguageEpoch;

  protected hasSameUiLanguageEpoch(other: WidgetType): boolean {
    return other instanceof UiLanguageSensitiveWidget &&
      other.languageEpoch === this.languageEpoch;
  }
}

/** Read-only projection of the panel language into CodeMirror widget factories. */
export const uiLanguageFacet = Facet.define<UiLanguage, UiLanguage>({
  combine: (values) => values[0] ?? 'en'
});
