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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
