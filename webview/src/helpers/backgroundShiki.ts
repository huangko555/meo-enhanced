import type { RawVscodeTheme, ShikiTokenLines, ShikiWorkerRequest, ShikiWorkerResponse } from './shikiTypes';

let source: { uri: string; promise: Promise<string> } | undefined;
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
};

/** A surface owns one engine, one running request and a bounded queue. Grammar
 * compilation and tokenization never execute on the editor's event loop. */
export function createBackgroundShiki(uri: string, theme: RawVscodeTheme,
  loadGrammars: (lang: string, code: string, loaded: Set<string>) => Promise<readonly unknown[]>) {
  let worker: Worker | undefined, disposed = false, nextId = 0, running: Job | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [], loaded = new Set<string>();
  const retire = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    worker?.terminate(); worker = undefined; loaded.clear();
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
    timeout = setTimeout(() => finish(null, true), 20_000);
    try {
      if (!worker) {
        const text = await loadSource(uri);
        if (disposed || running !== job) return;
        const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        worker.onmessage = ({ data }: MessageEvent<ShikiWorkerResponse>) => {
          if (data.id === running?.id) finish(data.tokens ?? null, !!data.error);
        };
        worker.onerror = event => { event.preventDefault(); finish(null, true); };
        worker.onmessageerror = () => finish(null, true);
      }
      const nextLoaded = new Set(loaded);
      const grammars = await loadGrammars(job.lang, job.code, nextLoaded);
      if (disposed || running !== job) return;
      if (!job.isNeeded()) { finish(null); return; }
      worker.postMessage({ id: job.id, lang: job.lang, code: job.code, grammars, theme } satisfies ShikiWorkerRequest);
      for (const language of nextLoaded) loaded.add(language);
    } catch { if (running === job) finish(null, true); }
  };
  return {
    request(lang: string, code: string, isNeeded: () => boolean): Promise<ShikiTokenLines | null> {
      if (disposed) return Promise.resolve(null);
      while (queue.length >= 16 || queue.length && queue.reduce((size, job) => size + job.code.length, code.length) > 4_194_304) {
        queue.shift()!.resolve(null);
      }
      return new Promise(resolve => { queue.push({ id: ++nextId, lang, code, isNeeded, resolve }); void pump(); });
    },
    dispose(): void {
      disposed = true; retire();
      running?.resolve(null); running = undefined;
      for (const job of queue.splice(0)) job.resolve(null);
    }
  };
}
