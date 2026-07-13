export const MIN_OUTLINE_WIDTH = 180;
export const MAX_OUTLINE_WIDTH = 480;
export const DEFAULT_OUTLINE_WIDTH = 260;

export function normalizeOutlineWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Math.round(width)))
    : DEFAULT_OUTLINE_WIDTH;
}
