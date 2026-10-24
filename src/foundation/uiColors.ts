/** Only overrides are persisted. Missing inputs use the host theme or bundled defaults. */
export const uiColorKeys = ['surface', 'documentBackground', 'text', 'accent', 'textEmphasis', 'link', 'success', 'warning', 'danger'] as const;
export type UiColorKey = typeof uiColorKeys[number];
export type UiColorOverrides = Partial<Record<UiColorKey, string>>;
export type UiColors = { readonly light: UiColorOverrides; readonly dark: UiColorOverrides };

export function normalizeUiColor(value: string): string | null {
  const color = value.trim();
  if (/^#[\da-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map(channel => channel + channel).join('').toUpperCase();
  return /^#[\da-f]{6}$/i.test(color) ? color.toUpperCase() : null;
}

export function decodeUiColors(value: unknown): UiColors | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'light' && key !== 'dark')) return null;
  const result: UiColors = { light: {}, dark: {} };
  for (const mode of ['light', 'dark'] as const) {
    const profile = record[mode];
    if (profile === undefined) continue;
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return null;
    for (const [key, value] of Object.entries(profile)) {
      if (!uiColorKeys.includes(key as UiColorKey) || typeof value !== 'string') return null;
      const color = normalizeUiColor(value);
      if (!color) return null;
      result[mode][key as UiColorKey] = color;
    }
  }
  return result;
}
