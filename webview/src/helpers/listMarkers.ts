import { documentLines } from './documentLines';
import { hasMarkdownListPrefix, readMarkdownContainerPrefixes, readMarkdownListPrefix, type MarkdownContainerPrefix, type MarkdownListPrefix } from '../../../src/foundation/markdownListPrefix';
import type { ChangeDesc } from '@codemirror/state';
import { mapLiveWidgetPositions } from '../editor/liveWidgetPositions';
import { sourcePresentationSelection } from '../editor/livePointerSelection';
import { isolateHistory } from '@codemirror/commands';
import { language, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { listHistoryFocusEffect } from '../adapters/codeMirrorListHistoryFocus';
import {
  StateField,
  RangeSetBuilder,
  EditorState,
  Transaction,
  Annotation,
  countColumn,
  type Extension,
  type Line,
  type StateCommand,
  type Text,
  type Range
} from '@codemirror/state';
import { Decoration, WidgetType, EditorView, type DecorationSet } from '@codemirror/view';
import { getUiStrings } from '../application/uiLanguage';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { parseFrontmatter, isInsideFrontmatterContent } from './frontmatter';
import { resolvedSyntaxTreeAt } from './markdownSyntax';
import { isBackgroundMarkdownPreparationPending } from '../editor/backgroundMarkdownStructure';

interface ListMarkerData extends MarkdownListPrefix {
  indentLevel: number;
  indentColumns: number;
  contentOffsetColumns: number;
  displayExtraColumns: number;
  markerText: string;
  classes: string;
  isTask: boolean;
  taskHiddenPrefixColumns: number;
  taskStatus?: TaskStatus;
}

type TaskStatus = 'todo' | 'done';
type OrderedDisplayIndex = string | number | null;

interface ListIndentStyle {
  columns: number;
  insert: string;
}

interface ListMarkerDecorationOptions {
  useSourceStyleLiteral?: boolean;
}

interface ListTextChange {
  from: number;
  to?: number;
  insert: string;
}

interface ListTextDeletion {
  from: number;
  to: number;
  insert: '';
}

const sourceListMarkerDeco = Decoration.mark({ class: 'meo-md-list-prefix' });
const sourceTaskBracketDeco = Decoration.mark({ class: 'meo-md-task-bracket' });
const taskCompleteDeco = Decoration.mark({ class: 'meo-task-complete' });
const TWO_SPACE_INDENT = '  ';
const FOUR_SPACE_INDENT = '    ';
const TAB_INDENT = '\t';
const TWO_SPACE_INDENT_COLUMNS = 2;
const FOUR_SPACE_INDENT_COLUMNS = 4;
const LIST_CODE_PARSE_LIMIT = 32_768;
const orderedListNormalizationIntent = Annotation.define<{
  resetNestedStartsAtLines: readonly number[];
}>();

const listIndentStyle = {
  twoSpaces: {
    columns: TWO_SPACE_INDENT_COLUMNS,
    insert: TWO_SPACE_INDENT
  },
  fourSpaces: {
    columns: FOUR_SPACE_INDENT_COLUMNS,
    insert: FOUR_SPACE_INDENT
  },
  tabs: {
    columns: FOUR_SPACE_INDENT_COLUMNS,
    insert: TAB_INDENT
  }
};

const defaultListIndentStyle = listIndentStyle.twoSpaces;

function forEachSelectionLine(state: EditorState, callback: (line: Line) => void): void {
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toPos = Math.max(range.from, range.to - (range.empty ? 0 : 1));
    const toLine = state.doc.lineAt(toPos).number;
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
      if (seen.has(lineNumber)) {
        continue;
      }
      seen.add(lineNumber);
      callback(state.doc.line(lineNumber));
    }
  }
}

function lineIsInFrontmatterContent(
  frontmatter: ReturnType<typeof parseFrontmatter>,
  line: Line
): boolean {
  return isInsideFrontmatterContent(frontmatter, line.from);
}

function isListLine(lineText: string): boolean {
  return hasMarkdownListPrefix(lineText);
}

function inferListIndentStyle(listLineTexts: readonly string[]): ListIndentStyle {
  const spaceIndents: number[] = [];
  for (const lineText of listLineTexts) {
    if (!isListLine(lineText)) {
      continue;
    }
    const leadingWhitespace = /^\s*/.exec(lineText)![0];
    if (!leadingWhitespace) continue;
    if (leadingWhitespace.includes('\t')) {
      return listIndentStyle.tabs;
    }

    if (/^ +$/.test(leadingWhitespace)) {
      spaceIndents.push(leadingWhitespace.length);
    }
  }

  if (!spaceIndents.length) {
    return defaultListIndentStyle;
  }

  const isFourSpaceList = spaceIndents.every((length) => length % FOUR_SPACE_INDENT_COLUMNS === 0);
  return isFourSpaceList ? listIndentStyle.fourSpaces : defaultListIndentStyle;
}

