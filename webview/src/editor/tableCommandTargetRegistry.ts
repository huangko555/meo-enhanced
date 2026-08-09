import type {
  TableCommandEditorTarget,
  TableCommandTargetRegistration
} from './tableCommandAdapter';

export type TableCommandTargetRegistry = {
  resolve(id: string): TableCommandEditorTarget | null;
  register(target: TableCommandEditorTarget): TableCommandTargetRegistration;
  dispose(): void;
};

type TargetRecord = {
  target: TableCommandEditorTarget | null;
  identityKey: string;
  from: number;
  generation: number;
};

export function createTableCommandTargetRegistry(
  scheduleCleanup: (run: () => void) => void = queueMicrotask
): TableCommandTargetRegistry {
  const records = new Map<string, TargetRecord>();
  let targetSequence = 0;
  let disposed = false;

  const resolve = (id: string) => disposed ? null : records.get(id)?.target ?? null;

  const register = (target: TableCommandEditorTarget): TableCommandTargetRegistration => {
    if (disposed) return { id: '', dispose() {} };
    const reusable = [...records.entries()]
      .filter(([, record]) => (
        record.identityKey === target.identityKey &&
        (!record.target || !record.target.isConnected())
      ))
      .sort((left, right) => (
        Math.abs(left[1].from - target.from) - Math.abs(right[1].from - target.from)
      ))[0];
    const id = reusable?.[0] ?? `table-command-target-${++targetSequence}`;
    const generation = (reusable?.[1].generation ?? 0) + 1;
    records.set(id, {
      target,
      identityKey: target.identityKey,
      from: target.from,
      generation
    });
    let active = true;
    return {
      id,
      dispose() {
        if (!active || disposed) return;
        active = false;
        const record = records.get(id);
        if (record?.generation !== generation || record.target !== target) return;
        record.target = null;
        scheduleCleanup(() => {
          const current = records.get(id);
          if (!disposed && current?.generation === generation && current.target === null) {
            records.delete(id);
          }
        });
      }
    };
  };

  return {
    resolve,
    register,
    dispose() {
      if (disposed) return;
      disposed = true;
      records.clear();
    }
  };
}
