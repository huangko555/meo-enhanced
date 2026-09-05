import { applyLiveBlockIndent, type LiveBlockIndentValue } from './blockIndent';

export type RenderedBlockPreviewKind = 'mermaid' | 'math';

export const renderedBlockPreviewStartLine = Symbol('meoRenderedBlockPreviewStartLine');

export function getRenderedBlockPreviewStartLine(widget: unknown): number | null {
  if (typeof widget !== 'object' || widget === null) return null;
  const startLine = (widget as { [renderedBlockPreviewStartLine]?: unknown })[
    renderedBlockPreviewStartLine
  ];
  return Number.isInteger(startLine) && (startLine as number) > 0
    ? startLine as number
    : null;
}

export function createRenderedBlockPreviewShell(options: {
  kind: RenderedBlockPreviewKind;
  language: 'mermaid' | 'latex';
  startLine: number;
  endLine: number;
  indentColumns: LiveBlockIndentValue;
  toolbar: HTMLElement;
  content: HTMLElement;
}): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'meo-rendered-block-preview';
  shell.dataset.meoRenderedBlockKind = options.kind;
  shell.dataset.meoRenderedBlockStartLine = String(options.startLine);
  shell.dataset.meoRenderedBlockEndLine = String(options.endLine);
  applyLiveBlockIndent(shell, options.indentColumns);

  const language = document.createElement('span');
  language.className = 'meo-code-block-pill meo-rendered-block-preview-language';
  language.textContent = options.language;
  language.setAttribute('aria-hidden', 'true');
  const consumeLanguageInteraction = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  language.addEventListener('pointerdown', consumeLanguageInteraction);
  language.addEventListener('click', consumeLanguageInteraction);
  language.addEventListener('dblclick', consumeLanguageInteraction);

  shell.append(language, options.toolbar, options.content);
  return shell;
}
