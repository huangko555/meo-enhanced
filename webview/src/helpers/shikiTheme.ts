import type { RawVscodeTheme } from './shikiTypes';

export function toShikiTheme(theme: RawVscodeTheme) {
  return {
    name: 'meo-code-theme',
    type: theme.type,
    colors: { ...theme.colors },
    // Shiki normalizes settings in place. Each engine owns its theme input.
    settings: structuredClone(theme.tokenColors ?? []) as any[],
    fg: theme.colors?.['editor.foreground'],
    bg: theme.colors?.['editor.background']
  };
}
