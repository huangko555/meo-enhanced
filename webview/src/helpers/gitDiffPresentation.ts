import { Facet, type Text } from '@codemirror/state';

export interface MarkerFlags {
  added: boolean;
  modified: boolean;
  baselineLineNumber?: number;
  modifiedRanges?: Array<[number, number]>;
  deleted?: boolean;
  deletionBoundary?: number;
  deletionAtEnd?: boolean;
  baselineFromLine?: number;
  baselineToLine?: number;
  deletionRanges?: Array<[number, number]>;
  eofProxy?: boolean;
  trailingEofProxyOnly?: boolean;
  trailingEofProxySource?: boolean;
  liveBlockStartLine?: number;
  liveBlockEndLine?: number;
}

// Table widgets read the accepted comparison when they mount. Their canonical
// Markdown presentation may predate an asynchronous result (including offscreen
// tables), so copying flags into that presentation alone is insufficient.
type GitDiffPresentation = {
  readonly doc: Text;
  readonly lines: readonly (MarkerFlags | undefined)[];
  readonly baseline: object;
  readonly baselineCurrent: boolean;
};

export const gitDiffLineFlagsFacet = Facet.define<
  GitDiffPresentation | undefined,
  GitDiffPresentation | undefined
>({ combine: values => values[0] });
