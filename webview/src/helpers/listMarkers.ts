import {
  StateField,
  RangeSetBuilder,
  EditorState,
  Transaction,
  Annotation,
  type Extension,
  type Line,
  type Range
} from '@codemirror/state';
import { Decoration, WidgetType, EditorView, type DecorationSet } from '@codemirror/view';
import { parseFrontmatter, isInsideFrontmatterContent } from './frontmatter';

interface ListMarkerData {
  fromOffset: number;
  leadingWhitespace: string;
  indentLevel: number;
  indentColumns: number;
  markerEndOffset: number;
  toOffset: number;
  contentOffsetColumns: number;
  markerText: string;
  classes: string;
  orderedNumber: string | undefined;
  isTask: boolean;
  taskHiddenPrefixColumns: number;
  taskBracketStart?: number;
  taskStatus?: TaskStatus;
}

type TaskStatus = 'todo' | 'inprogress' | 'done' | 'dropped';
type OrderedDisplayIndex = string | number | null;

interface ListIndentStyle {
  columns: number;
  insert: string;
}

interface ParsedListMarkerParts {
  leadingWhitespace: string;
  bullet: string | undefined;
  orderedNumber: string | undefined;
  orderedSuffix: string | undefined;
  hasTask: boolean;
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
const taskDroppedDeco = Decoration.mark({ class: 'meo-task-dropped' });
const listItemRegex = /^(\s*)(?:[-+*]|\d+[.)])(?:\s+|$)/;
const listMarkerRegex = /^(\s*)(?:([-+*])|(\d+)([.)]))(?:\s+(?:\[([ xX~\-])\]\s+)?|$)/;
const TWO_SPACE_INDENT = '  ';
const FOUR_SPACE_INDENT = '    ';
const TAB_INDENT = '\t';
const TWO_SPACE_INDENT_COLUMNS = 2;
const FOUR_SPACE_INDENT_COLUMNS = 4;
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
const taskStatusByMarker: Record<string, TaskStatus> = {
  x: 'done',
  '~': 'inprogress',
  '-': 'dropped',
  ' ': 'todo'
};
const taskStatusClassByStatus: Record<TaskStatus, string> = {
  todo: 'is-todo',
  inprogress: 'is-inprogress',
  done: 'is-done',
  dropped: 'is-dropped'
};

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
  return listItemRegex.test(lineText);
}

