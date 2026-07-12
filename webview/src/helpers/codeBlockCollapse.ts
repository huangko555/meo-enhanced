import { StateEffect, StateField, Transaction, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { createElement, ChevronDown, ChevronUp } from 'lucide';
import { getFencedCodeInfo } from './codeBlocks';
import { resolvedSyntaxTree } from './markdownSyntax';

export const codeBlockPreviewLineCount = 12;

const excludedCodeBlockLanguages = new Set([
  'asciimath',
  'katex',
  'latex',
  'math',
  'mermaid',
  'tex'
]);

export interface CodeBlockCollapseSection {
  anchor: number;
  collapseFrom: number;
  collapseTo: number;
  contentLineCount: number;
  hiddenLineCount: number;
  previewEnd: number;
}

interface CodeBlockSearchTarget {
  from: number;
  to: number;
}

const toggleCodeBlockCollapseEffect = StateEffect.define<number>();
export const setCodeBlockSearchTargetEffect = StateEffect.define<CodeBlockSearchTarget | null>();
const emptyExpandedCodeBlocks = Object.freeze(new Set<number>());

function getSectionsByAnchor(state: EditorState): Map<number, CodeBlockCollapseSection> {
  return new Map(getCodeBlockCollapseSections(state).map((section) => [section.anchor, section]));
}

function mapExpandedCodeBlockAnchors(
  expanded: ReadonlySet<number>,
  transaction: Transaction
): Set<number> {
  if (!expanded.size || !transaction.docChanged) {
    return new Set(expanded);
  }

  const mapped = new Set<number>();
  for (const anchor of expanded) {
    mapped.add(transaction.changes.mapPos(anchor, 1));
  }
  return mapped;
}

function expandedCodeBlocksEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left === right || left.size !== right.size) {
    return left === right;
  }
  for (const anchor of left) {
    if (!right.has(anchor)) {
      return false;
    }
  }
  return true;
}

const codeBlockCollapseStateField = StateField.define<ReadonlySet<number>>({
  create(): ReadonlySet<number> {
    return emptyExpandedCodeBlocks;
  },
  update(expanded, transaction): ReadonlySet<number> {
    const hasToggle = transaction.effects.some((effect) => effect.is(toggleCodeBlockCollapseEffect));
    if (!transaction.docChanged && !hasToggle) {
      return expanded;
    }

    const next = mapExpandedCodeBlockAnchors(expanded, transaction);
    const sections = getSectionsByAnchor(transaction.state);
    for (const effect of transaction.effects) {
      if (!effect.is(toggleCodeBlockCollapseEffect)) {
        continue;
      }
      if (next.has(effect.value)) {
        next.delete(effect.value);
      } else if (sections.has(effect.value)) {
        next.add(effect.value);
      }
    }

    for (const anchor of next) {
      if (!sections.has(anchor)) {
        next.delete(anchor);
      }
    }
    if (!next.size) {
      return emptyExpandedCodeBlocks;
    }
    return expandedCodeBlocksEqual(expanded, next) ? expanded : next;
  }
});

const codeBlockSearchTargetField = StateField.define<CodeBlockSearchTarget | null>({
  create(): CodeBlockSearchTarget | null {
    return null;
  },
  update(target, transaction): CodeBlockSearchTarget | null {
    let next = target;
    if (next !== null && transaction.docChanged) {
      next = {
        from: transaction.changes.mapPos(next.from, 1),
        to: transaction.changes.mapPos(next.to, -1)
      };
    }
    for (const effect of transaction.effects) {
      if (effect.is(setCodeBlockSearchTargetEffect)) {
        return effect.value;
      }
    }
    if (next !== null && transaction.selection) {
      const selection = transaction.state.selection.main;
      const from = Math.min(selection.from, selection.to);
      const to = Math.max(selection.from, selection.to);
      if (selection.empty ? from < next.from || from >= next.to : from >= next.to || to <= next.from) {
        return null;
      }
    }
    return next;
  }
});

function isExcludedCodeBlockLanguage(codeInfo: string): boolean {
  const language = codeInfo.split(/[\t ]+/, 1)[0]?.toLowerCase() ?? '';
  return excludedCodeBlockLanguages.has(language);
}

function searchTargetTouchesHiddenCode(state: EditorState, section: CodeBlockCollapseSection): boolean {
  const target = state.field(codeBlockSearchTargetField, false);
  return target !== null && target.from < section.collapseTo && target.to > section.collapseFrom;
}

export function getCodeBlockCollapseSections(state: EditorState): CodeBlockCollapseSection[] {
  const sections: CodeBlockCollapseSection[] = [];
  const tree = resolvedSyntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name !== 'FencedCode') {
        return;
      }
      const codeInfo = getFencedCodeInfo(state, node);
      if (!codeInfo || isExcludedCodeBlockLanguage(codeInfo)) {
        return false;
      }

      const openingLine = state.doc.lineAt(node.from);
      const closingLine = state.doc.lineAt(Math.max(node.to - 1, node.from));
      const contentLineCount = Math.max(0, closingLine.number - openingLine.number - 1);
      if (contentLineCount <= codeBlockPreviewLineCount) {
        return false;
      }

      const previewEndLine = state.doc.line(openingLine.number + codeBlockPreviewLineCount);
      const firstHiddenLine = state.doc.line(previewEndLine.number + 1);
      sections.push({
        anchor: openingLine.from,
        collapseFrom: firstHiddenLine.from,
        collapseTo: closingLine.to,
        contentLineCount,
        hiddenLineCount: contentLineCount - codeBlockPreviewLineCount,
        previewEnd: previewEndLine.to
      });
      return false;
    }
  });

  return sections;
}

