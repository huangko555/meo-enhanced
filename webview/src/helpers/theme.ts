import {
  resolveTheme,
  semanticColorKeys,
  SYNTAX_TAG_SPECS,
  type ThemeSettings,
  themeColorKeys
} from '../../../src/shared/themeDefaults';
import type { EditorAppearance } from '../../../src/shared/editorAppearance';
import { lightCssVariableOverrides, resolveEditorTheme } from '../themes/editorLightTheme';
import { darkCssVariableOverrides } from '../themes/editorDarkTheme';

const vscodeEditorFontFamily = 'var(--vscode-editor-font-family)';
const vscodeEditorFontSize = 'var(--vscode-editor-font-size, 13px)';
const styleValueInjectionPattern = /[\n\r;{}]/g;
const defaultHeadingFontWeight = '400';
const headingSizeFallbacks = ['1.6em', '1.5em', '1.3em', '1.2em', '1.1em', '1em'] as const;

const resolveEditorFontWeight = (): string => {
  const rawEditorFontWeight = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-weight').trim();
  return rawEditorFontWeight || 'normal';
};

const sanitizeThemeFontStyle = (value: string): string => `${value ?? ''}`.trim().replace(styleValueInjectionPattern, ' ');

const normalizeThemeLineHeight = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(3, Math.max(1, value));
};

const normalizeThemeFontSize = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '';
  }
  return `${value}px`;
};

const normalizeThemeFontWeight = (value: string | undefined, fallback: string): string => {
  const normalized = sanitizeThemeFontStyle(value ?? '');
  if (!normalized) {
    return fallback;
  }
  if (/^var\(\s*--vscode-editor-font-weight\s*\)$/i.test(normalized)) {
    return fallback;
  }
  return normalized;
};

const parseCssRgbColor = (value: string): { r: number; g: number; b: number } | null => {
  const match = value.trim().match(/^rgba?\(\s*(.+?)\s*\)$/i);
  if (!match?.[1]) {
    return null;
  }
  const channels = match[1].split('/')[0]?.trim().split(/[\s,]+/).filter(Boolean) ?? [];
  const [r, g, b] = channels.slice(0, 3).map((channel) => Number.parseFloat(channel));
  if (![r, g, b].every(Number.isFinite)) {
    return null;
  }
  return { r, g, b };
};

const resolveCssColor = (value: string): { r: number; g: number; b: number } | null => {
  const probe = document.createElement('span');
  probe.style.color = value;
  document.documentElement.appendChild(probe);
  const resolved = window.getComputedStyle(probe).color;
  probe.remove();
  return parseCssRgbColor(resolved);
};

