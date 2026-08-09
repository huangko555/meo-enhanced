import type { EditorView } from '@codemirror/view';
import type { DiagnosticSuggestionsResult, RequestDiagnosticSuggestions } from '../../../src/protocol/diagnosticSuggestions';
import type {
  DiagnosticSuggestion,
  DiagnosticSuggestionEffect,
  DiagnosticSuggestionEffectExecution,
  DiagnosticSuggestionEffectExecutor,
  DiagnosticSuggestionInput
} from '../application/diagnosticSuggestion';
import {
  createDiagnosticSuggestionsTransport,
  type DiagnosticSuggestionsTransportOptions
} from '../adapters/diagnosticSuggestionsTransport';

export type DiagnosticSuggestionPointerKind = 'click' | 'request';

type DiagnosticSuggestionAnchor = {
  readonly x: number;
  readonly y: number;
  readonly bottomY: number;
};

type DiagnosticSuggestionPresentation = Extract<DiagnosticSuggestionEffect, { readonly type: 'presentSuggestions' }> & {
  readonly anchor: DiagnosticSuggestionAnchor;
};

export type CodeMirrorDiagnosticSuggestionAdapter = DiagnosticSuggestionEffectExecutor & {
  inputFromPointer(
    kind: DiagnosticSuggestionPointerKind,
    event: MouseEvent | PointerEvent
  ): DiagnosticSuggestionInput | null;
  inputFromSelectionRequest(
    diagnostic: DiagnosticSuggestion,
    resolveAnchor: () => DiagnosticSuggestionAnchor | null
  ): Extract<DiagnosticSuggestionInput, { readonly type: 'suggestionsRequested' }>;
  accept(response: DiagnosticSuggestionsResult): boolean;
};

export type CodeMirrorDiagnosticSuggestionAdapterOptions = {
  readonly view: EditorView;
  readonly resolveDiagnostic: (
    position: number,
    selectedRange: { readonly from: number; readonly to: number } | null
  ) => DiagnosticSuggestion | null;
  readonly postMessage: (message: RequestDiagnosticSuggestions) => void;
  readonly presentSuggestions: (
    effect: DiagnosticSuggestionPresentation
  ) => void;
  readonly hideSuggestions: () => void;
  readonly transportOptions?: DiagnosticSuggestionsTransportOptions;
};

type ActiveRequest = {
  requestId: string | null;
  readonly correlationId: number;
  readonly anchorId: number;
  readonly diagnostic: DiagnosticSuggestion;
  readonly resolveAnchor: () => DiagnosticSuggestionAnchor | null;
  readonly settle: (input: DiagnosticSuggestionInput | null) => void;
};

