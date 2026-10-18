import { RangeSet, RangeSetBuilder, type ChangeDesc, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type WidgetType } from '@codemirror/view';

/** For proven inline changes with unchanged reference/definition identity and
 * no line changes. The owner regenerates every affected presentation block.
 * Return an immutable replacement, or the same widget when its positions stay
 * valid. Unknown widgets conservatively keep the authoritative rebuild path.
 */
export const mapLiveWidgetPositions = Symbol('mapLiveWidgetPositions');
export const liveWidgetPositionsIndependent = Symbol('liveWidgetPositionsIndependent');
interface LiveWidgetPositions {
  readonly [liveWidgetPositionsIndependent]?: true;
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType;
}

// Ordinary marks can use RangeSet's structural mapping. Only widgets carry
// embedded source positions, so keep their projection separate from the much
// larger mark set. These caps bound both the initial partition and later edits.
const maxProjectionDecorations = 131_072;
const maxProjectionWidgets = 16_384;
type ProjectionParts = {
  stable: DecorationSet; // Pure marks, excluded from height comparison.
  points: DecorationSet; // Zero-width line decorations and controls.
  positioned: DecorationSet; // Nonempty replacements and block widgets.
};
const mappableSets = new WeakMap<DecorationSet, ProjectionParts | false>();

/** Keep pure marks out of CodeMirror's height-point comparison. Joining them
 * into one RangeSet propagates the point summary through all mark layers. */
export function liveWidgetPresentationLayers(decorations: DecorationSet): readonly DecorationSet[] {
  const parts = mappableSets.get(decorations);
  return parts ? [parts.positioned, parts.points, parts.stable] : [decorations];
}

function projectionParts(decorations: DecorationSet): ProjectionParts | false {
  const cached = mappableSets.get(decorations);
  if (cached !== undefined) return cached;
  const stable = new RangeSetBuilder<Decoration>(), points = new RangeSetBuilder<Decoration>(), positioned = new RangeSetBuilder<Decoration>();
  let count = 0;
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    const widget = cursor.value.spec.widget as (WidgetType & Partial<LiveWidgetPositions>) | undefined;
    if (widget && ((!widget[liveWidgetPositionsIndependent] && ++count > maxProjectionWidgets) || typeof widget[mapLiveWidgetPositions] !== 'function'
      || (cursor.from === cursor.to && !('side' in cursor.value.spec)))) {
      mappableSets.set(decorations, false);
      return false;
    }
    // Line decorations and replacements without a widget are points too.
    // Pure mark layers must retain maxPoint=-1 for height comparison.
    (cursor.value.point ? cursor.from === cursor.to ? points : positioned : stable).add(cursor.from, cursor.to, cursor.value);
  }
  const result = { stable: stable.finish(), points: points.finish(), positioned: positioned.finish() };
  mappableSets.set(decorations, result);
  return result;
}

/** Accept the same partition that later input maps. Merely caching a separate
 * partition loses chunk identity on its first use and makes CodeMirror compare
 * every unchanged mark whenever one positioned widget has to move. */
export function prepareLiveWidgetPositions(decorations: DecorationSet, viewportBounded = false): DecorationSet {
  if (!viewportBounded && decorations.size > maxProjectionDecorations) return decorations;
  const parts = projectionParts(decorations);
  if (!parts) return decorations;
  const result = RangeSet.join([parts.stable, parts.points, parts.positioned]);
  mappableSets.set(result, parts);
  return result;
}

/** Keep the prepared partition when replacing a closed presentation block. */
export function replaceLivePresentationRanges(decorations: DecorationSet, from: number, to: number, add: Range<Decoration>[]): DecorationSet {
  const filter = (start: number, end: number) => start < from || end > to;
  const parts = mappableSets.get(decorations);
  if (!parts) return decorations.update({ filterFrom: from, filterTo: to, filter, add, sort: true });
  // Use the same accepted ordering as a complete Decoration.set before
  // partitioning. Equal-position marks and controls can otherwise change
  // nesting when a locally rebuilt block replaces the complete presentation.
  const accepted: Range<Decoration>[] = [];
  for (const cursor = Decoration.set(add, true).iter(); cursor.value; cursor.next()) {
    accepted.push(cursor.value.range(cursor.from, cursor.to));
  }
  const nextParts = {
    stable: parts.stable.update({ filterFrom: from, filterTo: to, filter, add: accepted.filter(range => !range.value.point), sort: true }),
    points: parts.points.update({ filterFrom: from, filterTo: to, filter, add: accepted.filter(range => range.value.point && range.from === range.to), sort: true }),
    positioned: parts.positioned.update({ filterFrom: from, filterTo: to, filter, add: accepted.filter(range => range.value.point && range.from !== range.to), sort: true })
  };
  const result = RangeSet.join([nextParts.stable, nextParts.points, nextParts.positioned]);
  mappableSets.set(result, nextParts);
  return result;
}

/** Map after proving unchanged structure outside the dirty blocks and unchanged
 * global references. Undefined requests the existing bounded-input fallback. */
export function mapStableLiveDecorations(decorations: DecorationSet, changes: ChangeDesc, state: EditorState): {
  decorations: DecorationSet;
  rebasedWidgets: boolean;
} | undefined {
  let hasLaterDecorations = false;
  changes.iterChangedRanges(from => { hasLaterDecorations ||= !!decorations.iter(from).value; });
  if (!hasLaterDecorations) return { decorations, rebasedWidgets: false };
  if (decorations.size > maxProjectionDecorations && !mappableSets.has(decorations)) return;
  const parts = projectionParts(decorations);
  if (!parts) return;
  let rebasedWidgets = false;
  const mapPoints = (part: DecorationSet): DecorationSet => {
    const mapped = part.map(changes);
    const replacements = new Map<Decoration, Decoration>(), positions = new Set<number>();
    let first = Infinity, last = -Infinity;
    for (const cursor = mapped.iter(); cursor.value; cursor.next()) {
      const value = cursor.value;
      const widget = value.spec.widget as (WidgetType & LiveWidgetPositions) | undefined;
      if (!widget) continue;
      const next = widget[mapLiveWidgetPositions](changes, state);
      if (next === widget) continue;
      const spec = { ...value.spec, widget: next };
      replacements.set(value, cursor.from === cursor.to ? Decoration.widget(spec) : Decoration.replace(spec));
      positions.add(cursor.from); first = Math.min(first, cursor.from); last = Math.max(last, cursor.from);
    }
    if (!positions.size) return mapped;
    rebasedWidgets = true;
    // Replace complete same-position groups to preserve action/label ordering,
    // while keeping unchanged line-point chunks structurally shared.
    const add: Range<Decoration>[] = [];
    for (const position of positions) {
      for (const cursor = mapped.iter(position); cursor.value && cursor.from <= position; cursor.next()) {
        if (cursor.from === position) add.push((replacements.get(cursor.value) ?? cursor.value).range(cursor.from, cursor.to));
      }
    }
    return mapped.update({ filterFrom: first, filterTo: last, filter: from => !positions.has(from), add, sort: true });
  };
  const nextParts = { stable: parts.stable.map(changes), points: mapPoints(parts.points), positioned: mapPoints(parts.positioned) };
  // Rejoin even when widgets retain their identity. Mapping a joined set as
  // one layer loses the combined height-point summary when its first layer
  // contains only marks, which would hide widgets from height comparison.
  const result = RangeSet.join([nextParts.stable, nextParts.points, nextParts.positioned]);
  mappableSets.set(result, nextParts);
  return { decorations: result, rebasedWidgets };
}
