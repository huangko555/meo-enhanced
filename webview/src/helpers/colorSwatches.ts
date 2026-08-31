import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { HexColorRange } from '../../../src/shared/hexColorSwatches';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';

export function createColorSwatchElement(value: string, uiLanguage: UiLanguage = 'en'): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.className = 'meo-md-color-swatch';
  swatch.style.backgroundColor = value;
  swatch.title = value;
  swatch.setAttribute('role', 'img');
  swatch.setAttribute('aria-label', getUiStrings(uiLanguage).colorLabel(value));
  return swatch;
}

export class ColorSwatchWidget extends UiLanguageSensitiveWidget {
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ColorSwatchWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.value === this.value;
  }

  toDOM(view: EditorView): HTMLElement {
    return createColorSwatchElement(this.value, view.state.facet(uiLanguageFacet));
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function addColorSwatchDecoration(
  ranges: Array<any>,
  colorRange: HexColorRange
): void {
  ranges.push(
    Decoration.widget({
      widget: new ColorSwatchWidget(colorRange.value),
      side: -1
    }).range(colorRange.from)
  );
}