const listIndentStyleCache = new WeakMap<Text, Map<number, ListIndentStyle>>();
export function detectListIndentStylesByLine(state: EditorState, scope?: { fromLine: number; toLine: number }): Map<number, ListIndentStyle> {
  const cached = !scope && listIndentStyleCache.get(state.doc);
  if (cached) return cached;
  const stylesByLine = new Map<number, ListIndentStyle>();
  let startLineNo = 1;
  let listLineTexts: string[] = [];
  const finishRun = () => {
    if (!listLineTexts.length) return;
    const style = inferListIndentStyle(listLineTexts);
    for (let offset = 0; offset < listLineTexts.length; offset += 1) {
      stylesByLine.set(startLineNo + offset, style);
    }
    listLineTexts = [];
  };
  for (const line of documentLines(state.doc, scope?.fromLine, scope?.toLine)) {
    if (isListLine(line.text)) {
      if (!listLineTexts.length) startLineNo = line.number;
      listLineTexts.push(line.text);
    } else {
      finishRun();
    }
  }
  finishRun();

  if (!scope) listIndentStyleCache.set(state.doc, stylesByLine);
  return stylesByLine;
}

function lineIndentStyle(
  lineNumber: number,
  stylesByLine: ReadonlyMap<number, ListIndentStyle> | null | undefined
): ListIndentStyle {
  return stylesByLine?.get(lineNumber) ?? defaultListIndentStyle;
}

export function nextOrderedSequenceNumber(
  orderedCountsByLevel: Array<number | null>,
  level: number,
  orderedNumber: string | null | undefined,
  preserveNestedExplicitStart = true
): { expected: number | null; isAnchor: boolean } {
  orderedCountsByLevel.length = level + 1;
  if (!orderedNumber) {
    orderedCountsByLevel[level] = null;
    return { expected: null, isAnchor: false };
  }

  const current = orderedCountsByLevel[level];
  if (current === null || current === undefined) {
    const isAnchor = level === 0 || preserveNestedExplicitStart;
    const parsed = isAnchor ? Number.parseInt(orderedNumber, 10) : 1;
    orderedCountsByLevel[level] = parsed;
    return { expected: parsed, isAnchor };
  }

  const next = current + 1;
  orderedCountsByLevel[level] = next;
  return { expected: next, isAnchor: false };
}

function indentationColumns(
  leadingWhitespace: string,
  style: ListIndentStyle = defaultListIndentStyle
): number {
  let columns = 0;
  for (let index = 0; index < leadingWhitespace.length; index += 1) {
    columns += leadingWhitespace[index] === '\t' ? style.columns : 1;
  }
  return columns;
}

function listIndentDeleteLength(
  leadingWhitespace: string,
  style: ListIndentStyle = defaultListIndentStyle
): number {
  if (!leadingWhitespace) {
    return 0;
  }
  return leadingWhitespace.startsWith('\t')
    ? 1
    : Math.min(style.columns, leadingWhitespace.match(/^ +/)?.[0]?.length ?? 0);
}

export function indentListByTwoSpaces(view: EditorView): boolean {
  const { state } = view;
  const stylesByLine = detectListIndentStylesByLine(state);
  const changes: ListTextChange[] = [];
  const resetNestedStartsAtLines: number[] = [];

  forEachSelectionLine(state, (line) => {
    const lineText = state.doc.sliceString(line.from, line.to);
    if (!isListLine(lineText)) {
      return;
    }
    const style = lineIndentStyle(line.number, stylesByLine);
    changes.push({ from: line.from, insert: style.insert });
    if (listMarkerData(lineText, null, style)?.orderedNumber !== undefined) {
      resetNestedStartsAtLines.push(line.number);
    }
  });

  if (!changes.length) {
    return false;
  }

  view.dispatch({
    changes,
    userEvent: 'input.list',
    annotations: orderedListNormalizationIntent.of({ resetNestedStartsAtLines })
  });
  return true;
}

export function outdentListByTwoSpaces(view: EditorView): boolean {
  const { state } = view;
  const stylesByLine = detectListIndentStylesByLine(state);
  const changes: ListTextChange[] = [];

  forEachSelectionLine(state, (line) => {
    const lineText = state.doc.sliceString(line.from, line.to);
    const marker = readMarkdownListPrefix(lineText);
    if (!marker?.leadingWhitespace.length) {
      return;
    }

    const leadingWhitespace = marker.leadingWhitespace;
    const style = lineIndentStyle(line.number, stylesByLine);
    const deleteLength = listIndentDeleteLength(leadingWhitespace, style);
    if (!deleteLength) {
      return;
    }

    changes.push({ from: line.from, to: line.from + deleteLength, insert: '' });
  });

  if (!changes.length) {
    return false;
  }

  view.dispatch({ changes, userEvent: 'input.list' });
  return true;
}

function collectNestedListHoistChanges(
  state: EditorState,
  parentLine: Line,
  parentMarker: ListMarkerData,
  stylesByLine: ReadonlyMap<number, ListIndentStyle>
): ListTextDeletion[] {
  if (parentLine.number >= state.doc.lines) {
    return [];
  }

  const parentIndentColumns = parentMarker.indentColumns ?? 0;
  const changes: ListTextDeletion[] = [];
  let foundNestedDescendants = false;

  for (let lineNo = parentLine.number + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const lineText = state.doc.sliceString(line.from, line.to);

    if (!lineText.trim()) {
      continue;
    }

    const style = lineIndentStyle(lineNo, stylesByLine);
    const marker = listMarkerData(lineText, null, style);
    if (!marker) {
      if (!foundNestedDescendants) {
        return [];
      }
      break;
    }

    const indentColumns = marker.indentColumns ?? 0;
    if (indentColumns <= parentIndentColumns) {
      if (!foundNestedDescendants) {
        return [];
      }
      break;
    }

    foundNestedDescendants = true;
    const deleteLength = listIndentDeleteLength(marker.leadingWhitespace, style);
    if (!deleteLength) {
      continue;
    }

    changes.push({ from: line.from, to: line.from + deleteLength, insert: '' });
  }

  return changes;
}

