/** A search hit shared between source and rendered text without moving the editing selection. */
export type SearchMatchAnchor = {
  readonly line: number;
  readonly occurrence: number;
};
