const positiveIntegerPattern = /^[1-9]\d*$/;

export function isAcceptedLineJumpInput(value: string): boolean {
  return value === '' || positiveIntegerPattern.test(value);
}

export function parseLineJumpTarget(value: string, totalLines: number): number | null {
  if (!positiveIntegerPattern.test(value)) {
    return null;
  }

  const lineNumber = Number(value);
  return Number.isSafeInteger(lineNumber) && lineNumber <= totalLines ? lineNumber : null;
}
