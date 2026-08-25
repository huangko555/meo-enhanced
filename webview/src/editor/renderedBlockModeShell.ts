export type RenderedBlockMode = 'source' | 'split' | 'preview';
export type RenderedBlockKind = 'mermaid' | 'latex';

export type RenderedBlockModeShellDecision = {
  readonly manualMode: RenderedBlockMode;
  readonly effectiveMode: RenderedBlockMode;
  readonly modeClass: 'is-preview' | 'is-split' | 'is-source';
  readonly manualIntent: {
    readonly mode: RenderedBlockMode;
    readonly clearsTemporaryReveal: true;
  };
  readonly controlsLabel: string;
  readonly editorLabel: string;
  readonly modeButton: {
    readonly action: 'edit' | 'source' | 'preview';
    readonly label: string;
  };
  readonly layout: {
    readonly wide: 'presentation-only' | 'side-by-side' | 'source-only';
    readonly narrow: 'presentation-only' | 'stacked' | 'source-only';
  };
  readonly source: 'visible' | 'destroyed';
  readonly preview: 'presented' | 'deferred' | 'destroyed';
};

type RenderedBlockModeShellInput = {
  readonly kind: RenderedBlockKind;
  readonly lineNumber: number;
  readonly manualMode: RenderedBlockMode;
  readonly temporaryReveal: boolean;
};

const COPY = {
  mermaid: {
    controls: 'Mermaid block controls',
    editor: 'Mermaid editor',
    split: 'Edit Mermaid in split view',
    source: 'Show Mermaid code only',
    preview: 'Show Mermaid preview'
  },
  latex: {
    controls: 'Formula block controls',
    editor: 'Formula editor',
    split: 'Edit formula in split view',
    source: 'Show formula source only',
    preview: 'Show formula preview'
  }
} as const;

function nextMode(mode: RenderedBlockMode): RenderedBlockMode {
  if (mode === 'preview') return 'split';
  if (mode === 'split') return 'source';
  return 'preview';
}

export function decideRenderedBlockModeShell(
  input: RenderedBlockModeShellInput
): RenderedBlockModeShellDecision {
  const effectiveMode = input.manualMode === 'preview' && input.temporaryReveal
    ? 'split'
    : input.manualMode;
  const nextManualMode = nextMode(effectiveMode);
  const copy = COPY[input.kind];
  const modeButton = nextManualMode === 'split'
    ? { action: 'edit' as const, label: copy.split }
    : nextManualMode === 'source'
      ? { action: 'source' as const, label: copy.source }
      : { action: 'preview' as const, label: copy.preview };

  return {
    manualMode: input.manualMode,
    effectiveMode,
    modeClass: effectiveMode === 'preview'
      ? 'is-preview'
      : effectiveMode === 'split'
        ? 'is-split'
        : 'is-source',
    manualIntent: { mode: nextManualMode, clearsTemporaryReveal: true },
    controlsLabel: `${copy.controls} at line ${input.lineNumber}`,
    editorLabel: `${copy.editor} at line ${input.lineNumber}`,
    modeButton,
    layout: effectiveMode === 'split'
      ? { wide: 'side-by-side', narrow: 'stacked' }
      : effectiveMode === 'source'
        ? { wide: 'source-only', narrow: 'source-only' }
        : { wide: 'presentation-only', narrow: 'presentation-only' },
    source: effectiveMode === 'preview' ? 'destroyed' : 'visible',
    preview: effectiveMode === 'preview'
      ? 'presented'
      : effectiveMode === 'split'
        ? 'deferred'
        : 'destroyed'
  };
}
