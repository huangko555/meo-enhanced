import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/wasm';
import { toShikiTheme } from './shikiTheme';
import type { ShikiWorkerRequest, ShikiWorkerResponse } from './shikiTypes';
import { packShikiTokens } from './shikiTokenTransfer';
import { createIncrementalShiki } from './incrementalShiki';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ShikiWorkerRequest | { cancel: number }>) => void) | null;
  postMessage(message: ShikiWorkerResponse, transfer?: Transferable[]): void;
};
let highlighter: HighlighterCore | undefined;
let incremental: ReturnType<typeof createIncrementalShiki> | undefined;
const cancelled = new Set<number>();
let activeId: number | undefined;
let queue = Promise.resolve();
worker.onmessage = ({ data }) => {
  if ('cancel' in data) { if (activeId === data.cancel) cancelled.add(data.cancel); return; }
  queue = queue.then(async () => {
    activeId = data.id;
    try {
      highlighter ??= await createHighlighterCore({ themes: [toShikiTheme(data.theme)], langs: [],
        engine: await createOnigurumaEngine(wasm) });
      incremental ??= createIncrementalShiki(highlighter);
      if (data.grammars.length) { await highlighter.loadLanguage(...data.grammars as any[]); incremental.clear(); }
      let checkpoint = performance.now() + 100;
      let published = 0;
      const result = await incremental.tokenize(data.lang, data.code, () => {
        if (performance.now() >= checkpoint) { checkpoint = performance.now() + 100; worker.postMessage({ id: data.id, checkpoint: true }); }
        return !cancelled.has(data.id);
      }, lines => {
        const tokens = packShikiTokens(lines.slice(published));
        worker.postMessage({ id: data.id, tokens, partial: true, fromLine: published }, [tokens.rows.buffer, tokens.tokens.buffer]);
        published = lines.length;
      });
      const tokens = result ? packShikiTokens(result.slice(published)) : undefined;
      worker.postMessage({ id: data.id, tokens, fromLine: published }, tokens ? [tokens.rows.buffer, tokens.tokens.buffer] : []);
    } catch (error) { worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
    finally { cancelled.delete(data.id); activeId = undefined; }
  });
};
