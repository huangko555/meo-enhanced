import { Facet } from '@codemirror/state';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';

/** Read-only projection of the panel language into CodeMirror widget factories. */
export const uiLanguageFacet = Facet.define<UiLanguage, UiLanguage>({
  combine: (values) => values[0] ?? 'en'
});