function taskStatusFromMarker(markerChar: string): TaskStatus {
  return markerChar.toLowerCase() === 'x' ? 'done' : 'todo';
}

function taskStatusCssClass(status: TaskStatus): string {
  return `is-${status}`;
}

function siblingListPrefix(lineText: string, marker: MarkdownListPrefix, advance: boolean, keepOriginalItemSuffix = false): string | null {
  let number = marker.orderedNumber;
  if (advance && number !== undefined) {
    const next = Number.parseInt(number, 10) + 1;
    if (!Number.isFinite(next)) return null;
    number = String(next);
  }
  const markerText = marker.bullet ?? `${number}${marker.orderedSuffix}`;
  const separator = keepOriginalItemSuffix
    ? lineText.slice(marker.markerEndOffset, marker.toOffset)
    : marker.taskMarker === undefined ? ' ' : ' [ ] ';
  return lineText.slice(0, marker.fromOffset) + markerText + separator;
}

export function listMarkerData(
  lineText: string,
  orderedDisplayIndex: OrderedDisplayIndex = null,
  style: ListIndentStyle = defaultListIndentStyle,
  markerOffset = 0
): ListMarkerData | null {
  const prefix = readMarkdownListPrefix(lineText, markerOffset);
  if (!prefix) {
    return null;
  }

  const { leadingWhitespace, orderedNumber, orderedSuffix, taskMarker } = prefix;

  let markerText = '•';
  let classes = 'meo-md-list-marker-bullet';

  if (orderedNumber && orderedSuffix) {
    markerText = `${orderedDisplayIndex ?? orderedNumber}${orderedSuffix}`;
    classes = 'meo-md-list-marker-ordered';
  }

  const markerCharLength = prefix.markerEndOffset - prefix.fromOffset;
  const indentColumns = indentationColumns(leadingWhitespace, style);
  // CommonMark display numbers can outgrow repeated source markers such as 1.
  const displayExtraColumns = Math.max(0, markerText.length - markerCharLength);
  const contentOffsetColumns = markerOffset + indentColumns + (prefix.toOffset - prefix.fromOffset) + displayExtraColumns;
  const indentLevel = Math.floor(indentColumns / style.columns);
  if (!orderedNumber && indentLevel % 2 === 1) {
    classes += ' meo-md-list-marker-bullet-hollow';
  }

  const result: ListMarkerData = {
    ...prefix,
    indentLevel,
    indentColumns,
    contentOffsetColumns,
    displayExtraColumns,
    markerText,
    classes,
    orderedNumber,
    isTask: false,
    taskHiddenPrefixColumns: 0
  };

  if (taskMarker !== undefined) {
    const hiddenFrom = orderedNumber ? prefix.taskBracketStart! : prefix.fromOffset;
    const hiddenTaskPrefixLength = Math.max(0, prefix.toOffset - hiddenFrom - 1);
    result.taskStatus = taskStatusFromMarker(taskMarker);
    result.isTask = true;
    result.taskHiddenPrefixColumns = hiddenTaskPrefixLength;
  }

  return result;
}

function quotePrefixOffset(lineText: string, allowContainerIndent = false): number {
  let offset = 0;
  const quote = allowContainerIndent ? /^[ \t]*>[ \t]?/ : /^[ \t]{0,3}>[ \t]?/;
  while (true) {
    const match = quote.exec(lineText.slice(offset));
    if (!match) return offset;
    offset += match[0].length;
  }
}

export function listMarkerDataInContainerLine(lineText: string): ListMarkerData | null {
  return listMarkerData(lineText, null, defaultListIndentStyle, quotePrefixOffset(lineText));
}

export function isOrderedParagraphContinuation(
  state: EditorState, line: Line, marker: MarkdownListPrefix, tree: Tree = syntaxTree(state)
): boolean {
  // An empty 1. can become a real item as soon as the user starts its body.
  if (marker.orderedNumber === undefined || Number(marker.orderedNumber) === 1) return false;
  for (let node: SyntaxNode | null = tree.resolveInner(line.from + marker.fromOffset, 1); node; node = node.parent) {
    if (node.name === 'Paragraph') return node.from < line.from;
    if (node.name === 'ListMark') return false;
  }
  return false;
}

class ListMarkerWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  text: string;
  classes: string;
  widthColumns: number;

  constructor(text: string, classes: string, widthColumns: number) {
    super();
    this.text = text;
    this.classes = classes;
    this.widthColumns = widthColumns;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ListMarkerWidget &&
      other.text === this.text &&
      other.classes === this.classes &&
      other.widthColumns === this.widthColumns;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = `meo-md-list-marker ${this.classes}`;
    marker.style.width = `${this.widthColumns}ch`;
    const appendSourceGap = () => {
      const sourceGap = document.createElement('span');
      sourceGap.className = 'meo-md-list-source-gap';
      sourceGap.textContent = ' ';
      marker.appendChild(sourceGap);
    };
    if (this.classes.includes('meo-md-list-marker-bullet')) {
      marker.setAttribute('aria-hidden', 'true');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      dot.setAttribute('viewBox', '0 0 16 16');
      dot.setAttribute('class', 'meo-md-list-marker-bullet-dot');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '8');
      circle.setAttribute('cy', '8');
      circle.setAttribute('r', '5');
      dot.appendChild(circle);
      marker.appendChild(dot);
      appendSourceGap();
      return marker;
    }

    marker.textContent = this.text;
    appendSourceGap();
    return marker;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class CheckboxWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const from = changes.mapPos(this.bracketStart, 1);
    return from === this.bracketStart ? this : new CheckboxWidget(this.status, from);
  }
  status: TaskStatus;
  bracketStart: number;

  constructor(status: TaskStatus, bracketStart: number) {
    super();
    this.status = status;
    this.bracketStart = bracketStart;
  }

  eq(other: WidgetType): boolean {
    return other instanceof CheckboxWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.status === this.status &&
      other.bracketStart === this.bracketStart;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('mousedown', (e) => { e.preventDefault(); });
    this.updateDOM(checkbox, view);
    return checkbox;
  }

  updateDOM(checkbox: HTMLElement, view: EditorView): boolean {
    if (!(checkbox instanceof HTMLInputElement)) return false;
    const isDone = this.status === 'done';
    checkbox.className = `meo-task-checkbox ${taskStatusCssClass(this.status)}`;
    checkbox.checked = isDone;
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    checkbox.setAttribute('aria-label', isDone ? strings.markTaskIncomplete : strings.markTaskComplete);

    // Rebind the current immutable widget, including rebased source positions.
    let pointerActivation = false;
    checkbox.onclick = event => { pointerActivation = event.detail > 0; };
    checkbox.onchange = () => {
      const keyboardActivation = !pointerActivation && checkbox === checkbox.ownerDocument.activeElement;
      pointerActivation = false;
      const newChar = checkbox.checked ? 'x' : ' ';
      const line = view.state.doc.lineAt(this.bracketStart);
      // Read only the current separator, not a cached decoration boundary or
      // a copy of the whole task body. Pending input can extend that separator.
      let body = this.bracketStart + 3;
      const suffix = view.state.doc.iterRange(body, line.to);
      while (!suffix.next().done) {
        const spaces = /^[ \t]*/.exec(suffix.value)![0].length;
        body += spaces;
        if (spaces !== suffix.value.length) break;
      }
      const selection = view.state.selection.main;
      const inBody = selection.from >= body && selection.to <= line.to;
      const target = inBody ? selection.head : body;
      view.dispatch({
        changes: { from: this.bracketStart + 1, to: this.bracketStart + 2, insert: newChar },
        // Pointer activation adopts this task; keyboard activation keeps the
        // native checkbox focused and leaves its text selection untouched.
        selection: keyboardActivation || inBody ? undefined : { anchor: body },
        effects: listHistoryFocusEffect(line.from, target, target, inBody),
        annotations: isolateHistory.of('full'),
        userEvent: 'input.task'
      });
      if (!keyboardActivation) view.focus();
    };
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function selectionEditsListMarker(from: number, to: number, markerFrom: number, markerTo: number): boolean {
  // A caret on either edge leaves the marker rendered. A selection
  // confined to the marker can include those edges to edit the whole prefix.
  return from === to
    ? from > markerFrom && from < markerTo
    : from >= markerFrom && to <= markerTo;
}

export function addListMarkerDecoration(
  builder: Array<Range<Decoration>>,
  state: EditorState,
  from: number,
  orderedDisplayIndex: OrderedDisplayIndex = null,
  style: ListIndentStyle = defaultListIndentStyle,
  options: ListMarkerDecorationOptions | null = null,
  markerOffset = 0
): void {
  const line = state.doc.lineAt(from);
  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = listMarkerData(lineText, orderedDisplayIndex, style, markerOffset);
  if (!marker) {
    return;
  }

  const indentEnd = line.from + marker.fromOffset;
  const markerEnd = line.from + marker.markerEndOffset;
  const markerTo = line.from + marker.toOffset;

  // A prefix without a separator also has no room for the widget's trailing gap.
  const editingMarker = sourcePresentationSelection(state).ranges.some(({ from, to }) =>
    selectionEditsListMarker(from, to, indentEnd, markerTo));
  if (options?.useSourceStyleLiteral || marker.toOffset === marker.markerEndOffset || editingMarker) {
    if (markerTo > indentEnd) {
      builder.push(sourceListMarkerDeco.range(indentEnd, markerTo));
    }
    return;
  }

  if (marker.taskBracketStart !== undefined) {
    const bracketStart = line.from + marker.taskBracketStart;
    const taskStatus = marker.taskStatus ?? 'todo';
    if (marker.orderedNumber) {
      builder.push(Decoration.replace({
        widget: new ListMarkerWidget(marker.markerText, marker.classes, bracketStart - indentEnd + marker.displayExtraColumns),
        inclusive: false
      }).range(indentEnd, bracketStart));
    }
    builder.push(
      Decoration.replace({
        widget: new CheckboxWidget(taskStatus, bracketStart),
        inclusive: false
      }).range(marker.orderedNumber ? bracketStart : indentEnd, markerTo)
    );

    if (taskStatus === 'done') {
      const textStart = line.from + marker.toOffset;
      if (textStart < line.to) {
        builder.push(taskCompleteDeco.range(textStart, line.to));
      }
    }
  } else if (markerEnd > indentEnd) {
    builder.push(
      Decoration.replace({
        widget: new ListMarkerWidget(
          marker.markerText,
          marker.classes,
          marker.toOffset - marker.fromOffset + marker.displayExtraColumns
        ),
        inclusive: false
      }).range(indentEnd, markerTo)
    );
  }

}

export function isListMarkerDecoration(decoration: Decoration): boolean {
  return decoration.spec.widget instanceof ListMarkerWidget || decoration.spec.widget instanceof CheckboxWidget;
}

/** Retain an untouched marker beside an indentation edit, or rebuild an ordered
 * marker whose digits changed. This projects accepted prefixes only; the regular
 * renderer still owns container interpretation and its authoritative refresh. */
export function projectChangedListMarkerDecoration(
  decoration: Decoration,
  transaction: Transaction,
  from: number,
  to: number
): Range<Decoration> | undefined {
  if (!isListMarkerDecoration(decoration)) return;
  const oldPrefix = transaction.startState.doc.sliceString(from, to);
  const mappedFrom = transaction.changes.mapPos(from, 1), mappedTo = transaction.changes.mapPos(to, -1);
  if (mappedTo > mappedFrom && oldPrefix === transaction.newDoc.sliceString(mappedFrom, mappedTo)) {
    const widget = decoration.spec.widget;
    return Decoration.replace({ ...decoration.spec,
      widget: widget?.[mapLiveWidgetPositions]?.(transaction.changes) ?? widget
    }).range(mappedFrom, mappedTo);
  }
  const previous = readMarkdownListPrefix(oldPrefix);
  if (!previous?.orderedNumber || previous.fromOffset !== 0
    || previous.toOffset !== oldPrefix.length || previous.toOffset === previous.markerEndOffset) return;
  const nextFrom = transaction.changes.mapPos(from, -1), nextTo = transaction.changes.mapPos(to, 1);
  const nextText = transaction.newDoc.sliceString(nextFrom, nextTo);
  // A prefix split belongs to structural refresh, rather than one inline widget.
  if (/[\r\n]/.test(nextText)) return;
  const next = readMarkdownListPrefix(nextText);
  if (!next?.orderedNumber || next.fromOffset !== 0 || next.toOffset !== nextText.length
    || next.toOffset === next.markerEndOffset || next.orderedNumber === previous.orderedNumber
    || next.orderedSuffix !== previous.orderedSuffix) return;
  const ranges: Array<Range<Decoration>> = [];
  const line = transaction.newDoc.lineAt(nextFrom);
  addListMarkerDecoration(ranges, transaction.state, nextFrom, null, defaultListIndentStyle, null, nextFrom - line.from);
  return ranges.find(range => range.from === nextFrom && range.to === nextTo
    && isListMarkerDecoration(range.value)
    && (range.value.spec.widget instanceof CheckboxWidget) === (decoration.spec.widget instanceof CheckboxWidget));
}

export function continuedListMarker(lineText: string, advance = true): string | null {
  const marker = readMarkdownListPrefix(lineText, quotePrefixOffset(lineText));
  return marker && lineText.slice(marker.toOffset).trim() ? siblingListPrefix(lineText, marker, advance) : null;
}

function continuedContainerPrefix(text: string, prefixes: readonly MarkdownContainerPrefix[], tabSize: number): string {
  let result = '';
  for (const prefix of prefixes) {
    if (prefix.kind === 'quote') {
      result += text.slice(prefix.from, prefix.to);
    } else {
      const startColumn = countColumn(text, tabSize, prefix.marker.fromOffset);
      const endColumn = countColumn(text, tabSize, prefix.to);
      result += prefix.marker.leadingWhitespace + ' '.repeat(endColumn - startColumn);
    }
  }
  return result;
}

/** Continue the innermost list or quote and keep its outer containers. */
export function handleEnterInList({ state, dispatch }: Parameters<StateCommand>[0], tableCell = false): boolean {
  const selection = state.selection.main;
  if (state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  const prefixes = readMarkdownContainerPrefixes(line.text);
  // Wide indentation can belong to a surrounding list or be literal text.
  // Only the syntax owner can distinguish the two.
  for (const prefix of prefixes) {
    if (prefix.kind !== 'quote') continue;
    const indent = countColumn(line.text, state.tabSize, prefix.markOffset)
      - countColumn(line.text, state.tabSize, prefix.from);
    if (indent > 3 && syntaxTree(state).resolveInner(line.from + prefix.markOffset, 1).name !== 'QuoteMark') return false;
  }
  const inner = prefixes.at(-1);
  if (!inner) return false;
  if (!tableCell && inner.kind === 'list' && isOrderedParagraphContinuation(state, line, inner.marker)) return false;
  const contentStart = line.from + inner.to;
  if (!line.text.slice(inner.to).trim()) {
    if (selection.head !== contentStart && selection.head !== line.to) return false;
    dispatch(state.update({
      changes: { from: line.from + inner.from, to: line.to, insert: '' },
      selection: { anchor: line.from + inner.from },
      userEvent: 'input.list.enter'
    }));
    return true;
  }
  if (selection.head < contentStart) return false;

  const ancestors = continuedContainerPrefix(line.text, prefixes.slice(0, -1), state.tabSize);
  const atStart = selection.head === contentStart;
  const sibling = inner.kind === 'list' ? siblingListPrefix(line.text, inner.marker, true, atStart) : line.text.slice(0, inner.to);
  if (sibling === null) return false;
  const continued = ancestors + sibling.slice(inner.from);
  if (atStart) {
    const empty = inner.kind === 'list' ? siblingListPrefix(line.text, inner.marker, false) : line.text.slice(0, inner.to);
    if (empty === null) return false;
    dispatch(state.update({
      changes: { from: line.from, to: contentStart, insert: empty + '\n' + continued },
      selection: { anchor: line.from + empty.length },
      userEvent: 'input.list.enter'
    }));
    return true;
  }

  const split = selection.head - line.from;
  const atEnd = selection.head === line.to;
  const from = atEnd ? selection.head : contentStart + line.text.slice(inner.to, split).trimEnd().length;
  const to = selection.head + (/^[ \t]*/.exec(line.text.slice(split))?.[0].length ?? 0);
  dispatch(state.update({
    changes: { from, to, insert: '\n' + continued },
    selection: { anchor: from + 1 + continued.length },
    userEvent: 'input.list.enter'
  }));
  return true;
}

/** The end of an open fence or indented block still belongs to its code. */
function isInCodeBlock(tree: Tree, position: number): boolean {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(position, side); node; node = node.parent) {
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') continue;
      const last = node.lastChild;
      return position < node.to || last?.name !== 'CodeMark' || last.from === node.from;
    }
  }
  return false;
}

