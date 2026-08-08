import type {
  GitBaselinePayload as ProtocolGitBaselinePayload,
  GitBlameLineResult as ProtocolGitBlameLineResult
} from '../protocol/git';

export type GitBaselinePayload = ProtocolGitBaselinePayload;

export type GitBaselineSnapshot = {
  payload: GitBaselinePayload;
};

export type GitBlameLineResult = ProtocolGitBlameLineResult;

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
