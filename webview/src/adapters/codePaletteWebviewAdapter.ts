import githubLight from '@shikijs/themes/github-light';
import darkPlus from '@shikijs/themes/dark-plus';
import {
  resolveFinalCodePalette,
  type FinalCodePalette,
  type RawCodeTheme
} from '../application/finalCodePalette';

export type CodePaletteWebviewAdapter = {
  resolve(currentVscodeTheme: RawCodeTheme | null | undefined, appearance: 'light' | 'dark'): FinalCodePalette;
  apply(palette: FinalCodePalette): void;
};

/** Adapts serializable palette rules to bundled Shiki themes and Webview CSS effects. */
export function createCodePaletteWebviewAdapter(input: {
  readonly setShikiTheme: (theme: RawCodeTheme | null | undefined) => void;
  readonly sourceStyle?: Pick<CSSStyleDeclaration, 'setProperty'>;
}): CodePaletteWebviewAdapter {
  const fallbackThemes = Object.freeze({
    light: githubLight as RawCodeTheme,
    dark: darkPlus as RawCodeTheme
  });

  return {
    resolve(currentVscodeTheme, appearance) {
      return resolveFinalCodePalette(currentVscodeTheme, fallbackThemes[appearance], appearance);
    },
    apply(palette) {
      const sourceStyle = input.sourceStyle ?? document.documentElement.style;
      for (const [id, color] of Object.entries(palette.sourceTokens)) {
        sourceStyle.setProperty(`--meo-token-${id}-color`, color);
      }
      input.setShikiTheme(palette.theme);
    }
  };
}
