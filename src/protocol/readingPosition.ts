export type ReadingPositionDto = {
  readonly line: number;
  readonly lineOffset: number;
};

export type ReadingPositionChangedMessage = {
  readonly type: 'readingPositionChanged';
  readonly position: ReadingPositionDto;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

export function decodeReadingPosition(value: unknown): ReadingPositionDto | null {
  if (!isRecord(value)
    || typeof value.line !== 'number'
    || !Number.isInteger(value.line)
    || value.line < 1
    || typeof value.lineOffset !== 'number'
    || !Number.isFinite(value.lineOffset)
    || value.lineOffset < 0) return null;
  return value as ReadingPositionDto;
}

export function decodeReadingPositionChangedMessage(value: unknown): ReadingPositionChangedMessage | null {
  if (!isRecord(value) || value.type !== 'readingPositionChanged') return null;
  const position = decodeReadingPosition(value.position);
  return position ? { type: 'readingPositionChanged', position } : null;
}