export const handleBackspaceAtListContentStart: StateCommand = ({ state, dispatch }) => {
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const line = state.doc.lineAt(selection.head);
  const lineText = state.doc.sliceString(line.from, line.to);
  const stylesByLine = detectListIndentStylesByLine(state);
  const style = lineIndentStyle(line.number, stylesByLine);
  const marker = listMarkerData(lineText, null, style);
  if (!marker) {
    return false;
  }

  const contentStart = line.from + marker.toOffset;
  const markerVisualEnd = line.from + marker.markerEndOffset;
  const content = lineText.slice(marker.toOffset);
  const isAtContentStart = selection.head === contentStart;
  const isAtEmptyItemMarkerEnd =
    !content.trim() &&
    selection.head >= markerVisualEnd &&
    selection.head <= contentStart;

  if (!isAtContentStart && !isAtEmptyItemMarkerEnd) {
    return false;
  }

  if (isBackgroundMarkdownPreparationPending(state)
    || isInCodeBlock(resolvedSyntaxTreeAt(state, line.to), line.from + marker.fromOffset)) return false;

  const deletingEmptyLine = !content.trim();
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const hoistChanges = collectNestedListHoistChanges(state, line, marker, stylesByLine);

  const changes = [
    deletingEmptyLine
      ? {
          from: line.from,
          to: line.number < state.doc.lines ? state.doc.line(line.number + 1).from : line.to,
          insert: ''
        }
      : { from: line.from, to: contentStart, insert: '' },
    ...hoistChanges
  ];

  let selectionAnchor = line.from;
  if (deletingEmptyLine && nextLine) {
    const nextLineText = state.doc.sliceString(nextLine.from, nextLine.to);
    const nextStyle = lineIndentStyle(nextLine.number, stylesByLine);
    const nextMarker = listMarkerData(nextLineText, null, nextStyle);
    if (nextMarker) {
      const nextLineHoist = hoistChanges.find((change) => change.from === nextLine.from);
      const hoistDeleteLength = nextLineHoist ? nextLineHoist.to - nextLineHoist.from : 0;
      selectionAnchor = line.from + Math.max(0, nextMarker.toOffset - hoistDeleteLength);
    }
  }

  dispatch(state.update({
    changes,
    selection: { anchor: selectionAnchor },
    effects: listHistoryFocusEffect(line.from, selection.head, selectionAnchor),
    annotations: isolateHistory.of('full'),
    userEvent: 'delete.backward'
  }));
  return true;
};

