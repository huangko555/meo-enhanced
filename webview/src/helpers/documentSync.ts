interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface ReconciledExternalDocument {
  text: string;
  pendingText: string | null;
}

function findTextChange(previousText: string, nextText: string): TextChange | null {
  if (previousText === nextText) return null;

  let from = 0;
  const maxStart = Math.min(previousText.length, nextText.length);
  while (from < maxStart && previousText.charCodeAt(from) === nextText.charCodeAt(from)) from += 1;

  let previousTo = previousText.length;
  let nextTo = nextText.length;
  while (
    previousTo > from &&
    nextTo > from &&
    previousText.charCodeAt(previousTo - 1) === nextText.charCodeAt(nextTo - 1)
  ) {
    previousTo -= 1;
    nextTo -= 1;
  }

  return { from, to: previousTo, insert: nextText.slice(from, nextTo) };
}

function changesOverlap(left: TextChange, right: TextChange): boolean {
  if (left.from === left.to && right.from === right.to) return left.from === right.from;
  return left.from < right.to && right.from < left.to;
}

export function reconcileExternalDocument(
  baseText: string,
  localText: string | null,
  incomingText: string
): ReconciledExternalDocument {
  if (localText === null || localText === baseText || localText === incomingText) {
    return { text: incomingText, pendingText: null };
  }

  const localChange = findTextChange(baseText, localText);
  const incomingChange = findTextChange(baseText, incomingText);
  if (!localChange || !incomingChange || changesOverlap(localChange, incomingChange)) {
    return { text: incomingText, pendingText: null };
  }

  const incomingDelta = incomingChange.insert.length - (incomingChange.to - incomingChange.from);
  const mappedFrom = incomingChange.to <= localChange.from
    ? localChange.from + incomingDelta
    : localChange.from;
  const mappedTo = incomingChange.to <= localChange.from
    ? localChange.to + incomingDelta
    : localChange.to;
  const mergedText = incomingText.slice(0, mappedFrom) + localChange.insert + incomingText.slice(mappedTo);
  return { text: mergedText, pendingText: mergedText };
}
