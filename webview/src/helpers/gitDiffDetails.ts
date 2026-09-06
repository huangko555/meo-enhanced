import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  gutterLineClass,
  gutterWidgetClass,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import { Minus, Plus, createElement as createIconElement } from 'lucide';
import { getGitDiffOriginalBlocks, gitDiffLineFlagsField, setGitBaselineEffect } from './gitDiffGutter';

const setGitDiffDetailsVisibleEffect = StateEffect.define<boolean>();
let gitDiffDetailsVisible = false;

class GitDiffOriginalLineWidget extends WidgetType {
  constructor(readonly line: { readonly number: number; readonly text: string }) {
    super();
  }

  eq(other: GitDiffOriginalLineWidget): boolean {
    return other.line.number === this.line.number && other.line.text === this.line.text;
  }

  toDOM(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'meo-git-diff-original-block meo-git-diff-original-line';
    row.setAttribute('contenteditable', 'false');
    const content = document.createElement('span');
    content.className = 'meo-git-diff-original-content';
    content.textContent = this.line.text;
    row.append(content);
    return row;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class GitDiffOriginalLineNumberMarker extends GutterMarker {
  constructor(private readonly lineNumber: number) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof GitDiffOriginalLineNumberMarker && other.lineNumber === this.lineNumber;
  }

  toDOM(): Node {
    const number = document.createElement('span');
    number.className = 'meo-git-diff-original-line-number';
    number.textContent = String(this.lineNumber);
    return number;
  }
}

class GitDiffGutterRowMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(kind: 'current' | 'original') {
    super();
    this.elementClass = `meo-git-diff-${kind}-gutter-row`;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof GitDiffGutterRowMarker && other.elementClass === this.elementClass;
  }
}

class GitDiffSignGutterMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(private readonly kind: 'current' | 'original') {
    super();
    this.elementClass = `meo-git-diff-sign-gutter-cell is-${kind}`;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof GitDiffSignGutterMarker && other.kind === this.kind;
  }

  toDOM(): Node {
    const sign = document.createElement('span');
    sign.className = `meo-git-diff-sign is-${this.kind}`;
    sign.setAttribute('aria-hidden', 'true');
    sign.appendChild(createIconElement(this.kind === 'current' ? Plus : Minus, {
      class: `lucide lucide-${this.kind === 'current' ? 'plus' : 'minus'}`,
      width: 13,
      height: 13,
      'stroke-width': 2.25
    }));
    return sign;
  }
}

class GitDiffSignGutterSpacer extends GutterMarker {
  toDOM(): Node {
    const spacer = document.createElement('span');
    spacer.className = 'meo-git-diff-sign-gutter-spacer';
    return spacer;
  }
}

const currentGutterRowMarker = new GitDiffGutterRowMarker('current');
const originalGutterRowMarker = new GitDiffGutterRowMarker('original');
const currentSignGutterMarker = new GitDiffSignGutterMarker('current');
const originalSignGutterMarker = new GitDiffSignGutterMarker('original');
const signGutterSpacer = new GitDiffSignGutterSpacer();

const gitDiffOriginalLineNumberMarker = lineNumberWidgetMarker.of((_view, widget) => (
  widget instanceof GitDiffOriginalLineWidget
    ? new GitDiffOriginalLineNumberMarker(widget.line.number)
    : null
));

const gitDiffOriginalGutterRowClass = gutterWidgetClass.of((_view, widget) => (
  widget instanceof GitDiffOriginalLineWidget ? originalGutterRowMarker : null
));

function buildGitDiffDetails(state: EditorState, visible: boolean): Pick<
  GitDiffDetailsState,
  'decorations' | 'currentGutterRows' | 'currentSignMarkers'