export function handleDeleteBeforeEmptyListItem(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const position = state.selection.main.head;
  const line = state.doc.lineAt(position);
  if (position !== line.to || line.number === state.doc.lines) return false;
  const marker = listMarkerDataInContainerLine(line.text);
  if (!marker || lineIsInFrontmatterContent(parseFrontmatter(state), line)) return false;
  const nextLine = state.doc.line(line.number + 1);
  const nextMarker = listMarkerDataInContainerLine(nextLine.text);
  if (!nextMarker || nextLine.text.slice(nextMarker.toOffset).trim()
    || line.text.slice(0, quotePrefixOffset(line.text)) !== nextLine.text.slice(0, quotePrefixOffset(nextLine.text))) return false;
  view.dispatch({
    changes: { from: line.to, to: nextLine.to },
    selection: { anchor: position },
    effects: listHistoryFocusEffect(line.from, position, position),
    annotations: isolateHistory.of('full'),
    userEvent: 'delete.forward'
  });
  return true;
}

function collapsedSingleCursorListContext(state: EditorState) {
  if (state.selection.ranges.length !== 1) {
    return null;
  }

  const selection = state.selection.main;
  if (!selection.empty) {
    return null;
  }

  const line = state.doc.lineAt(selection.head);
  const frontmatter = parseFrontmatter(state);
  if (lineIsInFrontmatterContent(frontmatter, line)) {
    return null;
  }

  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = listMarkerData(lineText);
  if (!marker) {
    return null;
  }

  return {
    selection,
    line,
    marker,
    contentStart: line.from + marker.toOffset
  };
}

