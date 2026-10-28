export type ChangesReviewUnavailableReason =
  | 'not-file'
  | 'git-unavailable'
  | 'not-repo'
  | 'ignored'
  | 'too-large'
  | 'binary'
  | 'error'
  | 'no-baseline'
  | 'timeout';

export type ChangesReviewDiffSummary =
  | { readonly status: 'pending'; readonly added: 0; readonly deleted: 0 }
  | { readonly status: 'ready'; readonly added: number; readonly deleted: number }
  | {
      readonly status: 'unavailable';
      readonly reason: ChangesReviewUnavailableReason;
      readonly added: 0;
      readonly deleted: 0;
    };

export type ChangesReviewBaseline = 'current-edit' | 'recent-save' | 'git-head' | 'manual';

/** Identifies the comparison that produced a summary, independently of the current selection. */
export type ChangesReviewComparison = {
  readonly baseline: ChangesReviewBaseline;
  readonly generation: number;
};
