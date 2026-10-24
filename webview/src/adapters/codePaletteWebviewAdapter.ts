import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import {
  resolveFinalCodePalette,
  resolveMarkdownContentColors,
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
  readonly setSourceDocumentTheme?: (theme: RawCodeTheme) => void;
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
      const palette = resolveFinalCodePalette(
        currentVscodeTheme,
        previewFallbackThemes[appearance],
        appearance,
        sourceFallbackThemes[appearance]
      );
      const customized = currentVscodeTheme?.type === appearance ? currentVscodeTheme : undefined;
      const customRules = customized?.sourceTokenColors;
      const tokenColors = customRules
        ? customized!.tokenColors.length ? customRules : [...palette.sourceTheme.tokenColors, ...customRules]
        : palette.sourceTheme.tokenColors;
      return { ...palette, sourceDocumentTheme: {
        ...palette.sourceTheme,
        colors: customized?.sourceColors ?? palette.sourceTheme.colors,
        // VS Code supplies its foreground/background as the default rule and
        // ignores scopeless defaults embedded in a contributed theme.
        tokenColors: tokenColors.filter(rule => rule && typeof rule === 'object' && 'scope' in rule && rule.scope && 'settings' in rule && rule.settings)
      } };
    },
    apply(palette) {
      const sourceStyle = input.sourceStyle ?? document.documentElement.style;
      // Surface derivation checks the prepared code palette, without scanning
      // rendered tokens or rerunning Shiki during a color preview.
      sourceStyle.setProperty('--meo-code-palette-foreground', palette.preview.foreground);
      sourceStyle.setProperty('--meo-code-palette-comment', palette.preview.comment);
      sourceStyle.setProperty('--meo-code-palette-background', palette.sourceTheme.colors['editor.background'] ?? (palette.sourceTheme.type === 'light' ? '#ffffff' : '#24292e'));
      for (const [id, color] of Object.entries(palette.sourceTokens)) {
        sourceStyle.setProperty(`--meo-token-${id}-color`, color);
      }
      sourceStyle.setProperty('--meo-heading-token-weight', palette.sourceHeadingFontWeight);
      // Preserve the existing fenced-code runtime. Source prose and embedded
      // syntax use their own customized theme below.
      input.setShikiTheme(palette.sourceTheme);
      let documentTheme = palette.sourceDocumentTheme ?? palette.sourceTheme;
      if (typeof document !== 'undefined') {
        const hostIsLight = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
        const matchesHost = documentTheme.type === 'light' ? hostIsLight : document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
        const nativeForeground = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground').trim();
        // The host resolves registry defaults, including a user's "default"
        // override; raw theme JSON alone cannot reproduce those defaults.
        if (matchesHost && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(nativeForeground)) {
          documentTheme = { ...documentTheme, colors: { ...documentTheme.colors, 'editor.foreground': nativeForeground } };
        }
      }
      sourceStyle.setProperty('--meo-source-foreground', documentTheme.colors['editor.foreground'] ?? (documentTheme.type === 'light' ? '#000000' : '#d4d4d4'));
      const contentColors = resolveMarkdownContentColors(documentTheme);
      sourceStyle.setProperty('--meo-content-heading-input', contentColors.heading);
      sourceStyle.setProperty('--meo-content-link-input', contentColors.link);
      input.setSourceDocumentTheme?.(documentTheme);
    }
  };
}
