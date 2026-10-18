import type { ChangeDesc, EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type WidgetType } from '@codemirror/view';

/** Only for proven plain-prose changes outside widgets, with no line changes.
 * Return an immutable replacement, or the same widget when its positions stay
 * valid. Unknown widgets conservatively keep the authoritative rebuild path.
 */
export const mapLiveWidgetPositions = Symbol('mapLiveWidgetPositions');
interface LiveWidgetPositions {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType;
}

// Replacing every position-bearing widget can cost more than the existing
// bounded input projection on very dense files. Keep this input-frame work
// bounded independently of the document-size policy.
const maxProjectionDecorations = 4_096;
const maxProjectionWidgets = 512;
const mappableSets = new WeakMap<DecorationSet, boolean>();

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
  let supported = mappableSets.get(decorations);
  if (supported === undefined) {
    supported = true;
    let widgets = 0;
    for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget as (WidgetType & Partial<LiveWidgetPositions>) | undefined;
      if (widget && (++widgets > maxProjectionWidgets || typeof widget[mapLiveWidgetPositions] !== 'function'
        || (cursor.from === cursor.to && !('side' in cursor.value.spec)))) { supported = false; break; }
    }
    mappableSets.set(decorations, supported);
  }
  if (!supported) return;
  const mapped = decorations.map(changes);
  const ranges: Range<Decoration>[] = [];
  let rebasedWidgets = false;
  for (const cursor = mapped.iter(); cursor.value; cursor.next()) {
    const value = cursor.value;
    const widget = value.spec.widget as (WidgetType & LiveWidgetPositions) | undefined;
    if (!widget) { ranges.push(value.range(cursor.from, cursor.to)); continue; }
    const next = widget[mapLiveWidgetPositions](changes, state);
    if (next === widget) { ranges.push(value.range(cursor.from, cursor.to)); continue; }
    const spec = { ...value.spec, widget: next };
    const decoration = cursor.from === cursor.to ? Decoration.widget(spec) : Decoration.replace(spec);
    ranges.push(decoration.range(cursor.from, cursor.to));
    rebasedWidgets = true;
  }
  // Preserve the original order of widgets sharing a position and side (code
  // labels/actions, for example). Removing/re-adding only one reorders its DOM.
  const result = rebasedWidgets ? Decoration.set(ranges, true) : mapped;
  mappableSets.set(result, true);
  return { decorations: result, rebasedWidgets };
}
