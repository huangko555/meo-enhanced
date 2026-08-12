/** Git-side baseline model. Protocol-only mode and generation fields are added by the output Adapter. */
export type GitBaselinePayload = {
  readonly available: boolean;
  readonly repoRoot?: string;
  readonly headOid?: string | null;
  readonly tracked: boolean;
  readonly gitPath?: string;
  readonly baseText?: string | null;
  readonly reason?: 'not-file' | 'git-unavailable' | 'not-repo' | 'ignored' | 'too-large' | 'binary' | 'error' | 'no-baseline';
  readonly maxBytesExceeded?: boolean;
};

export type GitBaselineSnapshot = {
  payload: GitBaselinePayload;
};

export class GitCliFailure extends Error {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly spawnErrorCode?: string;

  constructor(message: string, options: {
    code?: number | null;
    stdout?: Buffer;
    stderr?: Buffer;
    spawnErrorCode?: string;
  } = {}) {
    super(message);
    this.name = 'GitCliFailure';
    this.code = options.code ?? null;
    this.stdout = options.stdout ?? Buffer.alloc(0);
    this.stderr = options.stderr ?? Buffer.alloc(0);
    this.spawnErrorCode = options.spawnErrorCode;
  }
}
