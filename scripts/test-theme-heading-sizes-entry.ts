import {
  defaultThemeSettings,
  type ThemeFonts,
  type ThemeSettings
} from '../src/shared/themeDefaults';
import { applyThemeSettings } from '../webview/src/helpers/theme';

type HeadingSizes = readonly [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null
];

const headingSizeKeys = [
  'h1FontSize',
  'h2FontSize',
  'h3FontSize',
  'h4FontSize',
  'h5FontSize',
  'h6FontSize'
] as const satisfies readonly (keyof ThemeFonts)[];

declare global {
  interface Window {
    ThemeHeadingSizeHarness: {
      apply(sizes: HeadingSizes): string[];
    };
  }
}

window.ThemeHeadingSizeHarness = {
  apply(sizes) {
    const fonts = { ...defaultThemeSettings.fonts };
    for (const [index, key] of headingSizeKeys.entries()) {
      fonts[key] = sizes[index];
    }
    const theme: ThemeSettings = { ...defaultThemeSettings, fonts };
    applyThemeSettings(theme, 'dark');
    return headingSizeKeys.map((_, index) => (
      document.documentElement.style.getPropertyValue(`--meo-heading-${index + 1}-size`)
    ));
  }
};
