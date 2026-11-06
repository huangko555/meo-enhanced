import type { RawVscodeTheme, ShikiTokenLines, ShikiWorkerRequest, ShikiWorkerResponse } from './shikiTypes';
import { unpackShikiTokens } from './shikiTokenTransfer';

let source: { uri: string; promise: Promise<string> } | undefined;
let binary: { uri: string; promise: Promise<ArrayBuffer> } | undefined;
async function loadWasm(uri: string): Promise<ArrayBuffer> {
  if (binary?.uri !== uri) {
    const promise = fetch(uri, { signal: AbortSignal.timeout(5_000) }).then(async response => {
      if (!response.ok) throw new Error('Could not load syntax highlighting WASM');
      return response.arrayBuffer();
    });
    binary = { uri, promise };
    void promise.catch(() => { if (binary?.promise === promise) binary = undefined; });
  }
  return binary.promise;
}

async function loadSource(uri: string): Promise<string> {
  if (source?.uri !== uri) {
    const promise = fetch(uri, { signal: AbortSignal.timeout(5_000) }).then(response => {
      if (!response.ok) throw new Error('Could not load syntax highlighting worker');
      return response.text();
    });
    source = { uri, promise };
    void promise.catch(() => { if (source?.promise === promise) source = undefined; });
  }
  return source.promise;
}

type Job = {
  readonly id: number;
  readonly lang: string;
  readonly code: string;
  readonly isNeeded: () => boolean;
  readonly resolve: (tokens: ShikiTokenLines | null) => void;
  readonly progress?: (tokens: ShikiTokenLines) => void;
  readonly received: Array<ShikiTokenLines[number]>;
};

/** A surface owns one engine, one running request and a bounded queue. Grammar
 * compilation and tokenization never execute on the editor's event loop. */
export function createBackgroundShiki(uri: string, theme: RawVscodeTheme,
  loadGrammars: (lang: string, code: string, loaded: Set<string>) => Promise<readonly unknown[]>) {
  let worker: Worker | undefined, disposed = false, nextId = 0, running: Job | undefined;
  let workerWasm: ArrayBuffer | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [], loaded = new Set<string>();
  const retire = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    worker?.terminate(); worker = undefined; workerWasm = undefined; loaded.clear();
  };
  const armTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => finish(null, true), 20_000);
  };
  const finish = (tokens: ShikiTokenLines | null, reset = false) => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    const job = running; running = undefined;
    if (reset) retire();
    job?.resolve(job.isNeeded() ? tokens : null);
    if (!disposed) void pump();
  };
  const pump = async () => {
    if (disposed || running) return;
    while (queue.length) {
      const next = queue.shift()!;
      if (next.isNeeded()) { running = next; break; }
      next.resolve(null);
    }
    const job = running;
    if (!job) return;
    armTimeout();
    try {
      if (!worker) {
        const wasmUri = document.body.dataset.meoShikiWasmSrc
          ?? new URL('onig.wasm', new URL(uri, document.baseURI)).href;
        const [text, bytes] = await Promise.all([loadSource(uri), loadWasm(wasmUri)]);
        if (disposed || running !== job) return;
        // Keep the shared cache attached. Each worker receives its own bounded
        // transferable copy, retained until its first real request is sent.
        workerWasm = bytes.slice(0);
        const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        let delivery = Promise.resolve();
        worker.onmessage = ({ data }: MessageEvent<ShikiWorkerResponse>) => {
          const active = running;
          if (!active || data.id !== active.id) return;
          if (!active.isNeeded()) worker?.postMessage({ cancel: active.id });
          if (data.checkpoint) return;
          delivery = delivery.then(async () => {
            if (running !== active) return;
            try {
              const tokens = data.tokens && active.isNeeded()
                ? await unpackShikiTokens(data.tokens, active.code, () => !disposed && running === active && active.isNeeded()) : null;
              if (running === active) {
                if (tokens) {
                  if ((data.fromLine ?? 0) !== active.received.length) throw new Error('Syntax result arrived out of order');
                  const previousRows = active.received.length;
                  for (const line of tokens) active.received.push(line);
                  // A large fence can legitimately outlive one timeout window
                  // on a slow machine. Only accepted new rows prove progress;
                  // checkpoints, stale packets and silence retain the watchdog.
                  if (active.received.length > previousRows) armTimeout();
                }
                if (data.partial) { if (tokens && active.isNeeded()) active.progress?.(active.received); }
                else finish(tokens ? active.received : null, !!data.error);
              }
            } catch { if (running === active) finish(null, true); }
          });
        };
        worker.onerror = event => { event.preventDefault(); finish(null, true); };
        worker.onmessageerror = () => finish(null, true);
      }
      const nextLoaded = new Set(loaded);
      const grammars = await loadGrammars(job.lang, job.code, nextLoaded);
      if (disposed || running !== job) return;
      if (!job.isNeeded()) { finish(null); return; }
      const wasm = workerWasm;
      worker.postMessage({ id: job.id, lang: job.lang, code: job.code, grammars, theme, wasm } satisfies ShikiWorkerRequest,
        wasm ? [wasm] : []);
      workerWasm = undefined;
      for (const language of nextLoaded) loaded.add(language);
    } catch { if (running === job) finish(null, true); }
  };
  return {
    request(lang: string, code: string, isNeeded: () => boolean, progress?: (tokens: ShikiTokenLines) => void): Promise<ShikiTokenLines | null> {
      if (disposed) return Promise.resolve(null);
      if (running && !running.isNeeded()) worker?.postMessage({ cancel: running.id });
      while (queue.length >= 16 || queue.length && queue.reduce((size, job) => size + job.code.length, code.length) > 4_194_304) {
        queue.shift()!.resolve(null);
      }
      return new Promise(resolve => { queue.push({ id: ++nextId, lang, code, isNeeded, resolve, progress, received: [] }); void pump(); });
    },
    dispose(): void {
      disposed = true; retire();
      running?.resolve(null); running = undefined;
      for (const job of queue.splice(0)) job.resolve(null);
    }
  };
}
