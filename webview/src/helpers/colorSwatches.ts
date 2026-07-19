import { Decoration, WidgetType } from '@codemirror/view';

export type ColorRange = {
  from: number;
  to: number;
  value: string;
};

const HEX_COLOR_REGEX = /#[0-9a-f]{3,8}/gi;
const FUNCTION_COLOR_REGEX = /(?:rgba?|hsla?)\([^()\r\n]{1,120}\)/gi;
const COLOR_FUNCTION_NAMES = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
const NUMBER_OR_PERCENT_REGEX = /^-?(?:\d+(?:\.\d+)?|\.\d+)%?$/;
const HUE_REGEX = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)?$/i;

function isColorBoundary(text: string, index: number, value: string): boolean {
  const previous = index > 0 ? text[index - 1] : '';
  const next = text[index + value.length] ?? '';

  if (/[\w-]/.test(previous) || /[\w-]/.test(next)) {
    return false;
  }
  if (value.startsWith('#') && (previous === '#' || next === '#')) {
    return false;
  }
  return true;
}

function splitColorFunctionArguments(body: string): string[] {
  return body
    .trim()
    .replace(/,/g, ' ')
    .replace(/\//g, ' / ')
    .split(/\s+/)
    .filter(Boolean);
}

function isValidColorFunction(value: string): boolean {
  const match = value.match(/^([a-z]+)\((.*)\)$/i);
  if (!match || !COLOR_FUNCTION_NAMES.has(match[1].toLowerCase())) {
    return false;
  }

  const name = match[1].toLowerCase();
  const args = splitColorFunctionArguments(match[2]);
  const slashIndex = args.indexOf('/');
  const channels = slashIndex >= 0 ? args.slice(0, slashIndex) : args.slice(0, 3);
  const alpha = slashIndex >= 0 ? args.slice(slashIndex + 1) : args.slice(3);

  if (channels.length !== 3 || alpha.length > 1 || (slashIndex >= 0 && alpha.length !== 1)) {
    return false;
  }
  if ((name === 'rgba' || name === 'hsla') && alpha.length !== 1) {
    return false;
  }

  if (name.startsWith('rgb')) {
    return channels.every((channel) => NUMBER_OR_PERCENT_REGEX.test(channel)) &&
      alpha.every((channel) => NUMBER_OR_PERCENT_REGEX.test(channel));
  }

  return HUE_REGEX.test(channels[0]) &&
    /^\d+(?:\.\d+)?%$/.test(channels[1]) &&
    /^\d+(?:\.\d+)?%$/.test(channels[2]) &&
    alpha.every((channel) => NUMBER_OR_PERCENT_REGEX.test(channel));
}

function addCandidate(
  ranges: ColorRange[],
  text: string,
  from: number,
  value: string
): void {
  if (!isColorBoundary(text, from, value)) {
    return;
  }
  if (value.includes('(') && !isValidColorFunction(value)) {
    return;
  }
  ranges.push({ from, to: from + value.length, value });
}

/** Finds conservative CSS color literals while leaving the source text intact. */
export function collectColorRangesFromText(text: string, offset = 0): ColorRange[] {
  const ranges: ColorRange[] = [];

  for (const match of text.matchAll(HEX_COLOR_REGEX)) {
    const value = match[0];
    if (![4, 5, 7, 9].includes(value.length)) {
      continue;
    }
    addCandidate(ranges, text, match.index ?? 0, value);
  }

  for (const match of text.matchAll(FUNCTION_COLOR_REGEX)) {
    addCandidate(ranges, text, match.index ?? 0, match[0]);
  }

  return ranges
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .filter((range, index, all) => index === 0 || range.from >= all[index - 1].to)
    .map((range) => ({ ...range, from: range.from + offset, to: range.to + offset }));
}

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
  colorRange: ColorRange
): void {
  ranges.push(
    Decoration.widget({
      widget: new ColorSwatchWidget(colorRange.value),
      side: -1
    }).range(colorRange.from)
  );
}
