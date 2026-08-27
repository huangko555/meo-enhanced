export type RenderedBlockMode = 'source' | 'split' | 'preview';
export type RenderedBlockKind = 'mermaid' | 'latex';

export type RenderedBlockModeShellDecision = {
  readonly effectiveMode: RenderedBlockMode;
  readonly modeClass: 'is-preview' | 'is-split' | 'is-source';
  readonly nextManualMode: RenderedBlockMode;
  readonly controlsLabel: string;
  readonly editorLabel: string;
  readonly modeButton: {
    readonly action: 'edit' | 'source' | 'preview';
    readonly label: string;
  };
  readonly wideLayout: 'presentation-only' | 'side-by-side' | 'source-only';
  readonly previewLifecycle: 'presented' | 'deferred' | 'destroyed';
};

type RenderedBlockModeShellInput = {
  readonly kind: RenderedBlockKind;
  readonly lineNumber: number;
  readonly manualMode: RenderedBlockMode;
  readonly temporaryReveal: boolean;
  readonly uiLanguage?: UiLanguage;
};

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
  const strings = getUiStrings(input.uiLanguage ?? 'en');
  const copy = input.kind === 'mermaid'
    ? {
        controls: strings.mermaidBlockControls,
        editor: strings.mermaidEditor,
        split: strings.editMermaidSplit,
        source: strings.showMermaidSource,
        preview: strings.showMermaidPreview
      }
    : {
        controls: strings.formulaBlockControls,
        editor: strings.formulaEditor,
        split: strings.editFormulaSplit,
        source: strings.showFormulaSource,
        preview: strings.showFormulaPreview
      };
  const modeButton = nextManualMode === 'split'
    ? { action: 'edit' as const, label: copy.split }
    : nextManualMode === 'source'
      ? { action: 'source' as const, label: copy.source }
      : { action: 'preview' as const, label: copy.preview };

  return {
    effectiveMode,
    modeClass: effectiveMode === 'preview'
      ? 'is-preview'
      : effectiveMode === 'split'
        ? 'is-split'
        : 'is-source',
    nextManualMode,
    controlsLabel: copy.controls(input.lineNumber),
    editorLabel: copy.editor(input.lineNumber),
    modeButton,
    wideLayout: effectiveMode === 'split'
      ? 'side-by-side'
      : effectiveMode === 'source'
        ? 'source-only'
        : 'presentation-only',
    previewLifecycle: effectiveMode === 'preview'
      ? 'presented'
      : effectiveMode === 'split'
        ? 'deferred'
        : 'destroyed'
  };
}
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
