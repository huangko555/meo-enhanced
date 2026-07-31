import githubLight from '@shikijs/themes/github-light';
import darkPlus from '@shikijs/themes/dark-plus';
import { themePresets, type ThemeSettings } from '../../../src/shared/themeDefaults';
import type { EditorAppearance } from '../../../src/shared/editorAppearance';
import type { RawVscodeTheme } from '../helpers/shikiHighlighter';

const githubLightEditorTheme = themePresets.find((theme) => theme.id === 'github-light');
const lightAccentBlue = '#0550ae';

if (!githubLightEditorTheme) {
  throw new Error('GitHub Light editor theme is unavailable.');
}

export const lightCssVariableOverrides = {
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#24292f',
  '--vscode-sideBar-background': '#f6f8fa',
  '--vscode-panel-border': '#d0d7de',
  '--vscode-editorWidget-background': '#ffffff',
  '--vscode-editorWidget-foreground': '#24292f',
  '--vscode-editorHoverWidget-background': '#ffffff',
  '--vscode-editorHoverWidget-foreground': '#24292f',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#24292f',
  '--vscode-input-placeholderForeground': '#6e7781',
  '--vscode-toolbar-hoverBackground': '#eaeef2',
  '--vscode-toolbar-activeBackground': '#d8dee4',
  '--vscode-button-secondaryBackground': '#d8dee4',
  '--vscode-button-foreground': '#24292f',
  '--vscode-descriptionForeground': '#57606a',
  '--vscode-disabledForeground': '#8c959f',
  '--vscode-icon-foreground': '#57606a',
  '--vscode-textCodeBlock-background': '#f6f8fa',
  '--vscode-editor-selectionBackground': '#b6d7ff',
  '--vscode-editorLineNumber-foreground': '#afb8c1',
  '--meo-line-number-foreground': '#afb8c1',
  '--meo-divider-color': '#d0d7de',
  '--meo-input-border': '#d0d7de',
  '--meo-toolbar-overflow-foreground': '#24292f',
  '--meo-elevated-shadow': '0 4px 12px rgb(31 35 40 / 12%)',
  '--meo-fixed-baseline-active-background': '#2da44e',
  '--meo-fixed-baseline-active-foreground': '#ffffff',
  '--meo-fixed-baseline-standby': '#1a7f37',
  '--git-added': '#2da44e',
  '--git-changed': '#0969da',
  '--git-deleted': '#cf222e'
} as const;

const preservedSemanticColors = [
  'searchMatchBackground',
  'searchMatchBorder',
  'searchMatchActiveBackground',
  'searchMatchActiveBorder'
] as const;

export function resolveEditorTheme(theme: ThemeSettings, appearance: EditorAppearance): ThemeSettings {
  if (appearance === 'dark') {
    return theme;
  }

  const semanticColors = Object.fromEntries(
    Object.entries(githubLightEditorTheme.semanticColors).map(([key, value]) => [
      key,
      value === '#0969da' ? lightAccentBlue : value
    ])
  ) as ThemeSettings['semanticColors'];
  for (const key of preservedSemanticColors) {
    semanticColors[key] = theme.semanticColors[key];
  }
  semanticColors.searchMatchForeground = 'inherit';
  semanticColors.searchMatchActiveForeground = 'inherit';

  return {
    ...theme,
    backgroundColor: githubLightEditorTheme.backgroundColor,
    colors: {
      ...githubLightEditorTheme.colors,
      base05: lightAccentBlue
    },
    semanticColors,
    syntaxTokens: Object.fromEntries(
      Object.entries(githubLightEditorTheme.syntaxTokens).map(([key, value]) => [
        key,
        value === '#0969da' ? lightAccentBlue : value
      ])
    ) as ThemeSettings['syntaxTokens'],
    fonts: theme.fonts
  };
}

export function resolveCodeTheme(
  _theme: RawVscodeTheme | null | undefined,
  appearance: EditorAppearance
): RawVscodeTheme | null | undefined {
  return appearance === 'light'
    ? githubLight as RawVscodeTheme
    : darkPlus as RawVscodeTheme;
}
