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
