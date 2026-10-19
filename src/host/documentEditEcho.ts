import { normalizeDocumentText } from '../foundation/documentText';

type PlatformChange = { readonly rangeOffset: number; readonly rangeLength: number; readonly text: string };

/** Correlates one in-flight platform edit with its exact document-change event. */
export function createDocumentEditEchoFilter() {
  let active: {
    baseVersion: number; changes: readonly PlatformChange[]; acceptedVersion: number | null;
  } | null = null;
  const ordered = (changes: readonly PlatformChange[]) => [...changes].sort(
    (left, right) => left.rangeOffset - right.rangeOffset || left.rangeLength - right.rangeLength
  );
  return {
    expect(baseVersion: number, changes: readonly PlatformChange[]) {
      const ticket = { baseVersion, changes: ordered(changes), acceptedVersion: null as number | null };
      active = ticket;
      return {
        close(): number | null {
          if (active === ticket) active = null;
          return ticket.acceptedVersion;
        }
      };
    },
    accept(version: number, changes: readonly PlatformChange[]): boolean {
      const ticket = active;
      if (!ticket || changes.length === 0) return false;
      active = null; // Only the first text event can be this edit's receipt.
      if (version <= ticket.baseVersion || changes.length !== ticket.changes.length) return false;
      const actual = ordered(changes);
      if (!ticket.changes.every((expected, index) => {
        const change = actual[index]!;
        return expected.rangeOffset === change.rangeOffset && expected.rangeLength === change.rangeLength
          && normalizeDocumentText(expected.text) === normalizeDocumentText(change.text);
      })) return false;
      ticket.acceptedVersion = version;
      return true;
    }
  };
}
