export type InlineStyleNodeName = 'StrongEmphasis' | 'Strikethrough' | 'Highlight' | 'Emphasis';

export type ParsedInlineStyleRange = {
  from: number;
  to: number;
  nodeName: InlineStyleNodeName | 'InlineCode';
};

export type FallbackInlineStyleRange = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  closeFrom: number;
  marker: '**' | '~~' | '==' | '*';
  nodeName: InlineStyleNodeName;
};

const fallbackStyles = [
  { marker: '**', nodeName: 'StrongEmphasis' },
  { marker: '~~', nodeName: 'Strikethrough' },
  { marker: '==', nodeName: 'Highlight' },
  { marker: '*', nodeName: 'Emphasis' }
] as const;

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isDelimiterPunctuation(char: string): boolean {
  return char !== '' && /[\p{P}\p{S}]/u.test(char);
}

export function collectPunctuationClosingInlineStyles(
  text: string,
  baseOffset = 0,
  parsedStyleRanges: readonly ParsedInlineStyleRange[] = []
): FallbackInlineStyleRange[] {
  const ranges: FallbackInlineStyleRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const style = fallbackStyles.find(({ marker }) => text.startsWith(marker, cursor));
    if (!style || isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    if (style.marker === '*' && (text[cursor - 1] === '*' || text[cursor + 1] === '*')) {
      cursor += 1;
      continue;
    }
    const from = baseOffset + cursor;
    const parsedContainer = parsedStyleRanges.find(
      (range) => range.nodeName === style.nodeName && from >= range.from && from < range.to
    );
    if (parsedContainer) {
      cursor = Math.max(cursor + style.marker.length, parsedContainer.to - baseOffset);
      continue;
    }
    const contentFromOffset = cursor + style.marker.length;
    if (!text[contentFromOffset] || /\s/u.test(text[contentFromOffset])) {
      cursor += style.marker.length;
      continue;
    }

    let close = text.indexOf(style.marker, contentFromOffset + 1);
    while (close >= 0) {
      const beforeClose = text[close - 1] ?? '';
      const invalidSingleStar = style.marker === '*' && (text[close - 1] === '*' || text[close + 1] === '*');
      const closeFrom = baseOffset + close;
      const crossesParsedStyle = parsedStyleRanges.some(
        (range) => range.nodeName === style.nodeName && closeFrom >= range.from && closeFrom < range.to
      );
      if (crossesParsedStyle) {
        close = -1;
        break;
      }
      if (!invalidSingleStar && !isEscaped(text, close) && beforeClose !== '' && !/\s/u.test(beforeClose)) break;
      close = text.indexOf(style.marker, close + style.marker.length);
    }
    if (close < 0) {
      cursor += style.marker.length;
      continue;
    }

    const to = baseOffset + close + style.marker.length;
    const beforeOpen = text[cursor - 1] ?? '';
    const afterOpen = text[contentFromOffset] ?? '';
    const beforeClose = text[close - 1] ?? '';
    const afterClose = text[close + style.marker.length] ?? '';
    const needsLeftBoundaryFallback = beforeOpen !== '' && !/\s/u.test(beforeOpen) && isDelimiterPunctuation(afterOpen);
    const needsRightBoundaryFallback = isDelimiterPunctuation(beforeClose) && afterClose !== '' && !/\s/u.test(afterClose);
    if (!needsLeftBoundaryFallback && !needsRightBoundaryFallback) {
      cursor = close + style.marker.length;
      continue;
    }
    const alreadyParsed = parsedStyleRanges.some(
      (range) => range.nodeName === style.nodeName && range.from === from && range.to === to
    );
    if (!alreadyParsed) {
      ranges.push({
        from,
        to,
        contentFrom: from + style.marker.length,
        contentTo: baseOffset + close,
        closeFrom: baseOffset + close,
        marker: style.marker,
        nodeName: style.nodeName
      });
    }
    cursor = close + style.marker.length;
  }

  return ranges;
}
