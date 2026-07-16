import { createHash } from 'node:crypto';

export type SavedTextSnapshot = {
  text: string;
  contentHash: string;
};

export type SavedRevisionTrackerOptions = {
  mergeWindowMs?: number;
};

function snapshot(text: string): SavedTextSnapshot {
  return {
    text,
    contentHash: createHash('sha1').update(text).digest('hex')
  };
}

export class SavedRevisionTracker {
  private readonly mergeWindowMs: number;
  private latestDisk: SavedTextSnapshot | null = null;
  private recentSaveBaseline: SavedTextSnapshot | null = null;
  private lastDiskRevisionAt: number | null = null;
  private generation = 0;

  constructor(options: SavedRevisionTrackerOptions = {}) {
    this.mergeWindowMs = Math.max(0, options.mergeWindowMs ?? 10_000);
  }

  initialize(text: string): boolean {
    const next = snapshot(text);
    if (next.contentHash === this.latestDisk?.contentHash) {
      return false;
    }
    this.latestDisk = next;
    this.recentSaveBaseline = null;
    this.lastDiskRevisionAt = null;
    this.generation += 1;
    return true;
  }

  noteDiskRevision(text: string, observedAt = Date.now()): boolean {
    const next = snapshot(text);
    if (next.contentHash === this.latestDisk?.contentHash) {
      return false;
    }
    if (!this.latestDisk) {
      return this.initialize(text);
    }

    if (
      this.lastDiskRevisionAt === null ||
      observedAt - this.lastDiskRevisionAt > this.mergeWindowMs
    ) {
      this.recentSaveBaseline = this.latestDisk;
    }
    this.latestDisk = next;
    this.lastDiskRevisionAt = observedAt;
    this.generation += 1;
    return true;
  }

  getCurrentEditBaseline(): SavedTextSnapshot | null {
    return this.latestDisk;
  }

  getRecentSaveBaseline(): SavedTextSnapshot | null {
    return this.recentSaveBaseline;
  }

  getGeneration(): number {
    return this.generation;
  }
}
