import {
  collectPunctuationClosingInlineStyles,
  type ParsedInlineStyleRange
} from '../webview/src/helpers/inlineStyleFallback';

function range(text: string, source: string, nodeName: ParsedInlineStyleRange['nodeName']): ParsedInlineStyleRange {
  const from = text.indexOf(source);
  if (from < 0) throw new Error(`Missing fixture range: ${source}`);
  return { from, to: from + source.length, nodeName };
}

function fallbackSources(text: string, parsed: ParsedInlineStyleRange[]): string[] {
  return collectPunctuationClosingInlineStyles(text, 0, parsed)
    .map((candidate) => text.slice(candidate.from, candidate.to));
}

const adjacent = '**粗体中的 ~~删除线~~**、~~删除线中的 *斜体*~~12';
const adjacentParsed = [
  range(adjacent, '**粗体中的 ~~删除线~~**', 'StrongEmphasis'),
  range(adjacent, '~~删除线~~', 'Strikethrough'),
  range(adjacent, '*斜体*', 'Emphasis')
];
const adjacentFallbacks = fallbackSources(adjacent, adjacentParsed);
if (JSON.stringify(adjacentFallbacks) !== JSON.stringify(['~~删除线中的 *斜体*~~'])) {
  throw new Error(`Adjacent styles crossed boundaries: ${JSON.stringify(adjacentFallbacks)}`);
}

const leftBoundary = '12~~*斜体* 中的删除线~~';
const leftFallbacks = fallbackSources(leftBoundary, [range(leftBoundary, '*斜体*', 'Emphasis')]);
if (JSON.stringify(leftFallbacks) !== JSON.stringify(['~~*斜体* 中的删除线~~'])) {
  throw new Error(`Left marker boundary was not preserved: ${JSON.stringify(leftFallbacks)}`);
}

const bothBoundaries = '12~~*斜体*~~34';
const bothFallbacks = fallbackSources(bothBoundaries, [range(bothBoundaries, '*斜体*', 'Emphasis')]);
if (JSON.stringify(bothFallbacks) !== JSON.stringify(['~~*斜体*~~'])) {
  throw new Error(`Two-sided marker boundaries were not preserved: ${JSON.stringify(bothFallbacks)}`);
}

const delimiterBoundaryCases = [
  {
    label: 'strong-left',
    text: '12**`代码`中的粗体**',
    parsed: ['`代码`', 'InlineCode'] as const,
    expected: '**`代码`中的粗体**'
  },
  {
    label: 'strong-right',
    text: '**粗体中的 `代码`**12',
    parsed: ['`代码`', 'InlineCode'] as const,
    expected: '**粗体中的 `代码`**'
  },
  {
    label: 'emphasis-left',
    text: '12*`代码`中的斜体*',
    parsed: ['`代码`', 'InlineCode'] as const,
    expected: '*`代码`中的斜体*'
  },
  {
    label: 'emphasis-right',
    text: '*斜体中的 `代码`*12',
    parsed: ['`代码`', 'InlineCode'] as const,
    expected: '*斜体中的 `代码`*'
  }
];
for (const fixture of delimiterBoundaryCases) {
  const parsed = [range(fixture.text, fixture.parsed[0], fixture.parsed[1])];
  const actual = fallbackSources(fixture.text, parsed);
  if (JSON.stringify(actual) !== JSON.stringify([fixture.expected])) {
    throw new Error(`${fixture.label} marker boundary was not preserved: ${JSON.stringify(actual)}`);
  }
}

const fullyParsed = '~~第一段~~、~~第二段~~';
const fullyParsedRanges = [
  range(fullyParsed, '~~第一段~~', 'Strikethrough'),
  range(fullyParsed, '~~第二段~~', 'Strikethrough')
];
if (fallbackSources(fullyParsed, fullyParsedRanges).length !== 0) {
  throw new Error('Already parsed styles were processed again');
}

console.log('inline style fallback boundary checks passed');