export function handleArrowLeftAtListContentStart(view: EditorView): boolean {
  const context = collapsedSingleCursorListContext(view.state);
  if (!context || context.selection.head !== context.contentStart) {
    return false;
  }

  view.dispatch({ selection: { anchor: context.line.from } });
  return true;
}

export function handleArrowRightAtListLineStart(view: EditorView): boolean {
  const context = collapsedSingleCursorListContext(view.state);
  if (!context || context.selection.head !== context.line.from) {
    return false;
  }

  view.dispatch({ selection: { anchor: context.contentStart } });
  return true;
}

interface ListLineRecord {
  readonly line: Line;
  readonly text: string;
  readonly prefixOffset: number;
  readonly quoteScope: string;
}

function readListLine(doc: Text, lineNumber: number, includeQuotes: boolean): ListLineRecord {
  const line = doc.line(lineNumber);
  const text = line.text;
  const prefixOffset = includeQuotes ? quotePrefixOffset(text, true) : 0;
  const quoteScope = prefixOffset
    ? text.slice(0, text.indexOf('>')) + text.slice(0, prefixOffset).replace(/[ \t]/g, '')
    : '';
  return { line, text, prefixOffset, quoteScope };
}

function collectContiguousListLines(
  doc: Text,
  lineNumber: number,
  includeQuotes: boolean
): ListLineRecord[] | null {
  const current = readListLine(doc, lineNumber, includeQuotes);
  const inRun = (row: ListLineRecord) => row.quoteScope === current.quoteScope
    && isListLine(row.text.slice(row.prefixOffset));
  if (!inRun(current)) {
    return null;
  }

  const lines: ListLineRecord[] = [];
  for (let previousLine = lineNumber - 1; previousLine >= 1; previousLine -= 1) {
    const previous = readListLine(doc, previousLine, includeQuotes);
    if (!inRun(previous)) break;
    lines.push(previous);
  }
  lines.reverse();
  lines.push(current);
  for (let nextLine = lineNumber + 1; nextLine <= doc.lines; nextLine += 1) {
    const next = readListLine(doc, nextLine, includeQuotes);
    if (!inRun(next)) break;
    lines.push(next);
  }
  return lines;
}

function collectOrderedListRenumberChangesInLines(
  lines: readonly ListLineRecord[],
  resetNestedStartsAtLines: ReadonlySet<number>
): ListTextChange[] {
  const changes: ListTextChange[] = [];
  const style = inferListIndentStyle(lines.map(({ text, prefixOffset }) => text.slice(prefixOffset)));
  const orderedCountsByLevel: Array<number | null> = [];

  for (const { line, text, prefixOffset } of lines) {
    const marker = listMarkerData(text, null, style, prefixOffset);
    if (!marker) {
      orderedCountsByLevel.length = 0;
      continue;
    }

    const { expected, isAnchor } = nextOrderedSequenceNumber(
      orderedCountsByLevel,
      marker.indentLevel,
      marker.orderedNumber,
      !resetNestedStartsAtLines.has(line.number)
    );
    if (expected === null || isAnchor || marker.orderedNumber === undefined) continue;

    const expectedText = String(expected);
    if (marker.orderedNumber !== expectedText) {
      const from = line.from + marker.fromOffset;
      changes.push({ from, to: from + marker.orderedNumber.length, insert: expectedText });
    }
  }

  return changes;
}

/**
 * Computes ordered-marker repairs only for list runs adjacent to a changed range.
 * A run is scanned as one unit because indentation style and numbering both depend
 * on its contiguous list context; ordinary text never enters that scan.
 */
function collectOrderedListRenumberChangesForTransaction(
  transaction: Transaction,
  resetNestedStartsAtLines: ReadonlySet<number> = new Set()
): ListTextChange[] {
  // Reading transaction.state here computes all fields before input extenders run.
  const doc = transaction.newDoc;
  const candidateLines = new Set<number>();
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = Math.min(doc.length, fromB);
    const to = Math.min(doc.length, toB);
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let lineNumber = Math.max(1, first - 1); lineNumber <= Math.min(doc.lines, last + 1); lineNumber += 1) {
      candidateLines.add(lineNumber);
    }
  });

  const handledLines = new Set<number>();
  const changes: ListTextChange[] = [];
  for (const lineNumber of [...candidateLines].sort((left, right) => left - right)) {
    if (handledLines.has(lineNumber)) continue;
    const lines = collectContiguousListLines(doc, lineNumber, transaction.isUserEvent('input.list.enter'));
    if (!lines) continue;
    for (const { line } of lines) handledLines.add(line.number);
    changes.push(...collectOrderedListRenumberChangesInLines(lines, resetNestedStartsAtLines));
  }

  return changes.length ? excludeCodeBlockChanges(transaction, changes) : changes;
}

/** Check the changed lines and the following line, which can enter or leave
 * a code block when its preceding line is edited. */