> {
  if (!visible) {
    return {
      decorations: Decoration.none,
      currentGutterRows: RangeSet.empty,
      currentSignMarkers: RangeSet.empty
    };
  }
  const ranges: Range<Decoration>[] = getGitDiffOriginalBlocks(state).flatMap((block) => block.lines.map((line, index) => (
    Decoration.widget({
      widget: new GitDiffOriginalLineWidget(line),
      block: true,
      side: block.side < 0 ? -1_000 + index : 1 + index
    }).range(block.at)
  )));
  const gutterRows: Range<GutterMarker>[] = [];
  const signMarkers: Range<GutterMarker>[] = [];
  const lineFlags = state.field(gitDiffLineFlagsField, false);
  if (Array.isArray(lineFlags)) {
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const flags = lineFlags[lineNumber - 1];
      if (!flags?.added && !flags?.modified) continue;
      const line = state.doc.line(lineNumber);
      ranges.push(Decoration.line({ class: 'meo-git-diff-current-line' }).range(line.from));
      gutterRows.push(currentGutterRowMarker.range(line.from));
      signMarkers.push(currentSignGutterMarker.range(line.from));
    }
  }
  return {
    decorations: Decoration.set(ranges, true),
    currentGutterRows: RangeSet.of(gutterRows, true),
    currentSignMarkers: RangeSet.of(signMarkers, true)
  };
}

type GitDiffDetailsState = {
  readonly decorations: DecorationSet;
  readonly currentGutterRows: RangeSet<GutterMarker>;
  readonly currentSignMarkers: RangeSet<GutterMarker>;
  readonly visible: boolean;
};

const gitDiffDetailsField = StateField.define<GitDiffDetailsState>({
  create(state): GitDiffDetailsState {
    const details = buildGitDiffDetails(state, gitDiffDetailsVisible);
    return {
      ...details,
      visible: gitDiffDetailsVisible
    };
  },
  update(details: GitDiffDetailsState, transaction: Transaction): GitDiffDetailsState {
    let baselineChanged = false;
    let visibilityChanged = false;
    let visible = details.visible;
    for (const effect of transaction.effects) {
      if (effect.is(setGitBaselineEffect)) baselineChanged = true;
      if (effect.is(setGitDiffDetailsVisibleEffect)) {
        gitDiffDetailsVisible = effect.value;
        visible = effect.value;
        visibilityChanged = true;
      }
    }
    if (!transaction.docChanged && !baselineChanged && !visibilityChanged) {
      return details;
    }
    return { ...buildGitDiffDetails(transaction.state, visible), visible };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (details) => details.decorations),
    gutterLineClass.from(field, (details) => details.currentGutterRows),
    EditorView.editorAttributes.from(field, (details): Record<string, string> => (
      details.visible ? { class: 'meo-git-diff-details-visible' } : {}
    ))
  ]
});

const gitDiffSignGutter = gutter({
  class: 'meo-git-diff-sign-gutter',
  renderEmptyElements: true,
  initialSpacer: () => signGutterSpacer,
  markers(view) {
    return view.state.field(gitDiffDetailsField).currentSignMarkers;
  },
  widgetMarker(_view, widget) {
    return widget instanceof GitDiffOriginalLineWidget ? originalSignGutterMarker : null;
  }
});

function resolveEditorView(target: unknown): EditorView | null {
  if (!target || typeof target !== 'object') return null;
  const direct = target as { dispatch?: unknown; state?: unknown };
  if (typeof direct.dispatch === 'function' && direct.state) return direct as EditorView;
  const wrapped = target as { view?: { dispatch?: unknown; state?: unknown } };
  return wrapped.view && typeof wrapped.view.dispatch === 'function' && wrapped.view.state
    ? wrapped.view as EditorView
    : null;
}

export function setGitDiffDetailsVisible(target: unknown, visible: boolean): void {
  gitDiffDetailsVisible = visible;
  const view = resolveEditorView(target);
  // Live has no details field; the preference is read when Source mounts it.
  // Dispatching there would only rebuild unrelated Live decorations.
  if (!view || !view.state.field(gitDiffDetailsField, false)) return;
  view.dispatch({ effects: setGitDiffDetailsVisibleEffect.of(visible) });
}

export function gitDiffDetailsExtensions(): Extension[] {
  return [
    gitDiffDetailsField,
    gitDiffOriginalLineNumberMarker,
    gitDiffOriginalGutterRowClass,
    gitDiffSignGutter
  ];
}
