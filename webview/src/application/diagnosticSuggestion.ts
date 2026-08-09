export type DiagnosticSuggestion = {
  readonly from: number;
  readonly to: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
};

export type DiagnosticSuggestionInput =
  | { readonly type: 'diagnosticsChanged'; readonly diagnostics: readonly DiagnosticSuggestion[] }
  | {
      readonly type: 'diagnosticClicked';
      readonly diagnostic: DiagnosticSuggestion;
      readonly anchorId: number;
      readonly nativeSecondClick: boolean;
    }
  | {
      readonly type: 'suggestionsRequested';
      readonly diagnostic: DiagnosticSuggestion;
      readonly anchorId: number;
    }
  | {
      readonly type: 'suggestionsResolved';
      readonly correlationId: number;
      readonly diagnostic: DiagnosticSuggestion;
      readonly suggestions: readonly string[];
    }
  | { readonly type: 'suggestionsFailed'; readonly correlationId: number }
  | {
      readonly type: 'suggestionsPresented';
      readonly correlationId: number;
      readonly diagnostic: DiagnosticSuggestion;
    }
  | { readonly type: 'suggestionsPresentationFailed'; readonly correlationId: number }
  | { readonly type: 'presentationChanged' }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type DiagnosticSuggestionEffect =
  | { readonly type: 'cancelRequest' }
  | { readonly type: 'hideSuggestions' }
  | {
      readonly type: 'requestSuggestions';
      readonly correlationId: number;
      readonly diagnostic: DiagnosticSuggestion;
      readonly anchorId: number;
    }
  | {
      readonly type: 'presentSuggestions';
      readonly correlationId: number;
      readonly anchorId: number;
      readonly diagnostic: DiagnosticSuggestion;
      readonly from: number;
      readonly to: number;
      readonly suggestions: readonly { readonly from: number; readonly to: number; readonly text: string }[];
    };

export type DiagnosticSuggestionApplication = {
  isIdle(): boolean;
  resolveDiagnostic(
    position: number,
    selectedRange: { readonly from: number; readonly to: number } | null
  ): DiagnosticSuggestion | null;
  dispatch(input: DiagnosticSuggestionInput): readonly DiagnosticSuggestionEffect[];
};

export type DiagnosticSuggestionEffectExecution = {
  readonly completion?: Promise<DiagnosticSuggestionInput | null>;
};

/** Application-owned Port implemented by the concrete Editor/Webview Adapter. */
export type DiagnosticSuggestionEffectExecutor = {
  execute(effect: DiagnosticSuggestionEffect): DiagnosticSuggestionEffectExecution;
  dispose(): void;
};

const sameDiagnostic = (left: DiagnosticSuggestion, right: DiagnosticSuggestion): boolean => (
  left.from === right.from
  && left.to === right.to
  && left.message === right.message
  && left.source === right.source
  && left.code === right.code
);

/**
 * Owns suggestion interaction intent and correlation only. Diagnostic
 * computation, request transport, editor decorations and menu DOM remain in
 * concrete adapters.
 */
