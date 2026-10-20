import type { ElkLayoutArguments, ElkNode } from 'elkjs/lib/elk-api';
import type { ElkLayoutRequest, ElkLayoutResponse, NativeElkWorkerRequest, NativeElkWorkerResponse } from '../../../src/protocol/elkLayout';
import { createClassicWorkerTransport } from './classicWorkerTransport';

type Transport = { send(request: ElkLayoutRequest): void; dispose(): void };
async function createElkTransport(uri: string, receive: (value: ElkLayoutResponse) => void, fail: (error: Error) => void): Promise<Transport> {
  const transport = await createClassicWorkerTransport<NativeElkWorkerRequest, NativeElkWorkerResponse>(uri, value => {
    const message = value.error instanceof Error ? value.error.message : typeof value.error === 'string' ? value.error
      : value.error && typeof value.error === 'object' && 'message' in value.error ? String(value.error.message) : 'ELK layout failed';
    if (value.id === 0) { if (value.error !== undefined) fail(new Error(message)); return; }
    if (value.error !== undefined) receive({ id: value.id, error: message });
    else if (value.data) receive({ id: value.id, graph: value.data });
    else fail(new Error('Invalid ELK worker response'));
  }, fail);
  try {
    transport.send({ id: 0, cmd: 'register', algorithms: ['layered', 'stress', 'mrtree', 'radial', 'force', 'disco',
      'sporeOverlap', 'sporeCompaction', 'rectpacking'] });
  } catch (error) { transport.dispose(); throw error; }
  return { dispose: () => transport.dispose(), send: request => transport.send({ id: request.id, cmd: 'layout', graph: request.graph,
    layoutOptions: request.options?.layoutOptions ?? {}, options: { logging: request.options?.logging ?? false,
      measureExecutionTime: request.options?.measureExecutionTime ?? false } }) };
}
type ClientOptions = {
  readonly createTransport?: (uri: string, receive: (value: ElkLayoutResponse) => void, fail: (error: Error) => void) => Promise<Transport>;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
  readonly maxQueued?: number;
};
type Job = { id: number; original: ElkNode; graph: ElkNode; options?: ElkLayoutArguments;
  resolve(graph: ElkNode): void; reject(error: Error): void };
const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Mermaid's graph carries renderer functions/DOM beside ELK's JSON data. Those
 * stay on the surface; only plain layout data enters the worker. */
function layoutData(graph: ElkNode): ElkNode {
  return JSON.parse(JSON.stringify(graph, (_key, value) => {
    if (typeof value === 'function') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value) && !plainObject(value)) return undefined;
    return value;
  }));
}

/** Preserve Mermaid's nodeDb aliases and renderer-only fields while adopting
 * computed geometry. ELK's in-thread API also mutates these same graph objects. */
function adoptLayout(previous: unknown, computed: unknown): unknown {
  if (typeof previous === 'function' || previous && typeof previous === 'object' && !Array.isArray(previous) && !plainObject(previous)) return previous;
  if (Array.isArray(computed)) {
    const existing: unknown[] = Array.isArray(previous) ? previous : [];
    const byId = new Map(existing.filter(plainObject).filter(item => typeof item.id === 'string').map(item => [item.id, item]));
    const values = computed.map((item, index) => adoptLayout(plainObject(item) && typeof item.id === 'string'
      ? byId.get(item.id) ?? (plainObject(existing[index]) && existing[index].id === undefined ? existing[index] : undefined)
      : existing[index], item));
    existing.length = values.length;
    for (let index = 0; index < values.length; index++) existing[index] = values[index];
    return existing;
  }
  if (!plainObject(computed)) return computed;
  const target = plainObject(previous) ? previous : {};
  for (const [key, value] of Object.entries(computed)) Object.defineProperty(target, key, {
    value: adoptLayout(Object.hasOwn(target, key) ? target[key] : undefined, value),
    enumerable: true, configurable: true, writable: true
  });
  return target;
}

/** One bounded ELK worker per Mermaid module, shared across Live and Preview.
 * Failures reject outstanding jobs; a later request may start a fresh worker. */
export function createMermaidElkLayoutClient(uri: string, options: ClientOptions = {}) {
  const queue: Job[] = [];
  let worker: Transport | undefined, flight: Job | undefined;
  let disposed = false, loading = false, generation = 0, sequence = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => { if (idle !== undefined) clearTimeout(idle); idle = undefined; };
  const stop = (error: Error) => {
    generation++; loading = false; clearIdle();
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined; worker?.dispose(); worker = undefined;
    flight?.reject(error); flight = undefined;
    for (const job of queue.splice(0)) job.reject(error);
  };
  const scheduleIdle = () => {
    if (flight || queue.length || disposed) return;
    clearIdle(); idle = setTimeout(() => stop(new Error('ELK worker retired while idle')), options.idleMs ?? 30_000);
  };
  const flush = async (): Promise<void> => {
    if (disposed || flight || loading || !queue.length) return;
    clearIdle();
    if (!worker) {
      loading = true;
      const current = ++generation;
      try {
        const loaded = await (options.createTransport ?? createElkTransport)(uri, value => {
          if (disposed || current !== generation) return;
          const job = flight;
          if (!job || value.id !== job.id) { stop(new Error('ELK layout response revision mismatch')); return; }
          if (deadline !== undefined) clearTimeout(deadline);
          deadline = undefined; flight = undefined;
          if (value.error !== undefined) job.reject(new Error(value.error));
          else if (!value.graph || value.graph.id !== job.graph.id) { job.reject(new Error('Invalid ELK layout graph')); }
          else {
            try { job.resolve(adoptLayout(job.original, value.graph) as ElkNode); }
            catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); }
          }
          scheduleIdle(); void flush();
        }, error => { if (current === generation) stop(error); });
        if (disposed || current !== generation) loaded.dispose(); else worker = loaded;
      } catch (error) { if (current === generation) stop(error instanceof Error ? error : new Error(String(error))); }
      finally { if (current === generation) { loading = false; void flush(); } }
      return;
    }
    const job = queue.shift()!;
    flight = job;
    deadline = setTimeout(() => stop(new Error('ELK layout worker timed out')), options.timeoutMs ?? 15_000);
    try { worker.send({ id: job.id, graph: job.graph, ...(job.options ? { options: job.options } : {}) }); }
    catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
  };
  return {
    layout(graph: ElkNode, arguments_?: ElkLayoutArguments): Promise<ElkNode> {
      if (disposed) return Promise.reject(new Error('ELK layout client is closed'));
      if (queue.length >= (options.maxQueued ?? 8)) return Promise.reject(new Error('ELK layout queue is full'));
      let data: ElkNode;
      try { data = layoutData(graph); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
      return new Promise((resolve, reject) => {
        queue.push({ id: ++sequence, original: graph, graph: data, options: arguments_, resolve, reject });
        void flush();
      });
    },
    dispose() { disposed = true; stop(new Error('ELK layout client is closed')); }
  };
}

let shared: ReturnType<typeof createMermaidElkLayoutClient> | undefined;
export function disposeMermaidElkLayoutWorker(): void { shared?.dispose(); shared = undefined; }

/** Build-time replacement for the ELK constructor used by Mermaid's layout
 * plugin. Labels and SVG painting retain Mermaid's original implementation. */
export default class MermaidElkLayout {
  layout(graph: ElkNode, options?: ElkLayoutArguments): Promise<ElkNode> {
    shared ??= createMermaidElkLayoutClient(new URL('./elk-layout-worker.js', import.meta.url).href);
    return shared.layout(graph, options);
  }
  terminateWorker(): void { disposeMermaidElkLayoutWorker(); }
}
