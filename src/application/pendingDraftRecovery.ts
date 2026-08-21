export type PendingDraftRecovery = {
  /** Replaces the recovery candidate; null explicitly clears it. */
  remember(draftText: string | null): number;
  /** Clears only the candidate that has not changed since the supplied receipt version. */
  discardIfCurrent(receiptVersion: number): boolean;
  /** Applies the latest non-equivalent candidate and clears it only after success. */
  recover(): Promise<boolean>;
};

export type PendingDraftRecoveryDependencies = {
  readonly readCurrentText: () => string;
  readonly applyDraft: (expectedCurrentText: string, draftText: string) => Promise<boolean>;
};

const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');

/** Owns only best-effort close/crash recovery, never Document Session Draft truth. */
export function createPendingDraftRecovery(
  dependencies: PendingDraftRecoveryDependencies
): PendingDraftRecovery {
  let pendingDraftText: string | null = null;
  let version = 0;

  return {
    remember(draftText) {
      pendingDraftText = draftText;
      version += 1;
      return version;
    },
    discardIfCurrent(receiptVersion) {
      if (receiptVersion !== version) return false;
      pendingDraftText = null;
      return true;
    },
    async recover() {
      const draftText = pendingDraftText;
      if (draftText === null) return false;

      const currentText = dependencies.readCurrentText();
      if (normalizeLineEndings(currentText) === normalizeLineEndings(draftText)) {
        pendingDraftText = null;
        return false;
      }

      const applied = await dependencies.applyDraft(currentText, draftText);
      if (applied) pendingDraftText = null;
      return applied;
    }
  };
}
