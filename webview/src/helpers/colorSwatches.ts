import { Decoration, WidgetType } from '@codemirror/view';
import type { HexColorRange } from '../../../src/shared/hexColorSwatches';

export function createColorSwatchElement(value: string): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.className = 'meo-md-color-swatch';
  swatch.style.backgroundColor = value;
  swatch.title = value;
  swatch.setAttribute('role', 'img');
  swatch.setAttribute('aria-label', `Color ${value}`);
  return swatch;
}

export class ColorSwatchWidget extends WidgetType {
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ColorSwatchWidget && other.value === this.value;
  }

  toDOM(): HTMLElement {
    return createColorSwatchElement(this.value);
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
