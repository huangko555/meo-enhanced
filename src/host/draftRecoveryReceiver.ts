import type { PendingDraftRecovery } from '../application/pendingDraftRecovery';
import type { DraftRecoveryMessage } from '../protocol/documentSync';

/** Reassembles ordered transport checkpoints before handing complete text to recovery. */
export function createDraftRecoveryReceiver(
  recovery: Pick<PendingDraftRecovery, 'remember'>,
  requestSnapshot: () => void | boolean | PromiseLike<void | boolean>
): { accept(message: DraftRecoveryMessage): number } {
  let checkpoint: { text: string; receiptVersion: number } | null = null;
  let receiptVersion = 0;
  let snapshotRequested = false;
  return {
    accept(message) {
      if (message.receiptVersion <= receiptVersion) return receiptVersion;
      let text: string | null;
      let candidate: Parameters<PendingDraftRecovery['remember']>[0] = null;
      if (message.type === 'draftChanged') {
        text = message.text;
        if (message.text !== null) {
          candidate = message.conflictBaseText === undefined
            ? { type: 'draft', baseVersion: message.baseVersion, text: message.text }
            : { type: 'conflict', baseVersion: message.baseVersion, baseText: message.conflictBaseText, text: message.text };
        }
      } else {
        const changes = message.changes ?? [message.change];
        if (!checkpoint || message.baseReceiptVersion !== checkpoint.receiptVersion
          || changes.some((change, index) => change.to > checkpoint!.text.length
            || (index > 0 && change.from < changes[index - 1]!.to))) {
          // Never guess at a missing base, advance the receipt, or discard the
          // last intact candidate. A complete latest snapshot repairs the stream.
          if (!snapshotRequested) {
            snapshotRequested = true;
            void Promise.resolve().then(requestSnapshot).then(delivered => {
              if (delivered === false) snapshotRequested = false;
            }, () => { snapshotRequested = false; });
          }
          return receiptVersion;
        }
        const parts: string[] = [];
        let from = 0;
        for (const change of changes) {
          parts.push(checkpoint.text.slice(from, change.from), change.insert);
          from = change.to;
        }
        parts.push(checkpoint.text.slice(from));
        text = parts.join('');
        candidate = { type: 'draft', baseVersion: message.baseVersion, text };
      }
      recovery.remember(candidate, message.receiptVersion);
      receiptVersion = message.receiptVersion;
      if (text !== null) checkpoint = { text, receiptVersion: message.receiptVersion };
      snapshotRequested = false;
      return receiptVersion;
    }
  };
}
