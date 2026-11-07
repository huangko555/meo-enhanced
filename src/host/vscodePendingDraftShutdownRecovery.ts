import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import type { PendingDraftRecovery } from '../application/pendingDraftRecovery';

export type PendingDraftShutdownStore = {
  read: () => readonly string[] | null;
  write: (copies: readonly string[]) => void;
};

export type PendingDraftShutdownRecovery = {
  watch(recovery: PendingDraftRecovery): void;
  restore(): Promise<void>;
  persistForShutdown(): void;
};

type PendingDraftShutdownRecoveryParams = {
  readonly store: PendingDraftShutdownStore;
  readonly openRecoveryCopy: (text: string) => Promise<void>;
};

type StoredCopies = { readonly schemaVersion: 1; readonly copies: readonly string[] };
const FILE_NAME = 'pending-draft-recovery.json';

function decodeCopies(value: unknown): readonly string[] | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<StoredCopies>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.copies) || !record.copies.every(copy => typeof copy === 'string')) return null;
  return Array.from(new Set(record.copies));
}

function createNodeStore(storageDirectory: string): PendingDraftShutdownStore {
  let observed: Array<{ readonly path: string; readonly contents: string }> = [];
  return {
    read: () => {
      observed = [];
      try {
        const copies = new Set<string>();
        for (const name of fs.readdirSync(storageDirectory)) {
          if (name !== FILE_NAME && name !== `${FILE_NAME}.next`
            && !/^pending-draft-recovery-[\da-f-]+\.json(?:\.next)?$/.test(name)) continue;
          const filePath = join(storageDirectory, name);
          try {
            const contents = fs.readFileSync(filePath, 'utf8');
            const decoded = decodeCopies(JSON.parse(contents));
            if (decoded === null) continue;
            observed.push({ path: filePath, contents });
            for (const copy of decoded) copies.add(copy);
          } catch { /* Retain unreadable or partial evidence; admit other valid files. */ }
        }
        return Array.from(copies);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        return code === 'ENOENT' ? [] : null;
      }
    },
    write: copies => {
      const previous = observed;
      if (copies.length > 0) {
        fs.mkdirSync(storageDirectory, { recursive: true });
        // Distinct files prevent two Extension Hosts sharing global storage
        // from replacing one another's only pending evidence. A complete .next
        // remains recoverable even if rename fails or shutdown interrupts it.
        const filePath = join(storageDirectory, `pending-draft-recovery-${randomUUID()}.json`);
        const temporary = `${filePath}.next`;
        const contents = JSON.stringify({ schemaVersion: 1, copies } satisfies StoredCopies);
        fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filePath);
        observed = [{ path: filePath, contents }];
      } else {
        observed = [];
      }
      // Consume only valid, unchanged files from the preceding read. Unknown
      // concurrent files and malformed evidence remain outside this capability.
      for (const entry of previous) {
        try {
          if (fs.readFileSync(entry.path, 'utf8') === entry.contents) fs.rmSync(entry.path, { force: true });
        } catch { /* Retaining a consumed copy may duplicate recovery, never lose it. */ }
      }
    }
  };
}

/**
 * Persists only the already-owned pending recovery candidates during a normal
 * Extension Host shutdown. It intentionally does not observe every keystroke
 * or write the original workspace document.
 */
export function createVscodePendingDraftShutdownRecovery(
  params: { readonly storageDirectory: string; readonly openRecoveryCopy: (text: string) => Promise<void> }
): PendingDraftShutdownRecovery {
  return createPendingDraftShutdownRecovery({ ...params, store: createNodeStore(params.storageDirectory) });
}

/** Testable shutdown coordinator; production storage is supplied by the VS Code wrapper above. */
export function createPendingDraftShutdownRecovery(
  params: PendingDraftShutdownRecoveryParams
): PendingDraftShutdownRecovery {
  const { store } = params;
  const watched = new Set<PendingDraftRecovery>();

  const refresh = (recovery: PendingDraftRecovery): void => {
    if (recovery.hasPending()) watched.add(recovery);
    else watched.delete(recovery);
  };

  const collect = (): readonly string[] => Array.from(new Set(Array.from(watched,
    recovery => recovery.captureForRestart()).flat()));

  return {
    watch(recovery) {
      refresh(recovery);
      recovery.onDidChangePending(() => refresh(recovery));
    },
    async restore() {
      const copies = store.read();
      if (copies === null || copies.length === 0) return;
      const remaining: string[] = [];
      for (const copy of copies) {
        try {
          await params.openRecoveryCopy(copy);
        } catch {
          remaining.push(copy);
        }
      }
      const restored = new Set(copies.filter(copy => !remaining.includes(copy)));
      // A failed write intentionally leaves the old artifact in place. That can
      // duplicate a restored copy after another restart, but never loses it.
      // Shutdown can run while opening a recovery document. Re-read the store
      // so a newer candidate written by that shutdown is never overwritten by
      // this older startup cleanup.
      const latest = store.read();
      if (latest === null) return;
      try { store.write(latest.filter(copy => !restored.has(copy))); } catch { /* Preserve the prior artifact. */ }
    },
    persistForShutdown() {
      const existing = store.read();
      // The Node store never replaces unreadable evidence. Even when listing
      // older files failed, try to preserve newly confirmed candidates.
      const copies = Array.from(new Set([...(existing ?? []), ...collect()]));
      if (copies.length === 0 && (existing === null || existing.length === 0)) return;
      try { store.write(copies); } catch { /* Shutdown cannot safely retry I/O. */ }
    }
  };
}