function inferListIndentStyle(listLineTexts: readonly string[]): ListIndentStyle {
  const spaceIndents: number[] = [];
  for (const lineText of listLineTexts) {
    const match = listItemRegex.exec(lineText);
    if (!match || !match[1]) {
      continue;
    }

    const leadingWhitespace = match[1];
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

export function detectListIndentStylesByLine(state: EditorState): Map<number, ListIndentStyle> {
  const stylesByLine = new Map<number, ListIndentStyle>();
  let lineNo = 1;

  while (lineNo <= state.doc.lines) {
    const startLineNo = lineNo;
    const listLineTexts: string[] = [];

    while (lineNo <= state.doc.lines) {
      const line = state.doc.line(lineNo);
      const lineText = state.doc.sliceString(line.from, line.to);
      if (!isListLine(lineText)) {
        break;
      }
      listLineTexts.push(lineText);
      lineNo += 1;
    }

    if (!listLineTexts.length) {
      lineNo += 1;
      continue;
    }

    const style = inferListIndentStyle(listLineTexts);
    for (let currentLine = startLineNo; currentLine < lineNo; currentLine += 1) {
      stylesByLine.set(currentLine, style);
    }
  }

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
    const listMatch = listItemRegex.exec(lineText);
    if (!listMatch || !listMatch[1].length) {
      return;
    }

    const leadingWhitespace = listMatch[1];
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

  view.dispatch({ changes });
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

function parseListMarkerParts(lineText: string): ParsedListMarkerParts | null {
  const match = listMarkerRegex.exec(lineText);
  if (!match) {
    return null;
  }

  return {
    leadingWhitespace: match[1],
    bullet: match[2],
    orderedNumber: match[3],
    orderedSuffix: match[4],
    hasTask: match[5] !== undefined
  };
}

function taskStatusFromMarker(markerChar: string): TaskStatus {
  return taskStatusByMarker[markerChar.toLowerCase()] ?? 'todo';
}

function taskStatusCssClass(status: TaskStatus): string {
  return taskStatusClassByStatus[status];
}

function buildListMarkerText(
  parts: ParsedListMarkerParts | null,
  orderedNumber: string | undefined = parts?.orderedNumber
): string | null {
  if (!parts) {
    return null;
  }

  if (parts.bullet) {
    return parts.hasTask
      ? `${parts.leadingWhitespace}${parts.bullet} [ ] `
      : `${parts.leadingWhitespace}${parts.bullet} `;
  }

  if (!orderedNumber || !parts.orderedSuffix) {
    return null;
  }

  return parts.hasTask
    ? `${parts.leadingWhitespace}${orderedNumber}${parts.orderedSuffix} [ ] `
    : `${parts.leadingWhitespace}${orderedNumber}${parts.orderedSuffix} `;
}

export function listMarkerData(
  lineText: string,
  orderedDisplayIndex: OrderedDisplayIndex = null,
  style: ListIndentStyle = defaultListIndentStyle
): ListMarkerData | null {
  const match = listMarkerRegex.exec(lineText);
  if (!match) {
    return null;
  }

  const indent = match[1].length;
  const leadingWhitespace = match[1];
  const orderedNumber = match[3];
  const orderedSuffix = match[4];
  const taskMarker = match[5];

  let markerText = '•';
  let classes = 'meo-md-list-marker-bullet';

  if (orderedNumber && orderedSuffix) {
    markerText = `${orderedDisplayIndex ?? orderedNumber}${orderedSuffix}`;
    classes = 'meo-md-list-marker-ordered';
  }

  const markerCharLength = match[2]?.length ?? (orderedNumber?.length ?? 0) + (orderedSuffix?.length ?? 0);
  const markerEndOffset = indent + markerCharLength;
  const indentColumns = indentationColumns(leadingWhitespace, style);
  const contentOffsetColumns = indentColumns + (match[0].length - indent);
  const indentLevel = Math.floor(indentColumns / style.columns);
  if (!orderedNumber && indentLevel % 2 === 1) {
    classes += ' meo-md-list-marker-bullet-hollow';
  }

  const result: ListMarkerData = {
    fromOffset: indent,
    leadingWhitespace,
    indentLevel,
    indentColumns,
    markerEndOffset,
    toOffset: match[0].length,
    contentOffsetColumns,
    markerText,
    classes,
    orderedNumber,
    isTask: false,
    taskHiddenPrefixColumns: 0
  };

  if (taskMarker !== undefined) {
    const hiddenTaskPrefixLength = Math.max(0, (match[0].length - indent) - 1);
    result.taskBracketStart = markerEndOffset + 1;
    result.taskStatus = taskStatusFromMarker(taskMarker);
    result.isTask = true;
    result.taskHiddenPrefixColumns = hiddenTaskPrefixLength;
  }

  return result;
}

class ListMarkerWidget extends WidgetType {
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
}

class CheckboxWidget extends WidgetType {
  status: TaskStatus;
  bracketStart: number;

  constructor(status: TaskStatus, bracketStart: number) {
    super();
    this.status = status;
    this.bracketStart = bracketStart;
  }

  eq(other: WidgetType): boolean {
    return other instanceof CheckboxWidget && other.status === this.status && other.bracketStart === this.bracketStart;
  }

  toDOM(view: EditorView): HTMLElement {
    const isDone = this.status === 'done';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = `meo-task-checkbox ${taskStatusCssClass(this.status)}`;
    checkbox.checked = isDone;
    checkbox.setAttribute('aria-label', isDone ? 'Mark task as incomplete' : 'Mark task as complete');

    checkbox.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    checkbox.addEventListener('change', () => {
      const newChar = checkbox.checked ? 'x' : ' ';
      view.dispatch({
        changes: { from: this.bracketStart + 1, to: this.bracketStart + 2, insert: newChar }
      });
    });

    return checkbox;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function addListMarkerDecoration(
  builder: Array<Range<Decoration>>,
  state: EditorState,
  from: number,
  orderedDisplayIndex: OrderedDisplayIndex = null,
  style: ListIndentStyle = defaultListIndentStyle,
  options: ListMarkerDecorationOptions | null = null
): void {
  const line = state.doc.lineAt(from);
  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = listMarkerData(lineText, orderedDisplayIndex, style);
  if (!marker) {
    return;
  }

  const indentEnd = line.from + marker.fromOffset;
  const markerEnd = line.from + marker.markerEndOffset;
  const markerTo = line.from + marker.toOffset;

  if (options?.useSourceStyleLiteral) {
    if (markerTo > indentEnd) {
      builder.push(sourceListMarkerDeco.range(indentEnd, markerTo));
    }
    return;
  }

  if (marker.taskBracketStart !== undefined) {
    const bracketStart = line.from + marker.taskBracketStart;
    const taskStatus = marker.taskStatus ?? 'todo';
    builder.push(
      Decoration.replace({
        widget: new CheckboxWidget(taskStatus, bracketStart),
        inclusive: false
      }).range(indentEnd, markerTo)
    );

    if (taskStatus === 'done' || taskStatus === 'dropped') {
      const textStart = line.from + marker.toOffset;
      if (textStart < line.to) {
        builder.push((taskStatus === 'done' ? taskCompleteDeco : taskDroppedDeco).range(textStart, line.to));
      }
    }
  } else if (markerEnd > indentEnd) {
    builder.push(
      Decoration.replace({
        widget: new ListMarkerWidget(
          marker.markerText,
          marker.classes,
          marker.toOffset - marker.fromOffset
        ),
        inclusive: false
      }).range(indentEnd, markerTo)
    );
  }

}

export function continuedListMarker(lineText: string): string | null {
  const parts = parseListMarkerParts(lineText);
  if (!parts) {
    return null;
  }
  const marker = listMarkerData(lineText);
  if (!marker) {
    return null;
  }

  const hasContent = lineText.slice(marker.toOffset).trim().length > 0;
  if (!hasContent) {
    return null;
  }

  if (!parts.orderedNumber) {
    return buildListMarkerText(parts);
  }

  const nextNumber = Number.parseInt(parts.orderedNumber, 10) + 1;
  if (!Number.isFinite(nextNumber)) {
    return null;
  }
  return buildListMarkerText(parts, String(nextNumber));
}

function sameLevelListMarker(lineText: string): string | null {
  return buildListMarkerText(parseListMarkerParts(lineText));
}

export function handleEnterContinueList(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const position = selection.head;
  const line = state.doc.lineAt(position);
  if (position !== line.to) {
    return false;
  }

  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = continuedListMarker(lineText);
  if (!marker) {
    return false;
  }

  const insert = `\n${marker}`;
  view.dispatch({
    changes: { from: position, insert },
    selection: { anchor: position + insert.length }
  });
  return true;
}

export function handleEnterOnEmptyListItem(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const position = selection.head;
  const line = state.doc.lineAt(position);
  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = listMarkerData(lineText);
  if (!marker) {
    return false;
  }

  const contentStart = line.from + marker.toOffset;
  if (position !== contentStart && position !== line.to) {
    return false;
  }

  if (lineText.slice(marker.toOffset).trim().length > 0) {
    return false;
  }

  view.dispatch({
    changes: { from: line.from, to: contentStart, insert: '' },
    selection: { anchor: line.from }
  });
  return true;
}

export function handleBackspaceAtListContentStart(view: EditorView): boolean {
  const { state } = view;
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

  view.dispatch({
    changes,
    selection: { anchor: selectionAnchor }
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

export function handleEnterAtListContentStart(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const position = selection.head;
  const line = state.doc.lineAt(position);
  const lineText = state.doc.sliceString(line.from, line.to);
  const marker = listMarkerData(lineText);
  if (!marker) {
    return false;
  }

  const contentStart = line.from + marker.toOffset;
  if (position !== contentStart) {
    return false;
  }

  const content = lineText.slice(marker.toOffset).trim();
  if (!content) {
    return false;
  }

  const sameMarker = sameLevelListMarker(lineText);
  if (!sameMarker) {
    return false;
  }

  const insert = `${sameMarker}\n`;
  view.dispatch({
    changes: { from: line.from, insert },
    selection: { anchor: line.from + sameMarker.length }
  });
  return true;
}

export function handleEnterBeforeNestedList(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const position = selection.head;
  const line = state.doc.lineAt(position);
  if (position !== line.to || line.number >= state.doc.lines) {
    return false;
  }

  const currentText = state.doc.sliceString(line.from, line.to);
  const nextLine = state.doc.line(line.number + 1);
  const nextText = state.doc.sliceString(nextLine.from, nextLine.to);

  if (!/^[ \t]+(?:[-+*]|\d+[.)])\s+/.test(nextText)) {
    return false;
  }

  const marker = continuedListMarker(currentText);
  if (!marker) {
    return false;
  }

  const insert = `\n${marker}`;
  view.dispatch({
    changes: { from: position, insert },
    selection: { anchor: position + insert.length }
  });
  return true;
}

interface ListLineRecord {
  readonly line: Line;
  readonly text: string;
}

function readListLine(state: EditorState, lineNumber: number): ListLineRecord {
  const line = state.doc.line(lineNumber);
  return { line, text: state.doc.sliceString(line.from, line.to) };
}

function collectContiguousListLines(
  state: EditorState,
  lineNumber: number
): ListLineRecord[] | null {
  const current = readListLine(state, lineNumber);
  if (!isListLine(current.text)) {
    return null;
  }

  const lines: ListLineRecord[] = [];
  for (let previousLine = lineNumber - 1; previousLine >= 1; previousLine -= 1) {
    const previous = readListLine(state, previousLine);
    if (!isListLine(previous.text)) break;
    lines.push(previous);
  }
  lines.reverse();
  lines.push(current);
  for (let nextLine = lineNumber + 1; nextLine <= state.doc.lines; nextLine += 1) {
    const next = readListLine(state, nextLine);
    if (!isListLine(next.text)) break;
    lines.push(next);
  }
  return lines;
}

function collectOrderedListRenumberChangesInLines(
  lines: readonly ListLineRecord[],
  resetNestedStartsAtLines: ReadonlySet<number>
): ListTextChange[] {
  const changes: ListTextChange[] = [];
  const style = inferListIndentStyle(lines.map(({ text }) => text));
  const orderedCountsByLevel: Array<number | null> = [];

  for (const { line, text } of lines) {
    const marker = listMarkerData(text, null, style);
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
      const from = line.from + marker.leadingWhitespace.length;
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
  const state = transaction.state;
  const candidateLines = new Set<number>();
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = Math.min(state.doc.length, fromB);
    const to = Math.min(state.doc.length, toB);
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let lineNumber = Math.max(1, first - 1); lineNumber <= Math.min(state.doc.lines, last + 1); lineNumber += 1) {
      candidateLines.add(lineNumber);
    }
  });

  const handledLines = new Set<number>();
  const changes: ListTextChange[] = [];
  for (const lineNumber of [...candidateLines].sort((left, right) => left - right)) {
    if (handledLines.has(lineNumber)) continue;
    const lines = collectContiguousListLines(state, lineNumber);
    if (!lines) continue;
    for (const { line } of lines) handledLines.add(line.number);
    changes.push(...collectOrderedListRenumberChangesInLines(lines, resetNestedStartsAtLines));
  }

  return changes;
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

    const normalization = transaction.state.changes(changes);
    // CodeMirror owns composition of the original transaction's opaque
    // annotations, effects, selection, scroll intent and history semantics.
    // Keeping the originating Transaction intact avoids a list-owned registry.
    return [transaction, { changes: normalization, sequential: true }];
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
