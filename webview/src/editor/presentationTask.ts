/** Yield an actual browser task so input and paint can run between work slices. */
export function yieldForPresentation(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { postTask(callback: () => void, options: { priority: 'user-visible' }): Promise<void> }
  }).scheduler;
  if (scheduler?.postTask) return scheduler.postTask(() => {}, { priority: 'user-visible' });
  return new Promise(resolve => setTimeout(resolve, 0));
}
