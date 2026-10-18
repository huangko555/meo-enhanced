import { RangeSet, RangeSetBuilder, type ChangeDesc, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type WidgetType } from '@codemirror/view';

/** Only for proven plain-prose changes outside widgets, with no line changes.
 * Return an immutable replacement, or the same widget when its positions stay
 * valid. Unknown widgets conservatively keep the authoritative rebuild path.
 */
export const mapLiveWidgetPositions = Symbol('mapLiveWidgetPositions');
interface LiveWidgetPositions {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType;
}

// Ordinary marks can use RangeSet's structural mapping. Only widgets carry
// embedded source positions, so keep their projection separate from the much
// larger mark set. These caps bound both the initial partition and later edits.
const maxProjectionDecorations = 131_072;
const maxProjectionWidgets = 16_384;
type ProjectionParts = { marks: DecorationSet; widgets: DecorationSet };
const mappableSets = new WeakMap<DecorationSet, ProjectionParts | false>();

function projectionParts(decorations: DecorationSet): ProjectionParts | false {
  const cached = mappableSets.get(decorations);
  if (cached !== undefined) return cached;
  const marks = new RangeSetBuilder<Decoration>(), widgets = new RangeSetBuilder<Decoration>();
  let count = 0;
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    const widget = cursor.value.spec.widget as (WidgetType & Partial<LiveWidgetPositions>) | undefined;
    if (widget && (++count > maxProjectionWidgets || typeof widget[mapLiveWidgetPositions] !== 'function'
      || (cursor.from === cursor.to && !('side' in cursor.value.spec)))) {
      mappableSets.set(decorations, false);
      return false;
    }
    (widget ? widgets : marks).add(cursor.from, cursor.to, cursor.value);
  }
  const result = { marks: marks.finish(), widgets: widgets.finish() };
  mappableSets.set(decorations, result);
  return result;
}

/** Prepare once with the complete presentation, before the next input frame. */
export function prepareLiveWidgetPositions(decorations: DecorationSet): void {
  if (decorations.size <= maxProjectionDecorations) projectionParts(decorations);
}

/** Keep the prepared partition when replacing a proven, bounded caret block. */
export function replaceLiveCaretDecorations(decorations: DecorationSet, from: number, to: number, add: Range<Decoration>[]): DecorationSet {
  const filter = (start: number, end: number) => start < from || end > to;
  const result = decorations.update({ filterFrom: from, filterTo: to, filter, add, sort: true });
  const parts = mappableSets.get(decorations);
  if (parts) mappableSets.set(result, {
    marks: parts.marks.update({ filterFrom: from, filterTo: to, filter, add: add.filter(range => !range.value.spec.widget), sort: true }),
    widgets: parts.widgets.update({ filterFrom: from, filterTo: to, filter, add: add.filter(range => range.value.spec.widget), sort: true })
  });
  return result;
}

/** Call only after proving complete syntax and unchanged plain prose with no
 * line changes. Undefined requests the existing bounded-input fallback. */
export function mapStableLiveDecorations(decorations: DecorationSet, changes: ChangeDesc, state: EditorState): {
  decorations: DecorationSet;
  rebasedWidgets: boolean;
} | undefined {
  let hasLaterDecorations = false;
  changes.iterChangedRanges(from => { hasLaterDecorations ||= !!decorations.iter(from).value; });
  if (!hasLaterDecorations) return { decorations: decorations.map(changes), rebasedWidgets: false };
  if (decorations.size > maxProjectionDecorations) return;
  const parts = projectionParts(decorations);
  if (!parts) return;
  const mappedWidgets = parts.widgets.map(changes);
  const widgets = new RangeSetBuilder<Decoration>();
  let rebasedWidgets = false;
  for (const cursor = mappedWidgets.iter(); cursor.value; cursor.next()) {
    const value = cursor.value;
    const widget = value.spec.widget as WidgetType & LiveWidgetPositions;
    const next = widget[mapLiveWidgetPositions](changes, state);
    if (next === widget) { widgets.add(cursor.from, cursor.to, value); continue; }
    const spec = { ...value.spec, widget: next };
    const decoration = cursor.from === cursor.to ? Decoration.widget(spec) : Decoration.replace(spec);
    widgets.add(cursor.from, cursor.to, decoration);
    rebasedWidgets = true;
  }
  // Preserve the original order of widgets sharing a position and side (code
  // labels/actions, for example). Removing/re-adding only one reorders its DOM.
  const nextParts = { marks: parts.marks.map(changes), widgets: rebasedWidgets ? widgets.finish() : mappedWidgets };
  const result = rebasedWidgets ? RangeSet.join([nextParts.marks, nextParts.widgets]) : decorations.map(changes);
  mappableSets.set(result, nextParts);
  return { decorations: result, rebasedWidgets };
}
