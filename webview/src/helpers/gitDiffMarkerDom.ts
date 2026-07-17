export interface GitDiffMarkerFlags {
  added?: boolean;
  modified?: boolean;
  modifiedRanges?: Array<[number, number]>;
  deleted?: boolean;
  deletionBoundary?: number;
  deletionAtEnd?: boolean;
  baselineFromLine?: number;
  baselineToLine?: number;
  deletionRanges?: Array<[number, number]>;
  eofProxy?: boolean;
  liveBlockStartLine?: number;
  liveBlockEndLine?: number;
}

const markerDataKeys = [
  'meoLiveBlockStartLine',
  'meoLiveBlockEndLine',
  'meoModifiedRanges',
  'meoDeletionBoundary',
  'meoBaselineFromLine',
  'meoBaselineToLine',
  'meoDeletionRanges'
] as const;

export function updateGitDiffMarkerElement(
  element: HTMLElement,
  flags: GitDiffMarkerFlags,
  extraClassName = ''
): HTMLElement {
  element.className = ['meo-git-gutter-marker', extraClassName].filter(Boolean).join(' ');
  for (const key of markerDataKeys) delete element.dataset[key];
  if (Number.isInteger(flags.liveBlockStartLine)) {
    element.dataset.meoLiveBlockStartLine = String(flags.liveBlockStartLine);
  }
  if (Number.isInteger(flags.liveBlockEndLine)) {
    element.dataset.meoLiveBlockEndLine = String(flags.liveBlockEndLine);
  }
  element.classList.toggle('is-eof-proxy', flags.eofProxy === true);
  element.classList.toggle('is-added', flags.added === true);
  element.classList.toggle('is-modified', flags.modified === true);
  element.classList.toggle('is-deleted', flags.deleted === true);
  element.classList.toggle('is-deleted-at-end', flags.deletionAtEnd === true);
  element.classList.toggle('is-empty', !flags.added && !flags.modified && !flags.deleted);
  if (flags.modifiedRanges?.length) element.dataset.meoModifiedRanges = JSON.stringify(flags.modifiedRanges);
  if (Number.isInteger(flags.deletionBoundary)) element.dataset.meoDeletionBoundary = String(flags.deletionBoundary);
  if (Number.isInteger(flags.baselineFromLine)) element.dataset.meoBaselineFromLine = String(flags.baselineFromLine);
  if (Number.isInteger(flags.baselineToLine)) element.dataset.meoBaselineToLine = String(flags.baselineToLine);
  if (flags.deletionRanges?.length) element.dataset.meoDeletionRanges = JSON.stringify(flags.deletionRanges);

  let stripe = element.querySelector<HTMLElement>(':scope > .meo-git-gutter-stripe');
  if (!stripe) {
    stripe = document.createElement('span');
    stripe.className = 'meo-git-gutter-stripe';
    element.appendChild(stripe);
  }
  return element;
}

export function createGitDiffMarkerElement(flags: GitDiffMarkerFlags): HTMLElement {
  return updateGitDiffMarkerElement(document.createElement('span'), flags);
}
