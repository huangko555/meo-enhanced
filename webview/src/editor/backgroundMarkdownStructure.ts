import { ParseContext, syntaxTree } from '@codemirror/language';
import { ChangeSet, Facet, type EditorState, type Extension, type Text } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { TreeFragment, type NodeSet, type ParseWrapper, type Tree } from '@lezer/common';
import { readDocumentTextProjection } from '../application/documentTextProjection';
import { liveInputDerivedWorkReadiness, usesLargeDocumentDerivedWorkBudget } from './liveInputDerivedWork';
import { acceptCompletedMarkdownStructure, isCompleteMarkdownStructure } from './markdownStructure';
import { createMarkdownTreeReceiver } from './markdownTreeTransfer';
import type { MarkdownParseRequest, MarkdownParseResponse } from './markdownParseProtocol';
import { createClassicWorkerTransport } from '../adapters/classicWorkerTransport';

type Result = { readonly doc: Text; readonly ready: Promise<void>; resolve(): void;
  status: 'pending' | 'ready' | 'superseded'; tree?: Tree };

function createBackgroundMarkdownStructure(uri: string, nodeSet: NodeSet) {
  const receiver = createMarkdownTreeReceiver(nodeSet), cache = new WeakMap<Text, Result>(), waiting = new Set<Result>();
  const grammar = nodeSet.types.map(type => type.name).join('\0');
  let mixedFragments: readonly TreeFragment[] = [];
  const pendingMixed = new WeakMap<Text, { tree: Tree; partial: boolean }>();
  let latest: Text | undefined, posted: Text | undefined, requested: Text | undefined;
  let changes: ChangeSet | null = null, sequence = 0, postedRevision = 0;
  let worker: Awaited<ReturnType<typeof createClassicWorkerTransport<MarkdownParseRequest, MarkdownParseResponse>>> | undefined;
  let loading = false, disposed = false, queued = false, attached = false;
  let failure: Error | undefined, flight: { id: number; result: Result } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined; worker?.dispose(); worker = undefined;
    receiver.clear(); flight = undefined; posted = undefined; changes = null; mixedFragments = [];
    for (const result of waiting) { result.status = 'superseded'; result.resolve(); }
    waiting.clear();
  };
  const fail = (error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); stop(); };
  const schedule = () => {
    if (queued || disposed || failure) return;
    queued = true;
    queueMicrotask(() => { queued = false; void flush(); });
  };
  const read = (doc: Text): Result => {
    const existing = cache.get(doc);
    if (existing && existing.status !== 'superseded') return existing;
    let resolve!: () => void;
    const result: Result = { doc, status: 'pending', ready: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    cache.set(doc, result); requested = doc;
    for (const previous of waiting) if (previous !== flight?.result) {
      previous.status = 'superseded'; previous.resolve(); waiting.delete(previous);
    }
    if (disposed || failure) { result.status = 'superseded'; result.resolve(); }
    else { waiting.add(result); schedule(); }
    return result;
  };
  const flush = async () => {
    if (disposed || !attached || failure || flight || loading) return;
    const doc = latest ?? requested;
    if (!doc) return;
    const result = cache.get(doc);
    if (!result || result.status !== 'pending') return;
    if (!worker) {
      loading = true;
      try {
        const loaded = await createClassicWorkerTransport<MarkdownParseRequest, MarkdownParseResponse>(uri, data => {
          try {
            if (!flight || data.id !== flight.id) throw new Error('Markdown parser response revision mismatch');
            if (data.error !== undefined) throw new Error(data.error);
            if (data.grammar !== grammar || data.length !== flight.result.doc.length) throw new Error('Markdown parser response grammar/document mismatch');
            const tree = acceptCompletedMarkdownStructure(receiver.receive(data.tree), data.length);
            const accepted = flight.result;
            accepted.tree = tree; accepted.status = 'ready'; accepted.resolve(); waiting.delete(accepted);
            if (timeout !== undefined) clearTimeout(timeout);
            timeout = undefined; flight = undefined; schedule();
          } catch (error) { fail(error); }
        }, fail);
        if (disposed || failure) { loaded.dispose(); return; }
        worker = loaded;
      } catch (error) { fail(error); }
      finally { loading = false; schedule(); }
      return;
    }
    try {
      const id = ++sequence;
      let request: MarkdownParseRequest;
      if (!posted) request = { id, base: 0, text: readDocumentTextProjection(doc) };
      else {
        if (!changes || changes.length !== posted.length || changes.newLength !== doc.length) throw new Error('Missing incremental Markdown parser changes');
        request = { id, base: postedRevision, changes: changes.toJSON() };
      }
      flight = { id, result }; posted = doc; postedRevision = id; changes = null;
      timeout = setTimeout(() => fail(new Error('Markdown parser worker timed out')), 20_000);
      worker.send(request);
    } catch (error) { fail(error); }
  };
  return {
    read,
    observe(before: Text, after: Text, update: ChangeSet) {
      if (disposed || before === after) return;
      if (failure) { latest = after; return; }
      if (latest && latest !== before) { fail(new Error('Markdown parser document stream mismatch')); return; }
      latest = after;
      const ranges: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
      update.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
      mixedFragments = TreeFragment.applyChanges(mixedFragments, ranges);
      const completed = pendingMixed.get(after);
      if (completed) { mixedFragments = TreeFragment.addTree(completed.tree, mixedFragments, completed.partial); pendingMixed.delete(after); }
      if (posted) changes = changes ? changes.compose(update) : update;
    },
    attach(doc: Text) {
      latest = doc; attached = true;
      const completed = pendingMixed.get(doc);
      if (completed) { mixedFragments = TreeFragment.addTree(completed.tree, mixedFragments, completed.partial); pendingMixed.delete(doc); }
      schedule();
    },
    canPublish(doc: Text) { return attached && latest === doc; },
    mixed(doc: Text, fallback: readonly TreeFragment[]) { return latest === doc && mixedFragments.length ? mixedFragments : fallback; },
    remember(doc: Text, tree: Tree, partial: boolean) {
      if (disposed || failure || tree.length !== doc.length || tree.type.name !== 'Document') return;
      if (latest === doc) mixedFragments = TreeFragment.addTree(tree, mixedFragments, partial);
      else pendingMixed.set(doc, { tree, partial });
    },
    get error() { return failure; },
    dispose() { disposed = true; attached = false; stop(); latest = requested = undefined; }
  };
}

