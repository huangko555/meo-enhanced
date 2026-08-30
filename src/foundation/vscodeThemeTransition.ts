export type ThemeAppearance = 'light' | 'dark';

/** Keeps raw token data honest while VS Code is still updating its configured theme label. */
export function projectRawThemeAppearance<T extends { readonly type: ThemeAppearance }>(
  theme: T,
  _appearance: ThemeAppearance
): T {
  return theme;
}
