import type { UiColorKey } from '../../../src/foundation/uiColors';

// Snapshot: VS Code 1.138.0 (7debcd0e2acdea1c52de81bf9ee1620444407dda),
// theme-defaults/themes/2026-{light,dark}.json. Missing success/warning inputs
// come from that version's testing.iconPassed/editorWarning.foreground defaults.
// Keep only base inputs: shared UI roles still own neutralization and contrast.
export const defaultUiColors = {
  light: {
    surface: '#FAFAFD',
    documentBackground: '#FFFFFF',
    text: '#202020',
    accent: '#0069CC',
    textEmphasis: '#0069CC',
    link: '#0069CC',
    success: '#73C991',
    warning: '#BF8803',
    danger: '#AD0707'
  },
  dark: {
    surface: '#202122',
    documentBackground: '#121314',
    text: '#BFBFBF',
    accent: '#297AA0',
    textEmphasis: '#48A0C7',
    link: '#48A0C7',
    success: '#73C991',
    warning: '#CCA700',
    danger: '#F48771'
  }
} as const satisfies Record<'light' | 'dark', Record<UiColorKey, string>>;
