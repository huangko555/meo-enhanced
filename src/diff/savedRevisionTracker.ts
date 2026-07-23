import { createHash } from 'node:crypto';

export type SavedTextSnapshot = {
  text: string;
  contentHash: string;
};

export type SavedRevisionTrackerOptions = {
  mergeWindowMs?: number;
};

export type SavedRevisionDiffMode = 'current-edit' | 'recent-save';

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
  private pinnedBaseline: SavedTextSnapshot | null = null;
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

  noteExplicitSave(text: string, previousDisk: SavedTextSnapshot | null): boolean {
    const next = snapshot(text);
    if (!previousDisk) {
      const changed = next.contentHash !== this.latestDisk?.contentHash || this.recentSaveBaseline !== null;
      this.latestDisk = next;
      this.recentSaveBaseline = null;
      this.lastDiskRevisionAt = null;
      if (changed) {
        this.generation += 1;
      }
      return changed;
    }

    const changed = next.contentHash !== this.latestDisk?.contentHash ||
      previousDisk.contentHash !== this.recentSaveBaseline?.contentHash;
    this.latestDisk = next;
    this.recentSaveBaseline = previousDisk;
    this.lastDiskRevisionAt = null;
    if (changed) {
      this.generation += 1;
    }
    return changed;
  }

  getCurrentEditBaseline(): SavedTextSnapshot | null {
    return this.latestDisk;
  }

  getRecentSaveBaseline(): SavedTextSnapshot | null {
    return this.recentSaveBaseline;
  }

  pinLatestSavedBaseline(): SavedTextSnapshot | null {
    if (!this.latestDisk) {
      return null;
    }
    this.pinnedBaseline = this.latestDisk;
    return this.pinnedBaseline;
  }

  releasePinnedBaseline(): boolean {
    if (!this.pinnedBaseline) {
      return false;
    }
    this.pinnedBaseline = null;
    return true;
  }

  getPinnedBaseline(): SavedTextSnapshot | null {
    return this.pinnedBaseline;
  }

  getDiffBaseline(mode: SavedRevisionDiffMode): SavedTextSnapshot | null {
    if (mode === 'recent-save') {
      return this.recentSaveBaseline ?? this.latestDisk;
    }
    return this.latestDisk;
  }

  getGeneration(): number {
    return this.generation;
  }
}
