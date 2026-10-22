function lineBreaks(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = text.indexOf('\n', from); at >= 0 && at < to; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** Source lines and window block indices belong to a revision, not a DOM node.
 * Map the accepted roots into the replacement revision before morphing. Only
 * mounted roots are indexed; no DOM serialization, content hash or history cache.
 * The renderer still compares actual output, including cross-block references.
 */
export type PreviewSourceLineMapper = (line: number) => number | undefined;

export function previewSourceLineMapper(before: string | null, after: string): PreviewSourceLineMapper {
  let mapLine = (line: number): number | undefined => line;
  if (before !== null && before !== after) {
    let from = 0, oldTo = before.length, newTo = after.length;
    while (from < Math.min(oldTo, newTo) && before.charCodeAt(from) === after.charCodeAt(from)) from++;
    while (oldTo > from && newTo > from && before.charCodeAt(oldTo - 1) === after.charCodeAt(newTo - 1)) { oldTo--; newTo--; }
    const first = lineBreaks(before, 0, from) + 1;
    const last = first + lineBreaks(before, from, oldTo);
    const delta = lineBreaks(after, from, newTo) - (last - first);
    const startsAtLine = from === 0 || before[from - 1] === '\n';
    const endsAtLine = oldTo === 0 || before[oldTo - 1] === '\n';
    mapLine = line => {
      if (line < first) return line;
      if (line === first) {
        // A removed leading block cannot claim its unchanged successor's key.
        if (startsAtLine && last > first) return;
        return line + (from === oldTo && startsAtLine ? delta : 0);
      }
      // A range's end is exclusive. The block beginning exactly there survives.
      if (line > last || line === last && endsAtLine) return line + delta;
      return undefined;
    };
  }
  return mapLine;
}

export function previewSourceMorphKeys(current: HTMLElement, next: HTMLElement, before: string | null, after: string,
  mapLine = previewSourceLineMapper(before, after)): WeakMap<Node, string> {
  const keys = new WeakMap<Node, string>();
  const available = new Map<string, Element>();
  const index = (root: HTMLElement, map: (line: number) => number | undefined, previous: boolean) => {
    const counts = new Map<string, number>();
    for (const element of Array.from(root.children)) {
      if (element.hasAttribute('data-meo-preview-gap')) continue;
      // Markdown's table wrapper has no authored position of its own. Its
      // direct table owns that source identity; a window's block index changes
      // when new paragraphs are inserted above it.
      const source = element.getAttribute('data-source-line')
        ?? (element.classList.contains('meo-table-scroll')
          ? element.querySelector(':scope > table[data-source-line]')?.getAttribute('data-source-line') ?? null : null);
      if (source === null || !Number.isSafeInteger(Number(source)) || Number(source) < 1) continue;
      const line = map(Number(source));
      if (line === undefined) continue;
      const base = `preview-source:${element.tagName}:${line}`;
      const ordinal = counts.get(base) ?? 0;
      counts.set(base, ordinal + 1);
      const key = `${base}:${ordinal}`;
      if (previous) available.set(key, element);
      else {
        const accepted = available.get(key);
        if (accepted) { keys.set(accepted, key); keys.set(element, key); }
      }
    }
  };
  // Only a proven pair receives a key. Changed/unmatched roots retain ordinary
  // morphing, including the atomic handoff of highlighted code replacements.
  index(current, mapLine, true); index(next, line => line, false);
  return keys;
}
