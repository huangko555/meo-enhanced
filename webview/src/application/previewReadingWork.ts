type Step = () => boolean | void;
type Retirement = 'retired' | 'failed';
type Work = { step: Step; cancel?: (reason: Retirement) => void };

/** Pending reading enrichment shares one admission budget and one viewport
 * transaction. The presentation owner retains frames, gestures and revisions. */
export function createPreviewReadingWork(options: {
  now(): number;
  batch(run: () => void): void;
  budgetMs?: number;
}) {
  const pending = new Map<object, Work>();
  const costs = new WeakMap<object, number>();
  const budget = options.budgetMs ?? 4;
  let generation = 0, draining = false;
  const cancel = (reason: Retirement = 'retired') => {
    generation++;
    const retired = [...pending.values()];
    pending.clear();
    for (const work of retired) work.cancel?.(reason);
  };
  return {
    request(key: object, step: Step) { pending.set(key, { step }); },
    commit(mutate: () => void, cancelled?: (reason: Retirement) => void): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        pending.set({}, { cancel(reason) {
          try { cancelled?.(reason); resolve(); } catch (error) { reject(error); }
        }, step() {
          try { mutate(); resolve(); } catch (error) { reject(error); }
        } });
      });
    },
    hasPending: () => pending.size > 0,
    cancel,
    drain(): boolean {
      if (draining || !pending.size) return pending.size > 0;
      const epoch = generation, seen = new Set<object>(), started = options.now();
      let ran = 0;
      draining = true;
      try {
        options.batch(() => {
          while (epoch === generation && ran < 8) {
            let next: [object, Work] | undefined;
            for (const entry of pending) if (!seen.has(entry[0])) { next = entry; break; }
            if (!next) break;
            const [key, work] = next;
            // Always admit one indivisible step. Measured costs keep later
            // known work out of a turn that no longer has room for it.
            if (ran && options.now() - started + (costs.get(key) ?? 1) >= budget) break;
            pending.delete(key); seen.add(key);
            const before = options.now();
            const more = work.step();
            costs.set(key, Math.max(0.25, options.now() - before));
            ran++;
            if (more && epoch === generation && !pending.has(key)) pending.set(key, work);
            if (options.now() - started >= budget) break;
          }
        });
      } catch (error) {
        cancel('failed');
        throw error;
      } finally { draining = false; }
      return pending.size > 0;
    }
  };
}
