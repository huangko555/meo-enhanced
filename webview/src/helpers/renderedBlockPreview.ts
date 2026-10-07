import type { Range } from '@codemirror/state';
import type { Decoration, DecorationSet } from '@codemirror/view';
import { applyLiveBlockIndent, type LiveBlockIndentValue } from './blockIndent';

export type RenderedBlockPreviewKind = 'mermaid' | 'math';

export const renderedBlockPreviewHeight = Symbol('meoRenderedBlockPreviewHeight');
const previewHeightObservers = new WeakMap<HTMLElement, ResizeObserver>();

/** Full preview geometry belongs to its editor, including chrome and loaded fonts. */
export class RenderedBlockPreviewHeight {
  private measurement = { height: -1 };

  constructor(private readonly identity: string) {}

  get height(): number {
    return this.measurement.height;
  }

  seed(previous: RenderedBlockPreviewHeight): void {
    if (this.identity === previous.identity) this.measurement = previous.measurement;
  }

  observe(shell: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    const measurement = this.measurement;
    const observer = new ResizeObserver(() => {
      const height = shell.getBoundingClientRect().height;
      if (height > 0) measurement.height = height;
    });
    observer.observe(shell);
    previewHeightObservers.set(shell, observer);
  }

  destroy(shell: HTMLElement): void {
    previewHeightObservers.get(shell)?.disconnect();
    previewHeightObservers.delete(shell);
  }
}

/**
 * Seed before CodeMirror rebuilds its height map. DOM measurement in a later
 * frame is too late: the gutter has already painted the provisional estimate.
 */
export function preserveRenderedBlockPreviewHeights(
  ranges: readonly Range<Decoration>[],
  previous: DecorationSet | undefined
): void {
  if (!previous) return;
  for (const range of ranges) {
    const height = range.value.spec.widget?.[renderedBlockPreviewHeight];
    if (!(height instanceof RenderedBlockPreviewHeight)) continue;
    previous.between(range.from, range.to, (from, to, decoration) => {
      const oldHeight = decoration.spec.widget?.[renderedBlockPreviewHeight];
      if (from === range.from && to === range.to && oldHeight instanceof RenderedBlockPreviewHeight) {
        height.seed(oldHeight);
      }
    });
  }
}

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
