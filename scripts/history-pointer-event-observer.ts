export const historyPointerEventTypes = ["pointerdown", "pointerup", "click"] as const;

export type HistoryPointerEventType = typeof historyPointerEventTypes[number];
export type HistoryPointerEventRole = "old" | "replacement" | "document";

export class HistoryPointerEventObserverLifecycleError extends AggregateError {
  constructor(primary: unknown, cleanupErrors: unknown[]) {
    super([primary, ...cleanupErrors], "History pointer observer lifecycle failed", { cause: primary });
    this.name = "HistoryPointerEventObserverLifecycleError";
  }
}

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;
type EvidenceTarget = { dataset: Record<string, string | undefined> };

export type HistoryPointerEventObserverState = {
  direct: Record<Exclude<HistoryPointerEventRole, "document">, Record<HistoryPointerEventType, number>>;
  documentEvents: string[];
  registrations: number;
  cleanupCalls: number;
  cleaned: boolean;
  sentinelVerified: boolean;
};

type Registration = {
  readonly role: HistoryPointerEventRole;
  readonly type: HistoryPointerEventType;
  readonly target: ListenerTarget;
  readonly listener: EventListener;
};

export function createHistoryPointerEventObserverRegistry(evidence: EvidenceTarget) {
  const eventTypes = ["pointerdown", "pointerup", "click"] as const;
  const emptyDirectCount = () => ({ pointerdown: 0, pointerup: 0, click: 0 });
  const direct = { old: emptyDirectCount(), replacement: emptyDirectCount() };
  const documentEvents: string[] = [];
  const registrations: Registration[] = [];
  let replacement: Element | null = null;
  let cleanupCalls = 0;
  let cleaned = false;
  let sentinelVerified = false;
  const observedTargets = new Set<ListenerTarget>();

  const snapshot = (): HistoryPointerEventObserverState => ({
    direct: {
      old: { ...direct.old },
      replacement: { ...direct.replacement }
    },
    documentEvents: [...documentEvents],
    registrations: registrations.length,
    cleanupCalls,
    cleaned,
    sentinelVerified
  });
  const publish = () => {
    evidence.dataset.historyPointerObserver = JSON.stringify(snapshot());
  };
  const documentCategory = (event: Event) => {
    const target = event.target;
    if (typeof Element === "undefined" || !(target instanceof Element)) return "other";
    return target.closest("button") === replacement ? "replacement" : "other";
  };

  return {
    observe(role: HistoryPointerEventRole, target: ListenerTarget) {
      if (cleaned) throw new Error("History pointer observer registry is already cleaned");
      for (const type of eventTypes) {
        const listener: EventListener = (event) => {
          if (role === "document") documentEvents.push(`${type}:${documentCategory(event)}`);
          else direct[role][type] += 1;
          publish();
        };
        target.addEventListener(type, listener, { capture: true });
        registrations.push({ role, type, target, listener });
      }
      observedTargets.add(target);
      publish();
    },
    setReplacement(target: Element) {
      replacement = target;
      publish();
    },
    cleanup() {
      cleanupCalls += 1;
      if (cleaned) {
        publish();
        return;
      }
      cleaned = true;
      const pending = registrations.splice(0, registrations.length);
      const errors: unknown[] = [];
      for (const registration of pending) {
        try {
          registration.target.removeEventListener(registration.type, registration.listener, { capture: true });
        } catch (error) {
          errors.push(new Error(`History pointer observer cleanup failed: ${registration.role}:${registration.type}`, {
            cause: error
          }));
        }
      }
      publish();
      if (errors.length > 0) {
        throw new AggregateError(errors, "History pointer observer cleanup failed", { cause: errors[0] });
      }
    },
    verifySentinel() {
      if (!cleaned || registrations.length !== 0) return false;
      const before = JSON.stringify(snapshot());
      for (const target of observedTargets) {
        for (const type of eventTypes) target.dispatchEvent(new Event(type));
      }
      const silent = JSON.stringify(snapshot()) === before;
      sentinelVerified = silent;
      publish();
      return silent;
    },
    snapshot
  };
}

export async function runHistoryPointerEventObserverLifecycle(operations: {
  setup(): Promise<void>;
  execute(): Promise<void>;
  cleanup(): Promise<void>;
}) {
  let primary: unknown;
  let hasPrimary = false;
  try {
    await operations.setup();
    await operations.execute();
  } catch (error) {
    primary = error;
    hasPrimary = true;
  }

  let cleanup: unknown;
  let hasCleanup = false;
  try {
    await operations.cleanup();
  } catch (error) {
    cleanup = error;
    hasCleanup = true;
  }

  if (hasPrimary && hasCleanup) {
    const cleanupErrors = cleanup instanceof AggregateError ? [...cleanup.errors] : [cleanup];
    throw new HistoryPointerEventObserverLifecycleError(primary, cleanupErrors);
  }
  if (hasPrimary) throw primary;
  if (hasCleanup) throw cleanup;
}
