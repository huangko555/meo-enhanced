import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import {
  resolveFinalCodePalette,
  type FinalCodePalette,
  type RawCodeTheme
} from '../application/finalCodePalette';

export type CodePaletteWebviewAdapter = {
  resolve(
    currentVscodeTheme: RawCodeTheme | null | undefined,
    appearance: 'light' | 'dark'
  ): FinalCodePalette;
  apply(palette: FinalCodePalette): void;
};

/** Adapts serializable palette rules to bundled Shiki themes and Webview CSS effects. */
export function createCodePaletteWebviewAdapter(input: {
  readonly setShikiTheme: (theme: RawCodeTheme | null | undefined) => void;
  readonly sourceStyle?: Pick<CSSStyleDeclaration, 'setProperty'>;
}): CodePaletteWebviewAdapter {
  const previewFallbackThemes = Object.freeze({
    light: lightPlus as RawCodeTheme,
    dark: darkPlus as RawCodeTheme
  });
  const sourceFallbackThemes = Object.freeze({
    light: lightPlus as RawCodeTheme,
    dark: darkPlus as RawCodeTheme
  });

  return {
    resolve(currentVscodeTheme, appearance) {
      return resolveFinalCodePalette(
        currentVscodeTheme,
        previewFallbackThemes[appearance],
        appearance,
        sourceFallbackThemes[appearance]
      );
    },
    apply(palette) {
      const sourceStyle = input.sourceStyle ?? document.documentElement.style;
      for (const [id, color] of Object.entries(palette.sourceTokens)) {
        sourceStyle.setProperty(`--meo-token-${id}-color`, color);
      }
      // All fenced-code surfaces share this Shiki runtime. When the editor
      // appearance is inverse to VS Code, code tokens and Source prose switch
      // together to the appearance-matched native fallback palette.
      input.setShikiTheme(palette.sourceTheme);
    }
  };
}
