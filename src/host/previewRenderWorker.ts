import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PreviewRenderValue } from '../protocol/previewRender';
import type { PreviewPresetDefinition, PreviewContentWidth, PreviewPresetId } from '../foundation/previewPresets';
import type { ResolvedWikiResources } from '../foundation/wikiReference';
import type { UiLanguage } from '../foundation/uiLanguage';
import type { EditorStyleEnvironment } from '../protocol/editorStyleEnvironment';
import type { PreviewDocumentOperation, PreviewDocumentResult } from '../foundation/previewDocument';

export type BackgroundPreviewOptions = Readonly<{
  markdownText: string;
  sourceDocumentPath: string;
  uiLanguage: UiLanguage;
  styleEnvironment?: EditorStyleEnvironment;
  preset?: PreviewPresetId;
  presetDefinition?: PreviewPresetDefinition;
  contentWidth?: PreviewContentWidth;
  wikiResources?: ResolvedWikiResources;
}>;

type PreviewWorkerOperation =
  | { readonly kind: 'render'; readonly options: BackgroundPreviewOptions }
  | { readonly kind: 'open'; readonly owner: string; readonly documentId: string;
      readonly options: BackgroundPreviewOptions; readonly anchorLine: number }
  | { readonly kind: 'document'; readonly owner: string; readonly documentId: string; readonly operation: PreviewDocumentOperation }
  | { readonly kind: 'release'; readonly owner: string };
export type PreviewWorkerRequest = Readonly<{ id: number }> & PreviewWorkerOperation;
type PreviewWorkerValue = PreviewRenderValue | PreviewDocumentResult | null;
export type PreviewWorkerResponse = Readonly<{ id: number }> & (
  | { value: PreviewWorkerValue; error?: never }
  | { error: string; value?: never }
);

/** One extension-owned worker, bounded queue and idle lifetime for expensive Preview work. */
export function createBackgroundPreviewRenderer(workerPath: string) {
  let worker: Worker | null = null;
  let disposed = false;
  let nextId = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const owners = new Set<string>();
  const releasingOwners = new Set<string>();
  const pending = new Map<number, { resolve(value: PreviewWorkerValue): void; reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout> }>();
  const clearIdle = () => { if (idle !== null) clearTimeout(idle); idle = null; };
  const scheduleIdle = (current: Worker) => {
    if (pending.size !== 0 || owners.size !== 0) return;
    clearIdle();
    idle = setTimeout(() => {
      if (worker === current && pending.size === 0) { worker = null; void current.terminate(); }
      idle = null;
    }, 30_000);
  };
  const stop = (error: Error) => {
    clearIdle();
    const current = worker;
    worker = null;
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    pending.clear();
    owners.clear();
    void current?.terminate();
  };
  const getWorker = (): Worker => {
    clearIdle();
    if (worker) return worker;
    // Overlap independent disk reads. Grammar initialization stays lazy, while
    // the first code block need not inherit another catalogue's cold file read.
    void readFile(join(dirname(workerPath), 'fallback-code-highlighter.js')).then(() => {}, () => {});
    const current = worker = new Worker(workerPath);
    current.on('message', (response: PreviewWorkerResponse) => {
      if (worker !== current) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timeout);
      if (response.error !== undefined) request.reject(new Error(response.error));
      else request.resolve(response.value);
      scheduleIdle(current);
    });
    current.on('error', error => { if (worker === current) stop(error instanceof Error ? error : new Error(String(error))); });
    current.on('exit', code => { if (worker === current) stop(new Error(`Preview worker exited (${code})`)); });
    return current;
  };
  const request = <Value extends PreviewWorkerValue>(operation: PreviewWorkerOperation): Promise<Value> => {
      if (disposed) return Promise.reject(new Error('Preview renderer is closed'));
      if (pending.size >= 16) return Promise.reject(new Error('Preview renderer queue is full'));
      return new Promise((resolve, reject) => {
        try {
          const current = getWorker();
          const id = ++nextId;
          const timeout = setTimeout(() => stop(new Error('Preview worker timed out')), 14_000);
          pending.set(id, { resolve: value => resolve(value as Value), reject, timeout });
          try { current.postMessage({ id, ...operation } satisfies PreviewWorkerRequest); }
          catch (error) { clearTimeout(timeout); pending.delete(id); scheduleIdle(current); reject(error); }
        } catch (error) { reject(error); }
      });
  };
  const retainOwner = (owner: string) => {
    if (!disposed && !releasingOwners.has(owner)) { owners.add(owner); clearIdle(); }
  };
  return {
    render: async (owner: string, options: BackgroundPreviewOptions) => {
      const value = await request<PreviewRenderValue>({ kind: 'render', options });
      retainOwner(owner);
      return value;
    },
    open: async (owner: string, documentId: string, options: BackgroundPreviewOptions, anchorLine: number) => {
      const value = await request<PreviewRenderValue>({ kind: 'open', owner, documentId, options, anchorLine });
      retainOwner(owner);
      return value;
    },
    operate: (owner: string, documentId: string, operation: PreviewDocumentOperation) =>
      request<PreviewDocumentResult>({ kind: 'document', owner, documentId, operation }),
    release: async (owner: string) => {
      owners.delete(owner);
      if (worker === null) return null;
      releasingOwners.add(owner);
      try {
        const value = await request<null>({ kind: 'release', owner });
        if (worker) scheduleIdle(worker);
        return value;
      } finally { releasingOwners.delete(owner); }
    },
    dispose() { disposed = true; stop(new Error('Preview renderer is closed')); }
  };
}