function touchesPossibleCode(doc: Text, from: number, to: number): boolean {
  const first = doc.lineAt(from);
  const next = doc.line(Math.min(doc.lines, doc.lineAt(to).number + 1));
  return next.to - first.from > LIST_CODE_PARSE_LIMIT
    || /`{3}|~{3}|(?:^|\n)(?:[ \t]*>)*[ \t]?(?: {4}| {0,3}\t)/.test(doc.sliceString(first.from, next.to));
}

function editsExistingListBody(transaction: Transaction, oldFrom: number, oldTo: number, from: number, to: number): boolean {
  const line = transaction.startState.doc.lineAt(oldFrom);
  if (oldTo > line.to || to > transaction.newDoc.lineAt(from).to) return false;
  const offset = oldFrom - line.from;
  if (offset > LIST_CODE_PARSE_LIMIT) return false;
  const beforeEdit = line.text.slice(0, offset);
  const prefix = readMarkdownContainerPrefixes(beforeEdit).at(-1);
  if (prefix?.kind !== 'list') return false;
  const firstBodyCharacter = beforeEdit[prefix.to];
  // Text before this edit already rules out introducing a fence or HTML opener.
  return !!firstBodyCharacter && !'<~`'.includes(firstBodyCharacter);
}

/** Existing code ownership can be reused for ordinary typing. When a fence or
 * indented block might change, confirm ownership in the edited revision. */
function excludeCodeBlockChanges(transaction: Transaction, changes: readonly ListTextChange[]): ListTextChange[] {
  const { startState, newDoc } = transaction;
  const parser = startState.facet(language)?.parser;
  if (!parser) return [...changes];
  // Missing syntax does not prove a list. A later edit in the run renumbers it.
  if (isBackgroundMarkdownPreparationPending(startState)) return [];
  let mayChangeCode = false;
  transaction.changes.iterChangedRanges((oldFrom, oldTo, from, to) => {
    if (mayChangeCode || editsExistingListBody(transaction, oldFrom, oldTo, from, to)) return;
    mayChangeCode = touchesPossibleCode(startState.doc, oldFrom, oldTo) || touchesPossibleCode(newDoc, from, to);
  });
  if (mayChangeCode) {
    // Keep this synchronous parse bounded. Ambiguous large edits preserve the
    // source digits until an edit has an accepted tree to consult.
    if (newDoc.length > LIST_CODE_PARSE_LIMIT) return [];
    const tree = parser.parse(newDoc.toString());
    return changes.filter(({ from }) => !isInCodeBlock(tree, from));
  }
  const toOld = transaction.changes.invertedDesc;
  const tree = resolvedSyntaxTreeAt(startState, toOld.mapPos(changes.at(-1)!.from, 1));
  return changes.filter(({ from }) => !isInCodeBlock(tree, toOld.mapPos(from, 1)));
}

/**
 * Keeps ordered-list normalization inside the originating CodeMirror transaction.
 * External Document presentation and native history replay remain authoritative.
 */
export function orderedListRenumberTransactionFilter(
  shouldNormalize: () => boolean
): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (
      !transaction.docChanged ||
      !shouldNormalize() ||
      transaction.annotation(Transaction.addToHistory) === false ||
      transaction.isUserEvent('undo') ||
      transaction.isUserEvent('redo')
    ) {
      return transaction;
    }

    const intent = transaction.annotation(orderedListNormalizationIntent);
    const changes = collectOrderedListRenumberChangesForTransaction(
      transaction,
      new Set(intent?.resetNestedStartsAtLines ?? [])
    );
    if (!changes.length) return transaction;

    // CodeMirror owns composition of the original transaction's opaque
    // annotations, effects, selection, scroll intent and history semantics.
    // Keeping the originating Transaction intact avoids a list-owned registry.
    return [transaction, { changes, sequential: true }];
  });
}

function computeSourceListMarkers(state: EditorState): DecorationSet {
  const stylesByLine = detectListIndentStylesByLine(state);
  const ranges = new RangeSetBuilder<Decoration>();
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const lineText = state.doc.sliceString(line.from, line.to);
    const style = lineIndentStyle(lineNo, stylesByLine);
    const marker = listMarkerData(lineText, null, style);
    if (!marker) {
      continue;
    }

    const markerFrom = line.from + marker.fromOffset;
    const markerTo = line.from + (marker.isTask ? marker.markerEndOffset : marker.toOffset);
    if (markerTo > markerFrom) {
      ranges.add(markerFrom, markerTo, sourceListMarkerDeco);
    }
    if (marker.taskBracketStart !== undefined) {
      const openBracket = line.from + marker.taskBracketStart;
      const closeBracket = openBracket + 2;
      ranges.add(openBracket, openBracket + 1, sourceTaskBracketDeco);
      ranges.add(closeBracket, closeBracket + 1, sourceTaskBracketDeco);
    }
  }
  return ranges.finish();
}

export const sourceListMarkerField = StateField.define<DecorationSet>({
  create(state: EditorState) {
    try {
      return computeSourceListMarkers(state);
    } catch {
      return Decoration.none;
    }
  },
  update(markers: DecorationSet, transaction: Transaction) {
    if (!transaction.docChanged) {
      return markers;
    }
    try {
      return computeSourceListMarkers(transaction.state);
    } catch {
      return markers;
    }
  },
  provide: (field) => EditorView.decorations.from(field)
});