export function createDiagnosticSuggestionApplication(): DiagnosticSuggestionApplication {
  let disposed = false;
  let diagnostics: readonly DiagnosticSuggestion[] = [];
  let lastClick: DiagnosticSuggestion | null = null;
  let requestSequence = 0;
  let presentedDiagnostic: DiagnosticSuggestion | null = null;
  let pending: {
    readonly correlationId: number;
    readonly diagnostic: DiagnosticSuggestion;
    readonly anchorId: number;
  } | null = null;
  let presenting: {
    readonly correlationId: number;
    readonly diagnostic: DiagnosticSuggestion;
  } | null = null;

  const invalidate = (): readonly DiagnosticSuggestionEffect[] => {
    lastClick = null;
    pending = null;
    presenting = null;
    presentedDiagnostic = null;
    return [{ type: 'cancelRequest' }, { type: 'hideSuggestions' }];
  };

  const request = (diagnostic: DiagnosticSuggestion, anchorId: number): readonly DiagnosticSuggestionEffect[] => {
    if (!diagnostics.some((current) => sameDiagnostic(current, diagnostic))) return [];
    if (pending && sameDiagnostic(pending.diagnostic, diagnostic)) return [];
    if (presenting && sameDiagnostic(presenting.diagnostic, diagnostic)) return [];
    if (presentedDiagnostic && sameDiagnostic(presentedDiagnostic, diagnostic)) return [];

    const effects: DiagnosticSuggestionEffect[] = [];
    if (pending) effects.push({ type: 'cancelRequest' });
    const correlationId = ++requestSequence;
    pending = { correlationId, diagnostic, anchorId };
    effects.push({ type: 'requestSuggestions', correlationId, diagnostic, anchorId });
    return effects;
  };

  const dispatch = (input: DiagnosticSuggestionInput): readonly DiagnosticSuggestionEffect[] => {
    if (disposed) return [];

    switch (input.type) {
      case 'diagnosticsChanged':
        diagnostics = [...input.diagnostics];
        return invalidate();

      case 'diagnosticClicked': {
        if (!diagnostics.some((diagnostic) => sameDiagnostic(diagnostic, input.diagnostic))) return [];
        const isSecondClick = input.nativeSecondClick
          || (lastClick !== null && sameDiagnostic(lastClick, input.diagnostic));
        lastClick = input.diagnostic;
        return isSecondClick ? request(input.diagnostic, input.anchorId) : [];
      }

      case 'suggestionsRequested':
        return request(input.diagnostic, input.anchorId);

      case 'suggestionsResolved': {
        if (
          pending?.correlationId !== input.correlationId
          || !sameDiagnostic(pending.diagnostic, input.diagnostic)
          || !diagnostics.some((diagnostic) => sameDiagnostic(diagnostic, input.diagnostic))
        ) return [];

        const anchorId = pending.anchorId;
        pending = null;
        if (input.suggestions.length === 0) return [];
        presenting = { correlationId: input.correlationId, diagnostic: input.diagnostic };
        return [{
          type: 'presentSuggestions',
          correlationId: input.correlationId,
          anchorId,
          diagnostic: input.diagnostic,
          from: input.diagnostic.from,
          to: input.diagnostic.to,
          suggestions: input.suggestions.map((text) => ({
            from: input.diagnostic.from,
            to: input.diagnostic.to,
            text
          }))
        }];
      }

      case 'suggestionsFailed':
        if (pending?.correlationId === input.correlationId) pending = null;
        return [];

      case 'suggestionsPresented':
        if (presenting?.correlationId !== input.correlationId
          || !sameDiagnostic(presenting.diagnostic, input.diagnostic)) return [];
        presenting = null;
        presentedDiagnostic = input.diagnostic;
        return [];

      case 'suggestionsPresentationFailed':
        if (presenting?.correlationId === input.correlationId) presenting = null;
        return [];

      case 'presentationChanged':
      case 'externalDocumentPresented':
        return invalidate();

      case 'dispose': {
        disposed = true;
        diagnostics = [];
        return invalidate();
      }
    }
  };

  const resolveDiagnostic = (
    position: number,
    selectedRange: { readonly from: number; readonly to: number } | null
  ): DiagnosticSuggestion | null => {
    if (selectedRange && selectedRange.from !== selectedRange.to) {
      const selected = diagnostics.find((diagnostic) => (
        diagnostic.from === selectedRange.from && diagnostic.to === selectedRange.to
      ));
      if (selected && position >= selected.from && position <= selected.to) return selected;
    }

    let best: DiagnosticSuggestion | null = null;
    for (const diagnostic of diagnostics) {
      if (position < diagnostic.from || position > diagnostic.to) continue;
      if (!best || diagnostic.to - diagnostic.from < best.to - best.from) best = diagnostic;
    }
    return best;
  };

  return { isIdle: () => disposed || (pending === null && presenting === null), resolveDiagnostic, dispatch };
}
