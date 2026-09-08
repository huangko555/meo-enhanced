export type ReadingPosition = {
  readonly line: number;
  readonly lineOffset: number;
};

type StoredReadingPosition = ReadingPosition & {
  readonly updatedAt: number;
};

type ReadingPositionStorage = {
  read(): unknown;
  update(
    transform: (current: unknown) => Readonly<Record<string, StoredReadingPosition>>
  ): Promise<void>;
};

export type ReadingPositionPort = {
  readInitial(): ReadingPosition | null;
  remember(position: ReadingPosition): Promise<void>;
};

type ReadingPositionMemoryDependencies = {
  readonly documentKey: string | null;
  readonly getDocumentLineCount: () => number;
  readonly isEnabled: () => boolean;
  readonly storage: ReadingPositionStorage;
  readonly now?: () => number;
  readonly capacity?: number;
};

const DEFAULT_CAPACITY = 300;
const MAX_LINE_OFFSET = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizePosition = (value: unknown, lineCount: number): ReadingPosition | null => {
  if (!isRecord(value)
    || typeof value.line !== 'number'
    || !Number.isInteger(value.line)
    || value.line < 1
    || typeof value.lineOffset !== 'number'
    || !Number.isFinite(value.lineOffset)
    || value.lineOffset < 0) {
    return null;
  }
  return {
    line: Math.min(value.line, Math.max(1, Math.floor(lineCount))),
    lineOffset: Math.min(MAX_LINE_OFFSET, Math.round(value.lineOffset * 100) / 100)
  };
};

const readStoredPositions = (value: unknown): Record<string, StoredReadingPosition> => {
  if (!isRecord(value)) return {};
  const decoded = Object.create(null) as Record<string, StoredReadingPosition>;
  for (const [key, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)
      || typeof candidate.updatedAt !== 'number'
      || !Number.isFinite(candidate.updatedAt)) continue;
    const position = normalizePosition(candidate, Number.MAX_SAFE_INTEGER);
    if (!position) continue;
    decoded[key] = { ...position, updatedAt: candidate.updatedAt };
  }
  return decoded;
};

const positionKey = (position: ReadingPosition): string => `${position.line}:${position.lineOffset}`;

/** Owns bounded, workspace-scoped reading-position persistence and validation. */
export function createReadingPositionMemory(
  dependencies: ReadingPositionMemoryDependencies
): ReadingPositionPort {
  const capacity = Math.max(1, Math.floor(dependencies.capacity ?? DEFAULT_CAPACITY));
  const now = dependencies.now ?? Date.now;
  let lastRequestedKey: string | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    readInitial() {
      if (!dependencies.documentKey || !dependencies.isEnabled()) return null;
      const stored = readStoredPositions(dependencies.storage.read())[dependencies.documentKey];
      return normalizePosition(stored, dependencies.getDocumentLineCount());
    },
    remember(position) {
      if (!dependencies.documentKey || !dependencies.isEnabled()) return Promise.resolve();
      const normalized = normalizePosition(position, dependencies.getDocumentLineCount());
      if (!normalized) return Promise.resolve();
      const requestedKey = positionKey(normalized);
      if (lastRequestedKey === requestedKey) return Promise.resolve();
      lastRequestedKey = requestedKey;
      const write = writeQueue.catch(() => undefined).then(async () => {
        await dependencies.storage.update((current) => {
          const entries = readStoredPositions(current);
          entries[dependencies.documentKey!] = { ...normalized, updatedAt: now() };
          return Object.fromEntries(
            Object.entries(entries)
              .sort(([leftKey, left], [rightKey, right]) => (
                right.updatedAt - left.updatedAt || leftKey.localeCompare(rightKey)
              ))
              .slice(0, capacity)
          );
        });
      });
      writeQueue = write.catch((error) => {
        if (lastRequestedKey === requestedKey) lastRequestedKey = null;
        throw error;
      });
      return writeQueue;
    }
  };
}
