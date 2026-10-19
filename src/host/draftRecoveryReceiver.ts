import type { PendingDraftRecovery } from '../application/pendingDraftRecovery';
import type { DraftRecoveryMessage } from '../protocol/documentSync';

/** Reassembles ordered transport checkpoints before handing complete text to recovery. */
export function createDraftRecoveryReceiver(
  recovery: PendingDraftRecovery,
  requestSnapshot: () => void | boolean | PromiseLike<void | boolean>
): { accept(message: DraftRecoveryMessage): number } {
  let checkpoint: { text: string; receiptVersion: number } | null = null;
  let receiptVersion = 0;
  let snapshotRequested = false;
  return {
    accept(message) {
      if (message.receiptVersion <= receiptVersion) return receiptVersion;
      let text: string | null;
      if (message.type === 'draftChanged') {
        text = message.text;
      } else {
        if (!checkpoint || message.baseReceiptVersion !== checkpoint.receiptVersion
          || message.change.to > checkpoint.text.length) {
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
        const { from, to, insert } = message.change;
        text = checkpoint.text.slice(0, from) + insert + checkpoint.text.slice(to);
      }
      receiptVersion = recovery.remember(text, message.receiptVersion);
      if (text !== null) checkpoint = { text, receiptVersion: message.receiptVersion };
      snapshotRequested = false;
      return receiptVersion;
    }
  };
}
