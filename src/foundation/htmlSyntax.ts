const voidHtmlTags = new Set(['br', 'col', 'hr', 'img']);

export interface HtmlTagToken {
  from: number;
  to: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

export function scanHtmlTags(source: string): HtmlTagToken[] {
  const tags: HtmlTagToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const from = source.indexOf('<', cursor);
    if (from < 0) break;
    if (source.startsWith('<!--', from)) {
      const end = source.indexOf('-->', from + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }

    let quote: '"' | "'" | null = null;
    let to = -1;
    for (let index = from + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        to = index + 1;
        break;
      }
    }
    if (to < 0) break;

    const rawTag = source.slice(from, to);
    const match = /^<\s*(\/?)\s*([a-z][a-z\d-]*)\b/i.exec(rawTag);
    if (!match) {
      cursor = from + 1;
      continue;
    }
    tags.push({
      from,
      to,
      name: match[2].toLowerCase(),
      closing: match[1] === '/',
      selfClosing: /\/\s*>$/.test(rawTag) || voidHtmlTags.has(match[2].toLowerCase())
    });
    cursor = to;
    // Raw-text element bodies cannot consume following fragments through
    // literal angle brackets inside their text.
    if (!match[1] && /^(?:script|style|textarea)$/i.test(match[2])) {
      const closing = new RegExp(`</${match[2]}\\s*>`, 'ig');
      closing.lastIndex = cursor;
      const end = closing.exec(source);
      if (end) {
        tags.push({ from: end.index, to: closing.lastIndex, name: match[2].toLowerCase(), closing: true, selfClosing: false });
        cursor = closing.lastIndex;
      } else cursor = source.length;
    }
  }
  return tags;
}

/** Balanced root fragments retain offsets into the original text, never DOM serialization. */
export function splitHtmlBlockFragments(source: string): Array<{ from: number; to: number }> {
  const fragments: Array<{ from: number; to: number }> = [];
  const stack: string[] = [];
  let from = 0;
  for (const tag of scanHtmlTags(source)) {
    if (!stack.length) {
      if (tag.closing) continue;
      from = tag.from;
      if (tag.selfClosing) {
        fragments.push({ from, to: tag.to });
        continue;
      }
      stack.push(tag.name);
    } else if (tag.closing) {
      if (stack.at(-1) !== tag.name) continue;
      stack.pop();
      if (!stack.length) fragments.push({ from, to: tag.to });
    } else if (!tag.selfClosing) stack.push(tag.name);
  }
  return fragments;
}
