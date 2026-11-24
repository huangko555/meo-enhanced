import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { readDocumentTextProjection } from '../application/documentTextProjection';
import { createTextSearch } from '../application/searchCaseFolding';
import { isLiveInputDerivedWorkRefresh, mapLiveInputDerivedDecorations, shouldDeferLiveInputDerivedWork } from './liveInputDerivedWork';

export type SearchOptions = {
  wholeWord?: boolean;
  caseSensitive?: boolean;
};

type SearchQueryState = {
  text: string;
  wholeWord: boolean;
  caseSensitive: boolean;
};

export type SearchMatchRange = {
  start: number;
  end: number;
};

type SearchMatchFieldValue = {
  matches: SearchMatchRange[];
  decorations: DecorationSet;
};

const setSearchQueryEffect = StateEffect.define<SearchQueryState>();
type SearchMatchCalculation = { readonly query: SearchQueryState; readonly matches: SearchMatchRange[] };
// A command that has already calculated post-edit matches can hand that exact
// result to the decoration field. This prevents Source replacement from
// materializing and scanning the full post-edit document a second time.
const setSearchMatchesEffect = StateEffect.define<SearchMatchCalculation>();
const searchMatchStyle = 'color: var(--meo-semantic-searchMatchForeground) !important; -webkit-text-fill-color: var(--meo-semantic-searchMatchForeground) !important;';
const activeSearchMatchStyle = 'color: var(--meo-semantic-searchMatchActiveForeground) !important; -webkit-text-fill-color: var(--meo-semantic-searchMatchActiveForeground) !important;';
const searchMatchMark = Decoration.mark({ class: 'meo-search-match', attributes: { style: searchMatchStyle } });
const activeSearchMatchMark = Decoration.mark({ class: 'meo-search-match meo-search-match-active', attributes: { style: activeSearchMatchStyle } });

const setSearchAnchorEffect = StateEffect.define<SearchMatchRange | null>();
const searchAnchorField = StateField.define<SearchMatchRange | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(setSearchQueryEffect))) return null;
    for (const effect of tr.effects) if (effect.is(setSearchAnchorEffect)) return effect.value;
    return value;
  }
});

const buildSearchDecorations = (state: EditorState, matches: SearchMatchRange[]) => {
  if (!matches.length) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const selection = state.selection.main;
  const active = state.field(searchAnchorField);
  const selectionFrom = active?.start ?? Math.min(selection.from, selection.to);
  const selectionTo = active?.end ?? Math.max(selection.from, selection.to);
  for (const match of matches) {
    const mark = match.start === selectionFrom && match.end === selectionTo
      ? activeSearchMatchMark
      : searchMatchMark;
    builder.add(match.start, match.end, mark);
  }
  return builder.finish();
};

const searchQueryField = StateField.define({
  create() {
    return createSearchQueryState('');
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchQueryEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

const searchMatchField = StateField.define<SearchMatchFieldValue>({
  create() {
    return { matches: [], decorations: Decoration.none };
  },
  update(value, tr: Transaction) {
    let changedQuery: SearchQueryState | null = null;
    let calculated: SearchMatchCalculation | null = null;
    for (const effect of tr.effects) {
      if (effect.is(setSearchQueryEffect)) {
        changedQuery = effect.value;
      }
      if (effect.is(setSearchMatchesEffect)) calculated = effect.value;
    }

    // A new Find query must read the accepted document even if typing has not
    // flushed its decorations yet. Other input consumers retain their schedule.
    if (!changedQuery && !calculated && shouldDeferLiveInputDerivedWork(tr)) {
      if (!tr.docChanged) return value;
      const matches = value.matches.map((match) => ({
        start: tr.changes.mapPos(match.start, 1),
        end: tr.changes.mapPos(match.end, -1)
      })).filter((match) => match.end > match.start);
      return {
        matches,
        decorations: mapLiveInputDerivedDecorations(value.decorations, tr)
      };
    }

    if (tr.docChanged || changedQuery || isLiveInputDerivedWorkRefresh(tr)) {
      const searchQuery = changedQuery ?? tr.state.field(searchQueryField);
      const supplied = calculated
        && calculated.query.text === searchQuery.text
        && calculated.query.wholeWord === searchQuery.wholeWord
        && calculated.query.caseSensitive === searchQuery.caseSensitive
        ? calculated.matches : null;
      const matches = supplied ?? (searchQuery.text
        ? findSearchMatchRanges(readDocumentTextProjection(tr.state.doc), searchQuery.text, searchQuery)
        : []);
      return {
        matches,
        decorations: buildSearchDecorations(tr.state, matches)
      };
    }

    if (tr.selection || tr.effects.some(effect => effect.is(setSearchAnchorEffect))) {
      return {
        matches: value.matches,
        decorations: buildSearchDecorations(tr.state, value.matches)
      };
    }

    return value;
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  }
});

function createSearchQueryState(query: string | null | undefined, options: SearchOptions = {}): SearchQueryState {
  return {
    text: query ?? '',
    wholeWord: options.wholeWord === true,
    caseSensitive: options.caseSensitive === true
  };
}

function isWordBoundaryCharacter(value: string): boolean {
  return /[0-9A-Za-z_]/.test(value);
}

function isWholeWordRange(text: string, start: number, end: number): boolean {
  const previous = start > 0 ? text.slice(start - 1, start) : '';
  const next = end < text.length ? text.slice(end, end + 1) : '';
  return !isWordBoundaryCharacter(previous) && !isWordBoundaryCharacter(next);
}

function findSearchMatchRanges(text: string, query: string, options: SearchOptions = {}): SearchMatchRange[] {
  if (!query) {
    return [];
  }

  const nextMatch = createTextSearch(query, options.caseSensitive)(text);
  const matches: SearchMatchRange[] = [];
  for (let match = nextMatch(); match; match = nextMatch()) {
    if (!options.wholeWord || isWholeWordRange(text, match.start, match.end)) matches.push(match);
  }
  return matches;
}

function findSelectedSearchMatchIndex(matches: SearchMatchRange[], from: number, to: number): number {
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].start === from && matches[index].end === to) {
      return index;
    }
  }
  return -1;
}

/** Search projections stay in CodeMirror state; callers do not own its fields. */
export const editorSearch = {
  extension: [searchQueryField, searchAnchorField] as Extension,
  highlightExtension: Prec.high(searchMatchField),
  query: (state: EditorState) => state.field(searchQueryField),
  anchor: (state: EditorState) => state.field(searchAnchorField),
  matches: (state: EditorState) => state.field(searchMatchField).matches,
  queryChanged: (transaction: Transaction) => transaction.effects.some(effect => effect.is(setSearchQueryEffect)),
  anchorChanged: (transaction: Transaction) => transaction.effects.some(effect => effect.is(setSearchAnchorEffect)),
  queryEffect: (query: SearchQueryState) => setSearchQueryEffect.of(query),
  anchorEffect: (match: SearchMatchRange | null) => setSearchAnchorEffect.of(match),
  calculatedMatchesEffect: (query: SearchQueryState, matches: SearchMatchRange[]) => setSearchMatchesEffect.of({ query, matches }),
  normalizeQuery: createSearchQueryState,
  findMatches: findSearchMatchRanges,
  selectedMatchIndex: findSelectedSearchMatchIndex
};
