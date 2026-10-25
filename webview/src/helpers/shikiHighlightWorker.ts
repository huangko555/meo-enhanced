import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/wasm';
import { toShikiTheme } from './shikiTheme';
import type { ShikiWorkerRequest, ShikiWorkerResponse } from './shikiTypes';
import { packShikiTokens } from './shikiTokenTransfer';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ShikiWorkerRequest>) => void) | null;
  postMessage(message: ShikiWorkerResponse, transfer?: Transferable[]): void;
};
let highlighter: HighlighterCore | undefined;
let queue = Promise.resolve();
worker.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      highlighter ??= await createHighlighterCore({ themes: [toShikiTheme(data.theme)], langs: [],
        engine: await createOnigurumaEngine(wasm) });
      if (data.grammars.length) await highlighter.loadLanguage(...data.grammars as any[]);
      const result = highlighter.codeToTokens(data.code, { lang: data.lang, theme: 'meo-code-theme', includeExplanation: 'scopeName' });
      const tokens = packShikiTokens(result.tokens);
      worker.postMessage({ id: data.id, tokens }, [tokens.rows.buffer, tokens.tokens.buffer]);
    } catch (error) { worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
