import { decodeRequestResult, type RequestResult } from './requestResult';

export const GIT_BLAME_TIMEOUT_MS = 8_000;

export type GitBaselinePayload = {
  readonly available: boolean;
  readonly mode?: 'current-edit' | 'recent-save' | 'git-head' | 'fixed';
  readonly generation?: number;
  readonly repoRoot?: string;
  readonly headOid?: string | null;
  readonly tracked: boolean;
  readonly gitPath?: string;
  readonly baseText?: string | null;
  readonly reason?: 'not-file' | 'git-unavailable' | 'not-repo' | 'ignored' | 'too-large' | 'binary' | 'error' | 'no-baseline';
  readonly maxBytesExceeded?: boolean;
};

export type GitBaselineChangedEvent = {
  readonly type: 'gitBaselineChanged';
  readonly version: number;
  readonly payload: GitBaselinePayload;
};

export type GitBlameLineResult =
  | {
      readonly kind: 'commit';
      readonly commit: string;
      readonly shortCommit: string;
      readonly originalLineNumber?: number;
      readonly gitPathAtCommit?: string;
      readonly author: string;
      readonly authorMail?: string;
      readonly authorTimeUnix: number;
      readonly summary: string;
    }
  | { readonly kind: 'uncommitted' }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'not-repo' | 'untracked' | 'git-unavailable' | 'error';
    };

export type GitBlameRequest = {
  readonly type: 'requestGitBlame';
  readonly requestId: string;
  readonly lineNumber: number;
  readonly text?: string;
  readonly localEditGeneration: number;
};

export type GitNavigationCommand =
  | { readonly type: 'openGitRevisionForLine'; readonly lineNumber: number; readonly text?: string }
  | { readonly type: 'openGitWorktreeForLine'; readonly lineNumber: number; readonly text?: string };

export type GitBlameResolution = RequestResult<GitBlameLineResult>;

export type GitBlameResponse = {
  readonly type: 'gitBlameResult';
  readonly requestId: string;
  readonly lineNumber: number;
  readonly localEditGeneration: number;
  readonly result: GitBlameResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1;
}

function decodeGitBlameLineResult(value: unknown): GitBlameLineResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'uncommitted') return { kind: 'uncommitted' };
  if (value.kind === 'unavailable'
    && (value.reason === 'not-repo' || value.reason === 'untracked'
      || value.reason === 'git-unavailable' || value.reason === 'error')) {
    return { kind: 'unavailable', reason: value.reason };
  }
  if (value.kind !== 'commit'
    || !isNonEmptyString(value.commit)
    || !isNonEmptyString(value.shortCommit)
    || !isNonEmptyString(value.author)
    || typeof value.authorTimeUnix !== 'number'
    || !Number.isFinite(value.authorTimeUnix)
    || typeof value.summary !== 'string'
    || (value.originalLineNumber !== undefined && !isPositiveInteger(value.originalLineNumber))
    || (value.gitPathAtCommit !== undefined && typeof value.gitPathAtCommit !== 'string')
    || (value.authorMail !== undefined && typeof value.authorMail !== 'string')) return null;
  return value as GitBlameLineResult;
}

export function decodeGitBlameRequest(value: unknown): GitBlameRequest | null {
  if (!isRecord(value)
    || value.type !== 'requestGitBlame'
    || !isNonEmptyString(value.requestId)
    || !isPositiveInteger(value.lineNumber)
    || !isNonNegativeInteger(value.localEditGeneration)
    || (value.text !== undefined && typeof value.text !== 'string')) return null;
  return value as GitBlameRequest;
}

export function decodeGitNavigationCommand(value: unknown): GitNavigationCommand | null {
  if (!isRecord(value)
    || (value.type !== 'openGitRevisionForLine' && value.type !== 'openGitWorktreeForLine')
    || !isPositiveInteger(value.lineNumber)
    || (value.text !== undefined && typeof value.text !== 'string')) return null;
  return value as GitNavigationCommand;
}

export function decodeGitBlameResponse(value: unknown): GitBlameResponse | null {
  const result = isRecord(value) ? decodeRequestResult(value.result, decodeGitBlameLineResult) : null;
  if (!isRecord(value)
    || value.type !== 'gitBlameResult'
    || !isNonEmptyString(value.requestId)
    || !isPositiveInteger(value.lineNumber)
    || !isNonNegativeInteger(value.localEditGeneration)
    || result === null) return null;
  return {
    type: 'gitBlameResult', requestId: value.requestId, lineNumber: value.lineNumber,
    localEditGeneration: value.localEditGeneration, result
  };
}

export function decodeGitBaselineChangedEvent(value: unknown): GitBaselineChangedEvent | null {
  if (!isRecord(value)
    || value.type !== 'gitBaselineChanged'
    || !isNonNegativeInteger(value.version)
    || !isRecord(value.payload)
    || typeof value.payload.available !== 'boolean'
    || typeof value.payload.tracked !== 'boolean') return null;
  const payload = value.payload;
  const modes = ['current-edit', 'recent-save', 'git-head', 'fixed'];
  const reasons = ['not-file', 'git-unavailable', 'not-repo', 'ignored', 'too-large', 'binary', 'error', 'no-baseline'];
  if ((payload.mode !== undefined && !modes.includes(payload.mode as string))
    || (payload.generation !== undefined && !isNonNegativeInteger(payload.generation))
    || (payload.repoRoot !== undefined && typeof payload.repoRoot !== 'string')
    || (payload.headOid !== undefined && payload.headOid !== null && typeof payload.headOid !== 'string')
    || (payload.gitPath !== undefined && typeof payload.gitPath !== 'string')
    || (payload.baseText !== undefined && payload.baseText !== null && typeof payload.baseText !== 'string')
    || (payload.reason !== undefined && !reasons.includes(payload.reason as string))
    || (payload.maxBytesExceeded !== undefined && typeof payload.maxBytesExceeded !== 'boolean')) return null;
  return value as GitBaselineChangedEvent;
}