const runtime = Facet.define<ReturnType<typeof createBackgroundMarkdownStructure>, ReturnType<typeof createBackgroundMarkdownStructure> | null>({
  combine: values => values[0] ?? null
});

/** Ordinary documents retain their synchronous parser. A budgeted editor owns
 * one background outer parser; CodeMirror still owns text, selection and history. */
export const backgroundMarkdownParser: { wrap: ParseWrapper } = { wrap(inner, input, fragments, ranges) {
  const context = ParseContext.get(), backend = context?.state.facet(runtime);
  if (!context || !backend || !usesLargeDocumentDerivedWorkBudget(context.state)) return inner;
  if (input.length !== context.state.doc.length || ranges.length !== 1 || ranges[0]!.from !== 0 || ranges[0]!.to !== input.length) return inner;
  if (backend.error) return ParseContext.getSkippingParser().startParse(input, fragments, ranges);
  const result = backend.read(context.state.doc);
  if (!result.tree || !backend.canPublish(context.state.doc)) return ParseContext.getSkippingParser(result.ready).startParse(input, fragments, ranges);
  const tree = result.tree;
  let stoppedAt: number | null = null;
  return { get parsedPos() { return tree.length; }, get stoppedAt() { return stoppedAt; },
    stopAt(position) { stoppedAt = stoppedAt === null ? position : Math.min(stoppedAt, position); }, advance: () => tree };
} };

export function backgroundMarkdownStructureExtensions(uri: string | undefined, nodeSet: NodeSet): Extension {
  if (!uri) return [];
  const backend = createBackgroundMarkdownStructure(uri, nodeSet);
  return [runtime.of(backend), liveInputDerivedWorkReadiness.of(state => !!backend.error
    || !usesLargeDocumentDerivedWorkBudget(state) || isCompleteMarkdownStructure(syntaxTree(state), state.doc.length)), ViewPlugin.define(view => {
    backend.attach(view.state.doc);
    if (usesLargeDocumentDerivedWorkBudget(view.state)) backend.read(view.state.doc);
    return {
      update(update) {
        if (update.docChanged) backend.observe(update.startState.doc, update.state.doc, update.changes);
        if (!backend.error && usesLargeDocumentDerivedWorkBudget(update.state)) backend.read(update.state.doc);
      },
      destroy() { backend.dispose(); }
    };
  })];
}

export function assertBackgroundMarkdownPreparation(state: EditorState): void {
  const error = state.facet(runtime)?.error;
  if (error) throw error;
}

/** Waiting for another thread must not repeatedly start placeholder parses and
 * attach the same pending promise to CodeMirror's parse scheduler. */
export function isBackgroundMarkdownPreparationPending(state: EditorState): boolean {
  const backend = state.facet(runtime);
  return !!backend && usesLargeDocumentDerivedWorkBudget(state) && !backend.read(state.doc).tree;
}

export function markdownMixedFragments(state: EditorState, fallback: readonly TreeFragment[]): readonly TreeFragment[] {
  return state.facet(runtime)?.mixed(state.doc, fallback) ?? fallback;
}

export function rememberMarkdownMixedTree(state: EditorState, tree: Tree, partial: boolean): void {
  state.facet(runtime)?.remember(state.doc, tree, partial);
}
