export type DraftRecoveryCandidate =
  | {
      readonly type: 'draft';
      readonly baseVersion: number;
      readonly text: string;
    }
  | {
      readonly type: 'conflict';
      readonly baseVersion: number;
      readonly baseText: string;
      readonly text: string;
    };

export type PendingDraftRecovery = {
  /** Replaces the candidate only for a newer receipt; null explicitly clears it. */
  remember(candidate: DraftRecoveryCandidate | null, receiptVersion: number): number;
  /** Clears only the candidate that has not changed since the supplied receipt version. */
  discardIfCurrent(receiptVersion: number): boolean;
  /** True when no terminal path has yet durably settled the latest candidate. */
  hasPending(): boolean;
  /** Applies a base-matching candidate or preserves a base conflict without overwriting Host text. */
  recover(): Promise<boolean>;
  /** Terminal close/page handoff: failed apply falls back to an untitled preservation copy. */
  settleForTermination(): Promise<boolean>;
  /** Settles a retired candidate by equivalence or preservation without mutating active Host text. */
  preserveRetired(candidate: DraftRecoveryCandidate): Promise<boolean>;
};

type DraftRecoveryArtifact = {
  readonly replace: (copyText: string) => Promise<boolean>;
};
type CurrentRecoveryRevision = { readonly version: number; readonly text: string } | null;

export type PendingDraftRecoveryDependencies = {
  readonly readCurrentRevision: () => CurrentRecoveryRevision;
  /** Must reject a closed/replaced document or a changed revision before mutating Host text. */
  readonly applyDraft: (
    expected: { readonly version: number; readonly text: string },
    draftText: string
  ) => Promise<boolean>;
  /** Creates one recovery artifact; replacement must reject user-modified/closed artifacts. */
  readonly preserveConflict: (copyText: string) => Promise<false | DraftRecoveryArtifact>;
};

const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');

function formatConflictCopy(
  candidate: DraftRecoveryCandidate,
  current: { readonly version: number; readonly text: string } | null
): string {
  const base = candidate.type === 'conflict'
    ? `\n||||||| MEO base\n${candidate.baseText}` : '';
  const host = current === null
    ? '[Host document unavailable: the original document was closed before recovery.]'
    : current.text;
  const hostLabel = current === null
    ? 'Host current document unavailable'
    : `Host current revision ${current.version}`;
  return [
    `<<<<<<< MEO local recovery (base revision ${candidate.baseVersion})`,
    candidate.text,
    base,
    `=======\n${host}`,
    `>>>>>>> ${hostLabel}`
  ].join('\n');
}

/** Owns only best-effort close/crash recovery, never Document Session Draft truth. */
export function createPendingDraftRecovery(
  dependencies: PendingDraftRecoveryDependencies
): PendingDraftRecovery {
  let pendingCandidate: DraftRecoveryCandidate | null = null;
  let version = 0;
  let recovering: { readonly terminal: boolean; readonly promise: Promise<boolean> } | null = null;
  let retiredPreservation: Promise<void> = Promise.resolve();

  const clearHandled = (candidate: DraftRecoveryCandidate, receiptVersion: number): boolean => {
    if (version !== receiptVersion || pendingCandidate !== candidate) return false;
    pendingCandidate = null;
    return true;
  };

  const drainRecovery = async (terminal: boolean): Promise<boolean> => {
    let recovered = false;
    let artifact: DraftRecoveryArtifact | null = null;
    const preserve = async (candidate: DraftRecoveryCandidate, current: CurrentRecoveryRevision): Promise<boolean> => {
      const text = formatConflictCopy(candidate, current);
      if (artifact !== null) {
        try {
          if (await artifact.replace(text)) return true;
        } catch {
          // The existing buffer is no longer writable. Preserve the latest
          // candidate separately rather than overwrite user work or strand it
          // in a terminating owner. The old artifact is never modified again.
        }
        artifact = null;
      }
      const created = await dependencies.preserveConflict(text);
      if (created === false) return false;
      artifact = created;
      return true;
    };
    for (;;) {
      const candidate = pendingCandidate;
      const receiptVersion = version;
      if (candidate === null) return recovered;

      // Coalesce any receipt already queued in this turn before opening an
      // untitled buffer or applying a document edit. Panel teardown seals new
      // traffic, so a changed receipt after an await is a finite in-flight
      // handoff that this loop drains to its stable endpoint.
      await Promise.resolve();
      if (version !== receiptVersion || pendingCandidate !== candidate) continue;

      const current = dependencies.readCurrentRevision();
      if (artifact === null && current !== null && normalizeLineEndings(current.text) === normalizeLineEndings(candidate.text)) {
        clearHandled(candidate, receiptVersion);
        continue;
      }

      let handled: boolean;
      if (artifact !== null) {
        handled = await preserve(candidate, current);
      } else if (current !== null && candidate.type === 'draft' && current.version === candidate.baseVersion) {
        try {
          handled = await dependencies.applyDraft(current, candidate.text);
        } catch (error) {
          if (!terminal) throw error;
          handled = false;
        }
        if (!handled && terminal) {
          handled = await preserve(candidate, dependencies.readCurrentRevision());
        }
      } else {
        handled = await preserve(candidate, current);
      }
      if (!handled) return recovered;
      recovered = true;
      clearHandled(candidate, receiptVersion);
    }
  };

  const startRecovery = (terminal: boolean): Promise<boolean> => {
    if (recovering) {
      if (!terminal || recovering.terminal) return recovering.promise;
      return recovering.promise.then(
        () => startRecovery(true),
        () => startRecovery(true)
      );
    }
    const work = drainRecovery(terminal);
    const record: { terminal: boolean; promise: Promise<boolean> } = {
      terminal,
      promise: Promise.resolve(false)
    };
    const settled = work.finally(() => {
      if (recovering === record) recovering = null;
    });
    record.promise = settled;
    recovering = record;
    return settled;
  };

  return {
    remember(candidate, receiptVersion) {
      if (receiptVersion <= version) return version;
      pendingCandidate = candidate;
      version = receiptVersion;
      return version;
    },
    discardIfCurrent(receiptVersion) {
      if (receiptVersion !== version) return false;
      pendingCandidate = null;
      return true;
    },
    hasPending() {
      return pendingCandidate !== null;
    },
    recover() {
      return startRecovery(false);
    },
    settleForTermination() {
      return startRecovery(true);
    },
    preserveRetired(candidate) {
      const task = retiredPreservation.then(async () => {
        const current = dependencies.readCurrentRevision();
        if (current !== null && normalizeLineEndings(current.text) === normalizeLineEndings(candidate.text)) {
          return true;
        }
        return (await dependencies.preserveConflict(formatConflictCopy(candidate, current))) !== false;
      });
      retiredPreservation = task.then(() => undefined, () => undefined);
      return task;
    }
  };
}