function getExpandedCodeBlockAnchors(state: EditorState): ReadonlySet<number> {
  return state.field(codeBlockCollapseStateField, false) ?? emptyExpandedCodeBlocks;
}

export function isCodeBlockCollapsed(state: EditorState, section: CodeBlockCollapseSection): boolean {
  return !getExpandedCodeBlockAnchors(state).has(section.anchor)
    && !searchTargetTouchesHiddenCode(state, section);
}

export function selectionRequiresCodeBlockExpansion(state: EditorState): boolean {
  return getCodeBlockCollapseSections(state).some((section) => searchTargetTouchesHiddenCode(state, section));
}

function preserveViewportAnchor(view: EditorView, position: number): void {
  const anchor = Math.max(0, Math.min(position, view.state.doc.length));
  const offset = view.lineBlockAt(anchor).top - view.scrollDOM.scrollTop;
  view.requestMeasure({
    read(editorView) {
      return editorView.lineBlockAt(anchor).top - offset;
    },
    write(scrollTop, editorView) {
      editorView.scrollDOM.scrollTop = Math.max(0, scrollTop);
    }
  });
}

export function toggleCodeBlockCollapse(view: EditorView, anchor: number): boolean {
  const section = getSectionsByAnchor(view.state).get(anchor);
  if (!section) {
    return false;
  }

  const viewportAnchor = view.viewport.from;
  const stablePosition = searchTargetTouchesHiddenCode(view.state, section)
    ? section.anchor
    : viewportAnchor;
  view.dispatch({
    effects: toggleCodeBlockCollapseEffect.of(anchor),
    annotations: Transaction.addToHistory.of(false)
  });
  preserveViewportAnchor(view, stablePosition);
  view.focus();
  return true;
}

function createCodeBlockCollapseControl(
  anchor: number,
  collapsed: boolean,
  hiddenLineCount: number,
  floating = false,
  editorView: EditorView | null = null
): HTMLElement {
  const footer = document.createElement('div');
  footer.className = floating
    ? 'meo-code-block-collapse-floating'
    : `meo-code-block-collapse-footer${collapsed ? ' is-collapsed' : ''}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-code-block-collapse-button';
  const label = collapsed
    ? `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`
    : 'Collapse code';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createElement(collapsed ? ChevronDown : ChevronUp, {
    width: 14,
    height: 14,
    'aria-hidden': 'true'
  }));
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const view = editorView ?? EditorView.findFromDOM(footer);
    if (view) {
      toggleCodeBlockCollapse(view, anchor);
    }
  });
  footer.appendChild(button);
  return footer;
}

class CodeBlockCollapseWidget extends WidgetType {
  constructor(
    private readonly anchor: number,
    private readonly collapsed: boolean,
    private readonly hiddenLineCount: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodeBlockCollapseWidget
      && other.anchor === this.anchor
      && other.collapsed === this.collapsed
      && other.hiddenLineCount === this.hiddenLineCount;
  }

  toDOM(): HTMLElement {
    return createCodeBlockCollapseControl(this.anchor, this.collapsed, this.hiddenLineCount);
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'pointerover' && event.type !== 'pointerout';
  }
}

class CodeBlockCollapseFloatingControl {
  private readonly host: HTMLElement;
  private displayedAnchor: number | null = null;

  constructor(private readonly view: EditorView) {
    this.host = document.createElement('div');
    this.host.className = 'meo-code-block-collapse-floating-host';
    this.view.dom.appendChild(this.host);
    this.refresh();
  }

  update(): void {
    this.refresh();
  }

  destroy(): void {
    this.host.remove();
  }

  private refresh(): void {
    const viewport = this.view.viewport;
    const section = getCodeBlockCollapseSections(this.view.state).find((candidate) => (
      !isCodeBlockCollapsed(this.view.state, candidate)
      && candidate.anchor < viewport.to
      && candidate.collapseTo > viewport.from
    ));
    const nextAnchor = section?.anchor ?? null;
    if (nextAnchor === this.displayedAnchor) {
      return;
    }
    this.displayedAnchor = nextAnchor;
    this.host.replaceChildren();
    if (section) {
      this.host.appendChild(
        createCodeBlockCollapseControl(section.anchor, false, section.hiddenLineCount, true, this.view)
      );
    }
  }
}

const codeBlockCollapseFloatingControlExtension = ViewPlugin.fromClass(CodeBlockCollapseFloatingControl);

export function codeBlockCollapseViewExtensions(): readonly any[] {
  return [codeBlockCollapseFloatingControlExtension];
}

export function codeBlockCollapseWidget(
  anchor: number,
  collapsed: boolean,
  hiddenLineCount: number
): WidgetType {
  return new CodeBlockCollapseWidget(anchor, collapsed, hiddenLineCount);
}

export function codeBlockCollapseExtensions(): readonly any[] {
  return [codeBlockCollapseStateField, codeBlockSearchTargetField];
}
