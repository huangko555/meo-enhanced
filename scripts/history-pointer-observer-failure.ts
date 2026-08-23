import { HistoryModePointerTransactionError } from "./history-mode-pointer-transaction";
import { HistoryPointerEventObserverLifecycleError } from "./history-pointer-event-observer";

export function historyPointerObserverPrimary(error: unknown): unknown {
  if (error instanceof HistoryModePointerTransactionError) return error;
  if (error instanceof HistoryPointerEventObserverLifecycleError) {
    return error.errors[0];
  }
  return error;
}