/** Connects CodeMirror/DOM/menu capabilities to the Application-owned effect Port. */
export function createCodeMirrorDiagnosticSuggestionAdapter(
  options: CodeMirrorDiagnosticSuggestionAdapterOptions
): CodeMirrorDiagnosticSuggestionAdapter {
  let activeRequest: ActiveRequest | null = null;
  let nextAnchor: {
    readonly anchorId: number;
    readonly resolve: () => DiagnosticSuggestionAnchor | null;
  } | null = null;
  const resolvedAnchors = new Map<number, () => DiagnosticSuggestionAnchor | null>();
  let anchorSequence = 0;
  let disposed = false;

  const settleActive = (input: DiagnosticSuggestionInput | null): void => {
    const active = activeRequest;
    if (!active) return;
    activeRequest = null;
    active.settle(input);
  };

  const transport = createDiagnosticSuggestionsTransport(
    options.postMessage,
    (response) => {
      const active = activeRequest;
      if (!active || (active.requestId !== null && active.requestId !== response.requestId)) return;
      if (response.result.ok === false) {
        settleActive({ type: 'suggestionsFailed', correlationId: active.correlationId });
        return;
      }
      resolvedAnchors.set(active.anchorId, active.resolveAnchor);
      settleActive({
        type: 'suggestionsResolved',
        correlationId: active.correlationId,
        diagnostic: active.diagnostic,
        suggestions: response.result.value.suggestions
      });
    },
    options.transportOptions
  );

  const cancelActive = (): void => {
    transport.cancelAll();
    settleActive(null);
    resolvedAnchors.clear();
  };

  const anchorFromView = (diagnostic: DiagnosticSuggestion): DiagnosticSuggestionAnchor | null => {
    const fromCoords = options.view.coordsAtPos(diagnostic.from);
    if (!fromCoords) return null;
    const charCoords = options.view.coordsForChar(diagnostic.from);
    return {
      x: charCoords?.left ?? fromCoords.left,
      y: charCoords ? Math.min(fromCoords.top, charCoords.top) : fromCoords.top,
      bottomY: charCoords ? Math.max(fromCoords.bottom, charCoords.bottom) : fromCoords.bottom
    };
  };

  const execute = (effect: DiagnosticSuggestionEffect): DiagnosticSuggestionEffectExecution => {
    if (disposed) return {};
    switch (effect.type) {
      case 'cancelRequest':
        cancelActive();
        return {};
      case 'hideSuggestions':
        options.hideSuggestions();
        return {};
      case 'presentSuggestions':
        {
          const resolveAnchor = resolvedAnchors.get(effect.anchorId);
          resolvedAnchors.delete(effect.anchorId);
          const anchor = resolveAnchor?.() ?? anchorFromView({
            from: effect.from,
            to: effect.to,
            message: ''
          });
          if (anchor) {
            options.presentSuggestions({ ...effect, anchor });
            return { completion: Promise.resolve({
              type: 'suggestionsPresented',
              correlationId: effect.correlationId,
              diagnostic: effect.diagnostic
            }) };
          }
          return { completion: Promise.resolve({
            type: 'suggestionsPresentationFailed',
            correlationId: effect.correlationId
          }) };
        }
      case 'requestSuggestions': {
        const resolveAnchor = nextAnchor?.anchorId === effect.anchorId
          ? nextAnchor.resolve
          : () => anchorFromView(effect.diagnostic);
        cancelActive();
        nextAnchor = null;
        let settle!: (input: DiagnosticSuggestionInput | null) => void;
        const completion = new Promise<DiagnosticSuggestionInput | null>((resolve) => {
          settle = resolve;
        });
        const active: ActiveRequest = {
          requestId: null,
          correlationId: effect.correlationId,
          anchorId: effect.anchorId,
          diagnostic: effect.diagnostic,
          resolveAnchor,
          settle
        };
        activeRequest = active;
        const requestId = transport.request({
          from: effect.diagnostic.from,
          to: effect.diagnostic.to,
          message: effect.diagnostic.message,
          source: effect.diagnostic.source,
          code: effect.diagnostic.code
        });
        if (activeRequest === active) active.requestId = requestId;
        return { completion };
      }
    }
  };

  const inputFromPointer = (
    kind: DiagnosticSuggestionPointerKind,
    event: MouseEvent | PointerEvent
  ): DiagnosticSuggestionInput | null => {
    if (disposed) return null;
    const position = options.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return null;
    const selection = options.view.state.selection.main;
    const selectedRange = selection.empty
      ? null
      : { from: Math.min(selection.from, selection.to), to: Math.max(selection.from, selection.to) };
    const diagnostic = options.resolveDiagnostic(position, selectedRange);
    if (!diagnostic) return null;

    const target = event.target instanceof Element ? event.target : null;
    const selectedDiagnostic = selectedRange?.from === diagnostic.from && selectedRange.to === diagnostic.to;
    if (!target?.closest('.meo-diagnostic') && !selectedDiagnostic) return null;

    const anchorId = ++anchorSequence;
    nextAnchor = { anchorId, resolve: () => anchorFromView(diagnostic) };
    if (kind === 'request') return { type: 'suggestionsRequested', diagnostic, anchorId };
    return {
      type: 'diagnosticClicked',
      diagnostic,
      anchorId,
      nativeSecondClick: event.detail >= 2 && selectedDiagnostic
    };
  };

  return {
    execute,
    inputFromPointer,
    inputFromSelectionRequest(diagnostic, resolveAnchor) {
      const anchorId = ++anchorSequence;
      nextAnchor = { anchorId, resolve: resolveAnchor };
      return { type: 'suggestionsRequested', diagnostic, anchorId };
    },
    accept(response) {
      return !disposed && transport.accept(response);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelActive();
      nextAnchor = null;
    }
  };
}
