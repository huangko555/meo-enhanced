import { splitLines, type HighlighterCore, type GrammarState } from 'shiki/core';
import type { ShikiTokenLines } from './shikiTypes';

type Chunk = { from: number; to: number; before?: GrammarState; after?: GrammarState; lines: ShikiTokenLines };
type Snapshot = { lang: string; code: string; rows: ReturnType<typeof splitLines>; chunks: Chunk[]; bytes: number; complete: boolean };
const sameState = (left: GrammarState | undefined, right: GrammarState | undefined): boolean => left === right
  || !!left && !!right && left.getInternalStack()?.equals(right.getInternalStack()!) === true;
const sameRow = (left: Snapshot['rows'], a: number, right: Snapshot['rows'], b: number): boolean =>
  left[a]![0] === right[b]![0]
  && (left[a + 1]?.[1] ?? left[a]![1] + left[a]![0].length) - left[a]![1]
    === (right[b + 1]?.[1] ?? right[b]![1] + right[b]![0].length) - right[b]![1];
const yieldWork = () => new Promise<void>(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});

/** The existing worker owns this engine and retires it with its surface. */
export function createIncrementalShiki(highlighter: HighlighterCore) {
  const previous = new Set<Snapshot>();
  return {
    clear() { previous.clear(); },
    async tokenize(lang: string, code: string, isCurrent: () => boolean,
      progress?: (lines: ShikiTokenLines) => void): Promise<ShikiTokenLines | null> {
      if (!isCurrent()) return null;
      const rows = splitLines(code);
      let old: Snapshot | undefined, bestScore = -1;
      let prefix = 0, suffix = 0;
      for (const candidate of previous) {
        if (candidate.lang !== lang) continue;
        let start = 0, end = 0;
        while (start < rows.length && start < candidate.rows.length && sameRow(rows, start, candidate.rows, start)) start++;
        while (end < rows.length - start && end < candidate.rows.length - start
          && sameRow(rows, rows.length - end - 1, candidate.rows, candidate.rows.length - end - 1)) end++;
        const score = candidate.chunks.reduce((sum, chunk) => sum
          + (chunk.to <= start || chunk.from >= candidate.rows.length - end ? chunk.to - chunk.from : 0), 0);
        if (score > bestScore || score === bestScore && start > prefix) { old = candidate; prefix = start; suffix = end; bestScore = score; }
      }
      const delta = rows.length - (old?.rows.length ?? 0);
      const reusable = new Map<number, Chunk>();
      for (const chunk of old?.chunks ?? []) {
        if (chunk.to <= prefix) reusable.set(chunk.from, chunk);
        else if (chunk.from >= old!.rows.length - suffix) reusable.set(chunk.from + delta, chunk);
      }
      const boundaries = [...reusable.keys()].sort((a, b) => a - b);
      const chunks: Chunk[] = [], output: (ShikiTokenLines[number])[] = [];
      let state: GrammarState | undefined, from = 0, boundary = 0, bytes = code.length * 2, published = false;
      let deadline = performance.now() + 8;
      let nextProgress = 0;
      const retain = () => {
        const complete = from === rows.length;
        for (const snapshot of previous) if (snapshot.lang === lang && snapshot.code === code) {
          if (!complete && (snapshot.chunks.at(-1)?.to ?? 0) > from) return;
          previous.delete(snapshot);
        }
        previous.add({ lang, code, rows, chunks, bytes, complete });
        let retainedBytes = [...previous].reduce((sum, snapshot) => sum + snapshot.bytes, 0);
        while (previous.size > 1 && (previous.size > 4 || retainedBytes > 32 * 1024 * 1024)) {
          // A cancelled prefix must not evict the completed revision needed by
          // the next keystroke. Retain one oversized document, as the UI cache does.
          const oldest = [...previous].find(snapshot => !snapshot.complete) ?? previous.values().next().value!;
          retainedBytes -= oldest.bytes; previous.delete(oldest);
        }
      };
      while (from < rows.length) {
        if (!isCurrent()) { retain(); return null; }
        let chunk = reusable.get(from);
        if (chunk && sameState(state, chunk.before)) chunk = { ...chunk, from, to: from + chunk.to - chunk.from };
        else {
          while (boundary < boundaries.length && boundaries[boundary]! <= from) boundary++;
          const to = Math.min(rows.length, from + 64, boundaries[boundary] ?? Infinity);
          const last = rows[to - 1]!;
          const result = highlighter.codeToTokens(code.slice(rows[from]![1], last[1] + last[0].length),
            { lang, theme: 'meo-code-theme', includeExplanation: 'scopeName', grammarState: state });
          chunk = { from, to, before: state, after: result.grammarState,
            lines: result.tokens.map(line => line.map(syntax => ({ offset: syntax.offset, content: syntax.content,
              color: syntax.color, fontStyle: syntax.fontStyle,
              isStringComment: syntax.explanation?.some(part => part.scopes.some(scope => /^(string|comment)/.test(scope.scopeName))) ?? false }))) };
        }
        chunks.push(chunk); state = chunk.after;
        const offset = rows[from]![1];
        for (const line of chunk.lines) {
          bytes += 32 + line.reduce((sum, syntax) => sum + 96 + syntax.content.length * 2, 0);
          output.push(line.map(syntax => ({ ...syntax, offset: syntax.offset + offset })));
        }
        from = chunk.to;
        if (from >= 128 && from < rows.length && (!published || performance.now() >= nextProgress)) {
          published = true; nextProgress = performance.now() + 100; progress?.(output);
        }
        // Yield even on cache hits so a superseding edit can stop reconstruction.
        if (performance.now() >= deadline) { await yieldWork(); deadline = performance.now() + 8; }
      }
      retain();
      return isCurrent() ? output : null;
    }
  };
}
