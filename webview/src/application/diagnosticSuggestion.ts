export type DiagnosticSuggestion = {
  readonly from: number;
  readonly to: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
};

export type DiagnosticSuggestionAnchor = {
  readonly x: number;
  readonly y: number;
  readonly bottomY: number;
};

export type DiagnosticSuggestionState = {
  readonly lifecycle: 'active' | 'disposed';
  readonly diagnostics: readonly string[];
  readonly lastClickKey: string | null;
  readonly pending: {
    readonly correlationId: number;
    readonly diagnosticKey: string;
  } | null;
  readonly presentedDiagnosticKey: string | null;
};

export type DiagnosticSuggestionInput =
  | { readonly type: 'diagnosticsChanged'; readonly diagnostics: readonly DiagnosticSuggestion[] }
  | {
      readonly type: 'diagnosticClicked';
      readonly diagnostic: DiagnosticSuggestion;
      readonly anchor: DiagnosticSuggestionAnchor;
      readonly nativeSecondClick: boolean;
    }
  | {
      readonly type: 'suggestionsRequested';
      readonly diagnostic: DiagnosticSuggestion;
      readonly anchor: DiagnosticSuggestionAnchor;
    }
  | {
      readonly type: 'suggestionsResolved';
      readonly correlationId: number;
      readonly diagnostic: DiagnosticSuggestion;
      readonly suggestions: readonly string[];
    }
  | { readonly type: 'suggestionsFailed'; readonly correlationId: number }
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
      readonly anchor: DiagnosticSuggestionAnchor;
    }
  | {
      readonly type: 'presentSuggestions';
      readonly from: number;
      readonly to: number;
      readonly anchor: DiagnosticSuggestionAnchor;
      readonly suggestions: readonly { readonly from: number; readonly to: number; readonly text: string }[];
    };

export type DiagnosticSuggestionApplication = {
  getState(): DiagnosticSuggestionState;
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

const diagnosticKey = (diagnostic: DiagnosticSuggestion): string => [
  diagnostic.from,
  diagnostic.to,
  diagnostic.message,
  diagnostic.source ?? '',
  diagnostic.code ?? ''
].join('\u001f');

/**
 * Owns suggestion interaction intent and correlation only. Diagnostic
 * computation, request transport, editor decorations and menu DOM remain in
 * concrete adapters.
 */
export function createDiagnosticSuggestionApplication(): DiagnosticSuggestionApplication {
  let lifecycle: DiagnosticSuggestionState['lifecycle'] = 'active';
  let diagnostics: readonly DiagnosticSuggestion[] = [];
  let lastClickKey: string | null = null;
  let requestSequence = 0;
  let presentedDiagnosticKey: string | null = null;
  let pending: {
    readonly correlationId: number;
    readonly diagnosticKey: string;
    readonly anchor: DiagnosticSuggestionAnchor;
  } | null = null;

  const getState = (): DiagnosticSuggestionState => ({
    lifecycle,
    diagnostics: diagnostics.map(diagnosticKey),
    lastClickKey,
    pending: pending ? {
      correlationId: pending.correlationId,
      diagnosticKey: pending.diagnosticKey
    } : null,
    presentedDiagnosticKey
  });

  const invalidate = (): readonly DiagnosticSuggestionEffect[] => {
    lastClickKey = null;
    pending = null;
    presentedDiagnosticKey = null;
    return [{ type: 'cancelRequest' }, { type: 'hideSuggestions' }];
  };

  const request = (
    diagnostic: DiagnosticSuggestion,
    anchor: DiagnosticSuggestionAnchor
  ): readonly DiagnosticSuggestionEffect[] => {
    const key = diagnosticKey(diagnostic);
    if (!diagnostics.some((current) => diagnosticKey(current) === key)) return [];
    if (pending?.diagnosticKey === key || presentedDiagnosticKey === key) return [];

    const effects: DiagnosticSuggestionEffect[] = [];
    if (pending) effects.push({ type: 'cancelRequest' });
    const correlationId = ++requestSequence;
    pending = { correlationId, diagnosticKey: key, anchor };
    effects.push({ type: 'requestSuggestions', correlationId, diagnostic, anchor });
    return effects;
  };

  const dispatch = (input: DiagnosticSuggestionInput): readonly DiagnosticSuggestionEffect[] => {
    if (lifecycle === 'disposed') return [];

    switch (input.type) {
      case 'diagnosticsChanged':
        diagnostics = [...input.diagnostics];
        return invalidate();

      case 'diagnosticClicked': {
        const key = diagnosticKey(input.diagnostic);
        if (!diagnostics.some((diagnostic) => diagnosticKey(diagnostic) === key)) return [];
        const isSecondClick = input.nativeSecondClick || lastClickKey === key;
        lastClickKey = key;
        return isSecondClick ? request(input.diagnostic, input.anchor) : [];
      }

      case 'suggestionsRequested':
        return request(input.diagnostic, input.anchor);

      case 'suggestionsResolved': {
        const key = diagnosticKey(input.diagnostic);
        if (
          pending?.correlationId !== input.correlationId
          || pending.diagnosticKey !== key
          || !diagnostics.some((diagnostic) => diagnosticKey(diagnostic) === key)
        ) return [];

        const anchor = pending.anchor;
        pending = null;
        if (input.suggestions.length === 0) return [];
        presentedDiagnosticKey = key;
        return [{
          type: 'presentSuggestions',
          from: input.diagnostic.from,
          to: input.diagnostic.to,
          anchor,
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

      case 'presentationChanged':
      case 'externalDocumentPresented':
        return invalidate();

      case 'dispose': {
        lifecycle = 'disposed';
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

  return { getState, resolveDiagnostic, dispatch };
}
