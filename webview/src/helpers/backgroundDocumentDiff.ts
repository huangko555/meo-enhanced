import type { DocumentDiff } from '../../../src/shared/gitDiffCore';
import type { GitDiffWorkerRequest, GitDiffWorkerResponse } from './gitDiffWorker';

const sources = new Map<string, Promise<string>>();

function loadWorkerSource(uri: string): Promise<string> {
  let source = sources.get(uri);
  if (!source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    source = fetch(uri, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Could not load document diff worker');
      return response.text();
    }).finally(() => clearTimeout(timeout));
    sources.set(uri, source);
    void source.catch(() => { if (sources.get(uri) === source) sources.delete(uri); });
  }
  return source;
}

/** One in-flight comparison per editor. Cancelling terminates running CPU work,
 * not just its callback. A failed worker never falls back to UI-thread diffing. */
export function createBackgroundDocumentDiff(publish: (result: DocumentDiff | null) => void) {
  let generation = 0;
  let disposed = false;
  let worker: Worker | undefined;
  let pending = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    generation += 1;
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    if (pending) {
      worker?.terminate();
      worker = undefined;
    }
    pending = false;
  };

  return {
    request(baseline: string, current: string): void {
      if (disposed) return;
      cancel();
      const id = generation;
      pending = true;
      const finish = (result: DocumentDiff | null) => {
        if (disposed || id !== generation || !pending) return;
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        pending = false;
        if (!result) { worker?.terminate(); worker = undefined; }
        publish(result);
      };
      timeout = setTimeout(() => finish(null), 5_000);
      void (async () => {
        try {
          if (!worker) {
            const uri = document.body.dataset.meoGitDiffWorkerSrc;
            if (!uri) throw new Error('Document diff worker URI is missing');
            const source = await loadWorkerSource(uri);
            if (disposed || id !== generation || !pending) return;
            const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try { worker = new Worker(blob); }
            finally { URL.revokeObjectURL(blob); }
          }
          worker.onmessage = ({ data }: MessageEvent<GitDiffWorkerResponse>) => {
            if (data.id === id) finish(data.result);
          };
          worker.onerror = event => { event.preventDefault(); finish(null); };
          worker.onmessageerror = () => finish(null);
          worker.postMessage({ id, baseline, current } satisfies GitDiffWorkerRequest);
        } catch { finish(null); }
      })();
    },
    cancel,
    dispose(): void {
      disposed = true;
      cancel();
      worker?.terminate();
      worker = undefined;
    }
  };
}
