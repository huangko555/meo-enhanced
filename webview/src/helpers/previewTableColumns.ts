import { previewSourceLineMapper, type PreviewSourceLineMapper } from './previewSourceIdentity';

/** Column geometry belongs to the accepted source table, across row windows
 * and content edits. Typing grows/wraps cells without resizing untouched columns. */
export function createPreviewTableColumnPreferences() {
  let accepted = new Map<number, readonly number[]>();
  return {
    revise(before: string | null, after: string, sourceMap?: PreviewSourceLineMapper) {
      if (before === null) { accepted.clear(); return; }
      if (!accepted.size || before === after) return;
      const map = sourceMap ?? previewSourceLineMapper(before, after), next = new Map<number, readonly number[]>();
      for (const [line, units] of accepted) {
        const mapped = map(line);
        if (mapped !== undefined) next.set(mapped, units);
      }
      accepted = next;
    },
    read(table: HTMLTableElement, count: number): readonly number[] | null {
      const units = table.dataset.meoPreviewTableWidths?.split(',').map(Number);
      const origin = Number(table.dataset.meoPreviewTableOrigin);
      if (!Number.isSafeInteger(origin) || origin < 1 || units?.length !== count
        || !units.every(unit => Number.isFinite(unit) && unit >= 0)) return null;
      const previous = accepted.get(origin);
      if (previous?.length === count) return previous;
      accepted.set(origin, units); return units;
    }
  };
}