const getRelativeLuminance = ({ r, g, b }: { r: number; g: number; b: number }): number => {
  const normalize = (channel: number): number => {
    const value = Math.min(255, Math.max(0, channel)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
};

const getInsetBackground = (backgroundColor: string, base03: string): string => {
  const resolvedBackground = resolveCssColor(backgroundColor);
  if (!resolvedBackground || getRelativeLuminance(resolvedBackground) < 0.36) {
    return `color-mix(in srgb, ${backgroundColor} 88%, black 12%)`;
  }
  return `color-mix(in srgb, ${backgroundColor} 80%, ${base03} 20%)`;
};

const normalizeThemeHeadingSize = (value: number | undefined, fallback: string, unit: 'px' | 'em' = 'px'): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  if (unit === 'em') {
    const normalized = value > 10 ? value / 16 : value;
    return `${Math.min(9, Math.max(0.5, normalized))}em`;
  }
  return `${value}px`;
};

const applyHostAppearance = (appearance: EditorAppearance): void => {
  const root = document.documentElement;
  const rootStyle = root.style;
  root.dataset.editorAppearance = appearance;
  rootStyle.colorScheme = appearance;

  const overrides = appearance === 'light'
    ? lightCssVariableOverrides
    : darkCssVariableOverrides;
  for (const [property, value] of Object.entries(overrides)) {
    rootStyle.setProperty(property, value);
  }
};

export const applyThemeSettings = (theme?: ThemeSettings, appearance: EditorAppearance = 'dark'): void => {
  let resolvedTheme: ThemeSettings;
  const editorFontWeight = resolveEditorFontWeight();
  try {
    resolvedTheme = resolveTheme(theme);
  } catch (error) {
    console.error('[MEO webview] Failed to resolve theme payload, using defaults.', error);
    resolvedTheme = resolveTheme();
  }

  applyHostAppearance(appearance);
  resolvedTheme = resolveEditorTheme(resolvedTheme, appearance);

  const rootStyle = document.documentElement.style;
  const insetBackground = getInsetBackground(resolvedTheme.backgroundColor, resolvedTheme.colors.base03);
  rootStyle.setProperty('--meo-background', resolvedTheme.backgroundColor);
  rootStyle.setProperty('--meo-inset-background', resolvedTheme.semanticColors.insetBackground || insetBackground);
  rootStyle.setProperty('--meo-foreground', resolvedTheme.semanticColors.foreground);
  rootStyle.setProperty('--meo-muted-foreground', resolvedTheme.semanticColors.mutedForeground);
  rootStyle.setProperty('--meo-code-background', resolvedTheme.semanticColors.codeBlockBackground);
  rootStyle.setProperty('--meo-code-block-active-line-bg-live', resolvedTheme.semanticColors.codeBlockActiveLineBackground);
  rootStyle.setProperty('--meo-surface-background', resolvedTheme.semanticColors.surfaceBackground);
  rootStyle.setProperty('--meo-selection-bg', resolvedTheme.semanticColors.selectionBackground);
  rootStyle.setProperty('--meo-caret-color', resolvedTheme.semanticColors.caret);
  rootStyle.setProperty('--meo-active-line-bg', resolvedTheme.semanticColors.activeLineBackground);
  rootStyle.setProperty('--meo-inline-code-background', resolvedTheme.semanticColors.inlineCodeBackground);

  for (const key of themeColorKeys) {
    rootStyle.setProperty(`--meo-color-${key}`, resolvedTheme.colors[key]);
  }

  for (const key of semanticColorKeys) {
    rootStyle.setProperty(`--meo-semantic-${key}`, resolvedTheme.semanticColors[key]);
  }

  for (const spec of SYNTAX_TAG_SPECS) {
    const tokenColor = resolvedTheme.syntaxTokens[spec.id];
    rootStyle.setProperty(`--meo-token-${spec.id}-color`, tokenColor);
  }

  const liveFont = sanitizeThemeFontStyle(resolvedTheme.fonts.liveFont);
  const sourceFont = sanitizeThemeFontStyle(resolvedTheme.fonts.sourceFont);
  const liveFontWeight = sanitizeThemeFontStyle(resolvedTheme.fonts.liveFontWeight);
  const sourceFontWeight = sanitizeThemeFontStyle(resolvedTheme.fonts.sourceFontWeight);
  const liveFontSize = normalizeThemeFontSize(resolvedTheme.fonts.liveFontSize);
  const sourceFontSize = normalizeThemeFontSize(resolvedTheme.fonts.sourceFontSize);
  const headingFontSizes = [
    normalizeThemeHeadingSize(resolvedTheme.fonts.h1FontSize, headingSizeFallbacks[0], 'em'),
    normalizeThemeHeadingSize(resolvedTheme.fonts.h2FontSize, headingSizeFallbacks[1], 'em'),
    normalizeThemeHeadingSize(resolvedTheme.fonts.h3FontSize, headingSizeFallbacks[2], 'em'),
    normalizeThemeHeadingSize(resolvedTheme.fonts.h4FontSize, headingSizeFallbacks[3], 'em'),
    normalizeThemeHeadingSize(resolvedTheme.fonts.h5FontSize, headingSizeFallbacks[4], 'em'),
    normalizeThemeHeadingSize(resolvedTheme.fonts.h6FontSize, headingSizeFallbacks[5], 'em')
  ];
  const headingFontWeights = [
    normalizeThemeFontWeight(resolvedTheme.fonts.h1FontWeight, defaultHeadingFontWeight),
    normalizeThemeFontWeight(resolvedTheme.fonts.h2FontWeight, defaultHeadingFontWeight),
    normalizeThemeFontWeight(resolvedTheme.fonts.h3FontWeight, defaultHeadingFontWeight),
    normalizeThemeFontWeight(resolvedTheme.fonts.h4FontWeight, defaultHeadingFontWeight),
    normalizeThemeFontWeight(resolvedTheme.fonts.h5FontWeight, defaultHeadingFontWeight),
    normalizeThemeFontWeight(resolvedTheme.fonts.h6FontWeight, defaultHeadingFontWeight)
  ];
  const liveLineHeight = normalizeThemeLineHeight(resolvedTheme.fonts.liveLineHeight, 1.5);
  const sourceLineHeight = normalizeThemeLineHeight(resolvedTheme.fonts.sourceLineHeight, 1.5);
  rootStyle.setProperty('--meo-font-live', liveFont || vscodeEditorFontFamily);
  rootStyle.setProperty('--meo-font-source', sourceFont || vscodeEditorFontFamily);
  rootStyle.setProperty('--meo-font-live-weight', liveFontWeight || editorFontWeight);
  rootStyle.setProperty('--meo-font-source-weight', sourceFontWeight || editorFontWeight);
  rootStyle.setProperty('--meo-font-live-size', liveFontSize || vscodeEditorFontSize);
  rootStyle.setProperty('--meo-font-source-size', sourceFontSize || vscodeEditorFontSize);
  for (const [index, size] of headingFontSizes.entries()) {
    rootStyle.setProperty(`--meo-heading-${index + 1}-size`, size);
  }
  for (const [index, weight] of headingFontWeights.entries()) {
    rootStyle.setProperty(`--meo-heading-${index + 1}-weight`, weight);
  }
  rootStyle.setProperty('--meo-heading-token-weight', defaultHeadingFontWeight);
  rootStyle.setProperty('--meo-line-height-live', `${liveLineHeight}`);
  rootStyle.setProperty('--meo-line-height-source', `${sourceLineHeight}`);
};
