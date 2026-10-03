import type { InputAssistance } from '../../../src/foundation/editingPreferences';

export const symbolPairs: Readonly<Record<string, string>> = {
  '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`',
  '（': '）', '【': '】', '“': '”', '‘': '’', '《': '》', '「': '」', '『': '』'
};

// Markdown surrounding pairs are broader than empty-cursor auto-closing pairs.
const surroundingPairs: Readonly<Record<string, string>> = { ...symbolPairs, '<': '>', '*': '*', '_': '_', '~': '~', '$': '$', '^': '^', '=': '=' };

export function inlineCodeMarkers(text: string): { open: string; close: string } {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = '`'.repeat(longest + 1);
  const padding = text.startsWith('`') || text.endsWith('`') || /^ .* $/.test(text) && /\S/.test(text) ? ' ' : '';
  return { open: marker + padding, close: padding + marker };
}

export type SymbolInputPlan =
  | { readonly type: 'skip'; readonly length: number }
  | { readonly type: 'insert'; readonly text: string; readonly anchor: number; readonly head: number; readonly open: string; readonly close: string };

/** Receives only bounded surrounding text; provenance is supplied by the editor adapter. */
export function planSymbolInput(options: {
  readonly typed: string;
  readonly selected: string;
  readonly before: string;
  readonly after: string;
  readonly automaticRight: boolean;
  readonly preferences: InputAssistance;
}): SymbolInputPlan | null {
  const { typed, selected, before, after, automaticRight, preferences } = options;
  if (typed.length !== 1) return null;
  if (selected) {
    const close = surroundingPairs[typed];
    if (!preferences.wrapSelection || !close || /^[ \t\r\n]+$/.test(selected)) return null;
    if ((typed === "'" || typed === '"') && (selected === "'" || selected === '"' || selected === '`')) return null;
    const markers = typed === '`' ? inlineCodeMarkers(selected) : { open: typed, close };
    return { type: 'insert', text: markers.open + selected + markers.close,
      anchor: markers.open.length, head: markers.open.length + selected.length, ...markers };
  }
  if ((/\\+$/.exec(before)?.[0].length ?? 0) % 2 === 1) return null;
  const close = symbolPairs[typed];
  // After an empty inline pair, further backticks belong to a literal Markdown fence.
  if (typed === '`' && /`{2,}$/.test(before)) return null;
  if (after.startsWith(typed) && Object.values(symbolPairs).includes(typed) && preferences.skipMode !== 'off') {
    const left = Object.keys(symbolPairs).find(left => symbolPairs[left] === typed)!;
    let depth = 0, quotes = 0;
    for (let index = before.length - 1; index >= 0; index--) {
      const character = before[index];
      const escaped = (/\\+$/.exec(before.slice(0, index))?.[0].length ?? 0) % 2;
      if (escaped) continue;
      if (left === typed) { if (character === typed) quotes++; }
      else if (character === typed) depth++;
      else if (character === left) { if (!depth) { depth = -1; break; } depth--; }
    }
    const matching = automaticRight || (left === typed ? quotes % 2 === 1 : depth === -1);
    if (matching && (preferences.skipMode === 'always' || automaticRight)) return { type: 'skip', length: 1 };
  }
  if (!close || preferences.pairMode === 'off') return null;
  if (preferences.pairMode === 'smart') {
    if ((typed === "'" || typed === '"' || typed === '`') && /[\p{L}\p{N}]$/u.test(before)) return null;
    if (after && !/^[\s)\]}）】”’》」』,.;:!?，。；：！？]/u.test(after)) return null;
  }
  return { type: 'insert', text: typed + close, anchor: 1, head: 1, open: typed, close };
}

export function shouldDeleteSymbolPair(left: string, right: string, automatic: boolean, preferences: InputAssistance): boolean {
  return preferences.deleteMode !== 'off' && symbolPairs[left] === right
    && (preferences.deleteMode === 'always' || automatic);
}

export function planInlineWrapper(text: string, before: string, after: string, open: string, close: string): { insert: string; removeBefore: number; removeAfter: number; selectedFrom: number; selectedTo: number } {
  if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
    const insert = text.slice(open.length, -close.length);
    return { insert, removeBefore: 0, removeAfter: 0, selectedFrom: 0, selectedTo: insert.length };
  }
  if (before.endsWith(open) && after.startsWith(close)) return { insert: text, removeBefore: open.length, removeAfter: close.length, selectedFrom: 0, selectedTo: text.length };
  return { insert: open + text + close, removeBefore: 0, removeAfter: 0, selectedFrom: open.length, selectedTo: open.length + text.length };
}
