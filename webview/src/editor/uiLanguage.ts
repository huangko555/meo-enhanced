import { Facet } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';

let currentWidgetLanguageEpoch = 0;

/**
 * Invalidates only widgets whose DOM contains localized text. CodeMirror may
 * otherwise reuse an equal widget after the language facet changes, leaving
 * its existing labels in the previous language.
 */
export function advanceUiLanguageWidgetEpoch(): void {
  currentWidgetLanguageEpoch += 1;
}

export function getUiLanguageWidgetEpoch(): number {
  return currentWidgetLanguageEpoch;
}

export abstract class UiLanguageSensitiveWidget extends WidgetType {
  private readonly languageEpoch = currentWidgetLanguageEpoch;

  protected hasSameUiLanguageEpoch(other: WidgetType): boolean {
    return other instanceof UiLanguageSensitiveWidget &&
      other.languageEpoch === this.languageEpoch;
  }
}

/** Read-only projection of the panel language into CodeMirror widget factories. */
export const uiLanguageFacet = Facet.define<UiLanguage, UiLanguage>({
  combine: (values) => values[0] ?? 'en'
});
