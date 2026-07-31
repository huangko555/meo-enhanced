import {
  defaultThemeColors,
  defaultThemeFonts,
  type ThemeColorKey,
  type ThemeColors,
  type ThemeSettings
} from '../shared/themeDefaults';
import type { PreviewAppearance, PreviewStyleEnvironment } from '../shared/preview';

const styleValueInjectionPattern = /[\n\r;{}]/g;

export type ExportStyleEnvironment = PreviewStyleEnvironment & {
  meoThemeColors?: Partial<Record<ThemeColorKey, string>>;
};

export function buildExportStyles(
  theme: ThemeSettings,
  environment: ExportStyleEnvironment = {},
  appearance: PreviewAppearance = 'light'
): string {
  return buildReadingStyles(theme, environment, appearance);
}

export function buildPreviewStyles(
  theme: ThemeSettings,
  environment: ExportStyleEnvironment = {},
  appearance: PreviewAppearance = 'dark'
): string {
  return buildReadingStyles(theme, environment, appearance);
}

function buildReadingStyles(
  theme: ThemeSettings,
  environment: ExportStyleEnvironment,
  appearance: PreviewAppearance
): string {
  const colors = resolveThemeColors(theme, environment);
  const fonts = theme.fonts ?? defaultThemeFonts;
  const editorFontFamily = sanitizeCssFont(environment.editorFontFamily ?? '');
  const editorFontWeight = sanitizeFontWeight(environment.editorFontWeight, 'normal');
  const darkBackgroundColor =
    sanitizeCssColor(environment.editorBackgroundColor ?? '') ||
    sanitizeCssColor(theme.backgroundColor ?? '') ||
    colors.base03;
  const editorBackgroundColor = appearance === 'light' ? '#ffffff' : darkBackgroundColor;
  const previewForegroundColor = appearance === 'light' ? '#1f2328' : '#d8dee9';
  const previewMutedColor = appearance === 'light' ? '#59636e' : '#9aa4af';
  const editorForegroundColor = previewForegroundColor;
  const defaultCodeBlockColor = appearance === 'light'
    ? '#f6f8fa'
    : `color-mix(in srgb, ${editorBackgroundColor} 80%, ${colors.base03} 20%)`;
  const defaultSurfaceColor = appearance === 'light'
    ? '#f6f8fa'
    : `color-mix(in srgb, ${editorBackgroundColor} 86%, ${colors.base03} 14%)`;
  const codeBlockBackgroundColor = appearance === 'light'
    ? defaultCodeBlockColor
    : `color-mix(in srgb, ${editorBackgroundColor} 82%, #000000 18%)`;
  const sideBarBackgroundColor = appearance === 'light'
    ? defaultSurfaceColor
    : `color-mix(in srgb, ${editorBackgroundColor} 92%, ${previewForegroundColor} 8%)`;
  const panelBorderColor = appearance === 'light'
    ? '#d0d7de'
    : `color-mix(in srgb, ${previewForegroundColor} 22%, transparent)`;
  const readingMutedColor = previewMutedColor;
  const readingForegroundColor = previewForegroundColor;
  const liveFont = resolveThemeFontChoice(
    sanitizeCssFont(environment.liveFontFamily ?? ''),
    sanitizeCssFont(fonts.liveFont),
    editorFontFamily,
    'var(--meo-font-system-sans)'
  );
  const sourceFont = resolveThemeFontChoice(
    sanitizeCssFont(environment.sourceFontFamily ?? ''),
    sanitizeCssFont(fonts.sourceFont),
    editorFontFamily,
    'var(--meo-font-system-mono)'
  );
  const liveFontWeight = resolveThemeFontChoice(
    sanitizeFontWeight(environment.liveFontWeight, editorFontWeight),
    sanitizeFontWeight(fonts.liveFontWeight, editorFontWeight),
    editorFontWeight,
    'normal'
  );
  const sourceFontWeight = resolveThemeFontChoice(
    sanitizeFontWeight(environment.sourceFontWeight, editorFontWeight),
    sanitizeFontWeight(fonts.sourceFontWeight, editorFontWeight),
    editorFontWeight,
    'normal'
  );
  const editorFontSizePx = clampFontSize(environment.editorFontSizePx);
  const liveFontSizePx = Math.max(16, resolveThemeFontSizePx(fonts.liveFontSize, editorFontSizePx));
  const sourceFontSizePx = Math.max(14, resolveThemeFontSizePx(fonts.sourceFontSize, editorFontSizePx));
  const lineHeight = Math.max(1.7, clampLineHeight(environment.liveLineHeight ?? fonts.liveLineHeight ?? defaultThemeFonts.liveLineHeight));
  const sourceLineHeight = clampLineHeight(environment.sourceLineHeight ?? fonts.sourceLineHeight ?? defaultThemeFonts.sourceLineHeight);
  const headingFontSizes = [
    fonts.h1FontSize,
    fonts.h2FontSize,
    fonts.h3FontSize,
    fonts.h4FontSize,
    fonts.h5FontSize,
    fonts.h6FontSize
  ].map((fontSize, index) => {
    const fallback = defaultThemeFonts[`h${index + 1}FontSize` as keyof typeof defaultThemeFonts];
    const value = typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : fallback;
    return `${value}em`;
  });
  const headingFontWeights = [
    fonts.h1FontWeight,
    fonts.h2FontWeight,
    fonts.h3FontWeight,
    fonts.h4FontWeight,
    fonts.h5FontWeight,
    fonts.h6FontWeight
  ].map((fontWeight, index) => sanitizeFontWeight(
    fontWeight,
    defaultThemeFonts[`h${index + 1}FontWeight` as keyof typeof defaultThemeFonts] as string
  ));
  const headingSizeVarsCss = headingFontSizes
    .map((fontSize, index) => `  --meo-heading-${index + 1}-size: ${fontSize};`)
    .join('\n');
  const headingWeightVarsCss = headingFontWeights
    .map((fontWeight, index) => `  --meo-heading-${index + 1}-weight: ${fontWeight};`)
    .join('\n');
  const headingRulesCss = headingFontSizes
    .map((_fontSize, index) => {
      const level = index + 1;
      const opacity = level === 6 ? ' opacity: 0.9;' : '';
      return `h${level} { font-size: var(--meo-heading-${level}-size); font-weight: var(--meo-heading-${level}-weight);${opacity} }`;
    })
    .join('\n');
  return `
:root {
  color-scheme: ${appearance};
  --meo-font-system-sans: ui-sans-serif, system-ui, sans-serif;
  --meo-font-system-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --meo-bg: ${editorBackgroundColor};
  --meo-fg: ${editorForegroundColor};
  --meo-muted: ${readingMutedColor};
  --meo-border: ${panelBorderColor};
  --meo-base04: ${readingForegroundColor};
  --meo-base05: ${readingForegroundColor};
  --meo-base07: ${readingForegroundColor};
  --meo-base08: ${readingForegroundColor};
  --meo-base09: ${readingForegroundColor};
  --meo-heading: ${readingForegroundColor};
  --meo-link: ${readingForegroundColor};
  --meo-accent-2: ${readingForegroundColor};
  --meo-strong: ${readingForegroundColor};
  --meo-number: ${readingForegroundColor};
  --meo-quote: ${readingMutedColor};
  --meo-font-body: ${liveFont};
  --meo-font-code: ${sourceFont};
  --meo-font-weight-body: ${liveFontWeight};
  --meo-font-weight-code: ${sourceFontWeight};
  --meo-font-size-body: ${liveFontSizePx}px;
  --meo-font-size-code: ${sourceFontSizePx}px;
${headingSizeVarsCss}
${headingWeightVarsCss}
  --meo-line-height: ${lineHeight};
  --meo-code-line-height: ${sourceLineHeight};
  --meo-code-bg: ${codeBlockBackgroundColor};
  --meo-mermaid-background: var(--meo-code-bg);
  --meo-mermaid-node-background: ${appearance === 'light' ? '#ffffff' : sideBarBackgroundColor};
  --meo-mermaid-foreground: var(--meo-fg);
  --meo-mermaid-border: ${appearance === 'light' ? '#8c959f' : previewMutedColor};
  --meo-mermaid-line: ${appearance === 'light' ? '#57606a' : previewMutedColor};
  --meo-sidebar-bg: ${sideBarBackgroundColor};
  --meo-page-bg: color-mix(in srgb, var(--meo-bg) 86%, var(--meo-border) 14%);
  --meo-panel-bg: color-mix(in srgb, var(--meo-bg) 96%, var(--meo-fg) 4%);
  --meo-panel-border: ${panelBorderColor};
  --meo-doc-border: color-mix(in srgb, var(--meo-panel-border) 55%, transparent);
  --meo-code-border: color-mix(in srgb, var(--meo-panel-border) 45%, transparent);
  --meo-hr: color-mix(in srgb, var(--meo-border) 70%, transparent);
  --meo-table-border: var(--meo-panel-border);
  --meo-table-header-bg: var(--meo-sidebar-bg);
  --meo-kbd-bg: color-mix(in srgb, var(--meo-sidebar-bg) 88%, var(--meo-bg) 12%);
  --meo-kbd-border: color-mix(in srgb, var(--meo-border) 85%, transparent);
  --meo-kbd-shadow: color-mix(in srgb, var(--meo-border) 55%, transparent);
  --meo-mermaid-error-border: color-mix(in srgb, var(--meo-heading) 70%, var(--meo-border) 30%);
  --meo-mermaid-error-fg: color-mix(in srgb, var(--meo-heading) 75%, var(--meo-fg) 25%);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--meo-bg);
  color: var(--meo-fg);
  font-family: var(--meo-font-body);
  font-weight: var(--meo-font-weight-body);
  font-size: var(--meo-font-size-body);
  line-height: var(--meo-line-height);
}

.meo-export-page {
  width: 100%;
  min-height: 100vh;
  padding: 0;
  background: var(--meo-bg);
}

html[data-meo-export-target='pdf'] .meo-export-page,
body[data-meo-export-target='pdf'] .meo-export-page {
  background: var(--meo-bg);
  padding: 0;
}

html[data-meo-export-target='pdf'],
body[data-meo-export-target='pdf'] {
  background: var(--meo-bg);
  overflow-x: hidden;
  width: 100%;
}

html[data-meo-export-target='pdf'] body,
body[data-meo-export-target='pdf'] {
  position: relative;
}

html[data-meo-export-target='pdf'] body::after,
body[data-meo-export-target='pdf']::after {
  content: '';
  position: fixed;
  top: 0;
  right: -8px;
  bottom: 0;
  width: 16px;
  background: var(--meo-bg);
  pointer-events: none;
}

html[data-meo-export-target='pdf'] .meo-export-doc,
body[data-meo-export-target='pdf'] .meo-export-doc {
  width: calc(100% + 8px);
  margin: 0;
  margin-right: -8px;
  border: 0;
  border-radius: 0;
  padding: calc(0.5in + 24px);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

html[data-meo-export-target='pdf'] .meo-export-page,
body[data-meo-export-target='pdf'] .meo-export-page {
  width: calc(100% + 8px);
  margin-right: -8px;
}

html[data-meo-export-target='pdf'] .meo-export-mermaid-svg svg,
body[data-meo-export-target='pdf'] .meo-export-mermaid-svg svg {
  width: auto;
  min-width: 0;
  max-height: calc(297mm - 1in - 80px);
}

html[data-meo-export-target='pdf'] hr,
body[data-meo-export-target='pdf'] hr {
  height: 0;
  margin: 0;
  border: 0;
  background: transparent;
  break-before: page;
  page-break-before: always;
}

.meo-export-doc {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  padding: 48px 40px 72px;
  border: 0;
  border-radius: 0;
  background: var(--meo-bg);
}

.meo-export-doc > :first-child { margin-top: 0; }
.meo-export-doc > :last-child { margin-bottom: 0; }

.meo-export-frontmatter {
  margin: 0 0 1.35em;
  padding: 10px 12px 12px;
  border: 1px solid color-mix(in srgb, var(--meo-border) 72%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--meo-bg) 92%, var(--meo-border) 8%);
  color: var(--meo-fg);
  font-family: var(--meo-font-body);
  font-weight: var(--meo-font-weight-body);
  font-size: 0.92em;
}

.meo-export-frontmatter-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  margin-bottom: 5px;
  padding: 0 6px;
  color: var(--meo-muted);
  font-size: 0.82em;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.meo-export-frontmatter-header-icon {
  width: 3px;
  height: 3px;
  margin: 0 7px 6px 1px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 7px 0 currentColor, 0 7px currentColor, 7px 7px currentColor;
}

.meo-export-frontmatter-line {
  min-height: 1.7em;
  padding: 3px 6px;
  border-radius: 4px;
}

.meo-export-frontmatter-line.is-property {
  display: grid;
  grid-template-columns: minmax(110px, 0.32fr) minmax(0, 1fr);
  align-items: start;
  column-gap: 16px;
}

.meo-export-frontmatter-line.is-raw {
  color: var(--meo-muted);
  font-family: var(--meo-font-code);
  font-size: var(--meo-font-size-code);
  white-space: pre-wrap;
  word-break: break-word;
}

.meo-export-frontmatter-key-cell {
  min-width: 0;
  color: var(--meo-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.meo-export-frontmatter-prefix {
  opacity: 0.7;
}

.meo-export-frontmatter-key {
  font-weight: 500;
}

.meo-export-frontmatter-value {
  min-width: 0;
  color: var(--meo-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.meo-export-frontmatter-array {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 100%;
  vertical-align: text-top;
}

.meo-export-frontmatter-pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: 1.35em;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--meo-border);
  color: var(--meo-fg);
  font-size: 0.92em;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.1;
}

h1, h2, h3, h4, h5, h6 {
  color: var(--meo-heading);
  line-height: 1.25;
  margin-top: 1.6em;
  margin-bottom: 0.65em;
}
${headingRulesCss}

h1, h2 {
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--meo-hr);
}

p, ul, ol, blockquote, pre, table, hr {
  margin: 0 0 1em;
}
ul { padding-inline-start: 1.5em; }
ol { padding-inline-start: 1.8em; }
li + li { margin-top: 0.2em; }
li > ul,
li > ol {
  margin-top: 0.35em;
}
ul ul,
ul ol,
ol ul,
ol ol {
  margin-bottom: 0.35em;
}

.meo-export-task-item {
  list-style: none;
  margin-left: -0.1em;
}

.meo-export-task-checkbox {
  display: inline-block;
  box-sizing: border-box;
  width: 17px;
  height: 17px;
  margin-right: 0.55em;
  vertical-align: middle;
  border: 1px solid var(--meo-border);
  border-radius: 4px;
  background: var(--meo-sidebar-bg);
  position: relative;
  top: -1px;
}

.meo-export-task-checkbox.is-done::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 4px;
  height: 7px;
  border: solid var(--meo-fg);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.meo-export-task-checkbox.is-inprogress::after,
.meo-export-task-checkbox.is-dropped::after {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--meo-fg);
  font-size: 12px;
  line-height: 1;
}

.meo-export-task-checkbox.is-inprogress::after {
  content: '◐';
  font-weight: 500;
}

.meo-export-task-checkbox.is-dropped::after {
  content: '-';
  font-weight: 700;
}

.meo-export-task-text.is-done {
  color: var(--meo-muted);
}

.meo-export-task-text.is-dropped {
  color: var(--meo-muted);
  text-decoration: line-through;
  text-decoration-color: currentColor;
}

a {
  color: var(--meo-link);
  text-decoration: underline;
  text-underline-offset: 3px;
}

sup.footnote-ref {
  font-size: 0.8em;
  line-height: 1;
  vertical-align: super;
}

.footnote-ref a,
.footnote-backref {
  color: var(--meo-link);
  text-decoration: none;
}

.footnotes {
  margin-top: 1.6em;
  padding-top: 1em;
  border-top: 1px solid var(--meo-hr);
}

.footnotes > hr {
  display: none;
}

.footnotes-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.footnote-item {
  display: flex;
  align-items: flex-start;
  gap: 0.55em;
}

.footnote-index {
  flex: 0 0 auto;
  min-width: 1.6em;
  color: var(--meo-link);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}

.footnote-body {
  flex: 1 1 auto;
  min-width: 0;
}

.footnote-item + .footnote-item {
  margin-top: 0.45em;
}

.footnote-body > :last-child {
  margin-bottom: 0;
}

.footnote-backref {
  margin-left: 0.35em;
  color: var(--meo-muted);
}

strong { color: var(--meo-strong); font-weight: 700; }
em { font-style: italic; }
mark {
  color: inherit;
  background-color: color-mix(in srgb, #ffd60a 34%, transparent);
  border-radius: 0.14em;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
code {
  font-family: var(--meo-font-code);
  font-weight: inherit;
  font-size: 1em;
  line-height: inherit;
  font-style: inherit;
  text-decoration: inherit;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0;
  text-rendering: auto;
}

p code,
li code,
blockquote code,
td code,
th code {
  padding: 0.08em 0.6em;
  border-radius: 0.35em;
  background: var(--meo-code-bg);
  color: var(--meo-strong);
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 0.08em;
  padding: 0.04em 0.42em 0.1em;
  min-width: 1.3em;
  border: 1px solid var(--meo-kbd-border);
  border-bottom-width: 2px;
  border-radius: 0.35em;
  background: var(--meo-kbd-bg);
  color: var(--meo-fg);
  font-family: var(--meo-font-code);
  font-size: var(--meo-font-size-code);
  font-weight: 600;
  line-height: 1.2;
  vertical-align: baseline;
  white-space: nowrap;
  text-indent: 0;
  box-shadow: inset 0 -1px 0 var(--meo-kbd-shadow);
}

.meo-export-math {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  vertical-align: baseline;
}

.meo-export-math-inline .katex {
  font-size: 1em;
}

.meo-export-math-display {
  display: block;
  margin: 0.25em 0;
  text-align: center;
  overflow-x: clip;
  overflow-y: visible;
  break-inside: avoid;
  page-break-inside: avoid;
}

.meo-export-math-display .katex-display {
  max-width: 100%;
  margin: 0;
  overflow: visible;
}

.meo-export-math-display.meo-export-math-fenced-display {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0;
  padding: 0.45em 0.6em;
  border: 0;
  border-radius: 6px;
  background: var(--meo-code-bg);
  overflow-x: clip;
  overflow-y: visible;
  line-height: 1;
  text-align: center;
}

.meo-export-math-fenced-display > .meo-export-math-canvas {
  position: relative;
  flex: 0 0 auto;
  width: max-content;
  max-width: none;
}

.meo-export-math-fenced-display > .meo-export-math-canvas > .katex-display {
  width: max-content;
  max-width: none;
}

td .meo-export-math-display,
th .meo-export-math-display {
  margin: 0.2em 0;
}

pre.meo-export-code-block {
  padding: 24px 16px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--meo-code-border);
  background: var(--meo-code-bg);
}
.meo-export-code-block-wrap {
  position: relative;
  margin: 0 0 1em;
}
.meo-export-code-block-wrap > pre.meo-export-code-block {
  margin: 0;
}
.meo-export-code-language-label {
  position: absolute;
  top: 6px;
  left: 16px;
  z-index: 1;
  color: var(--meo-muted);
  font-family: var(--meo-font-code);
  font-size: 11px;
  line-height: 1;
  pointer-events: none;
  text-transform: lowercase;
}
.meo-export-code-block-wrap .meo-export-code-language-label + pre.meo-export-code-block {
  padding-top: 34px;
}
pre.meo-export-code-block code {
  display: block;
  font-weight: var(--meo-font-weight-code);
  font-size: var(--meo-font-size-code);
  line-height: var(--meo-code-line-height);
  font-style: normal;
  text-decoration: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  padding: 0;
  border-radius: 0;
  background: transparent;
}

blockquote {
  margin-left: 0;
  padding: 0 0 0 3ch;
  border-left: 3px solid var(--meo-quote);
  background: transparent;
  border-radius: 0;
  color: var(--meo-quote);
}

blockquote > :last-child {
  margin-bottom: 0;
}

hr {
  border: 0;
  height: 1px;
  background: var(--meo-hr);
}

img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
  background: transparent;
}
th, td {
  border: 1px solid var(--meo-table-border);
  padding: 0.55em 0.85em;
  vertical-align: top;
  text-align: left;
  min-height: 1lh;
}
th {
  background: var(--meo-table-header-bg);
  color: var(--meo-fg);
}

.meo-table-scroll {
  width: 100%;
  max-width: 100%;
  margin: 0 0 1em;
  overflow: visible;
}
.meo-table-scroll.meo-export-indented-table {
  width: calc(100% - var(--meo-table-indent));
  margin-left: var(--meo-table-indent);
}
.meo-table-scroll table {
  width: 100%;
  margin: 0;
}
.meo-table-scroll th,
.meo-table-scroll td {
  overflow-wrap: anywhere;
  word-break: normal;
}
.meo-table-scroll ul,
.meo-table-scroll ol {
  padding-inline-start: 2em;
}

td:empty::before,
th:empty::before {
  content: '\\00a0';
  visibility: hidden;
}

/* GitHub Alerts */
.meo-export-alert {
  margin: 1em 0;
  padding: 0 0 0 3ch;
  border-left: 3px solid;
  border-radius: 0;
  background: transparent;
}

.meo-export-alert-note {
  --meo-alert-color: var(--meo-base05);
  border-left-color: var(--meo-base05);
  background-color: color-mix(in srgb, var(--meo-base05) 8%, transparent);
}

.meo-export-alert-tip {
  --meo-alert-color: var(--meo-base09);
  border-left-color: var(--meo-base09);
  background-color: color-mix(in srgb, var(--meo-base09) 8%, transparent);
}

.meo-export-alert-important {
  --meo-alert-color: var(--meo-base08);
  border-left-color: var(--meo-base08);
  background-color: color-mix(in srgb, var(--meo-base08) 8%, transparent);
}

.meo-export-alert-warning {
  --meo-alert-color: var(--meo-base07);
  border-left-color: var(--meo-base07);
  background-color: color-mix(in srgb, var(--meo-base07) 8%, transparent);
}

.meo-export-alert-caution {
  --meo-alert-color: var(--meo-base04);
  border-left-color: var(--meo-base04);
  background-color: color-mix(in srgb, var(--meo-base04) 8%, transparent);
}

.meo-export-alert,
.meo-export-alert p,
.meo-export-alert li,
.meo-export-alert p *,
.meo-export-alert li * {
  color: var(--meo-alert-color);
}

.meo-export-alert-header {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5ch;
  line-height: inherit;
  padding-right: 0.5ch;
  text-indent: 0;
  vertical-align: baseline;
}

.meo-export-alert-icon {
  display: inline-flex;
  align-items: baseline;
  flex: none;
  line-height: inherit;
  vertical-align: baseline;
}

.meo-export-alert-note .meo-export-alert-icon {
  color: var(--meo-base05);
}

.meo-export-alert-tip .meo-export-alert-icon {
  color: var(--meo-base09);
}

.meo-export-alert-important .meo-export-alert-icon {
  color: var(--meo-base08);
}

.meo-export-alert-warning .meo-export-alert-icon {
  color: var(--meo-base07);
}

.meo-export-alert-caution .meo-export-alert-icon {
  color: var(--meo-base04);
}

.meo-export-alert-icon svg {
  width: 16px;
  height: 16px;
  display: block;
  flex: none;
  position: relative;
  top: 0.08em;
}

.meo-export-alert-label {
  display: inline-block;
  font-weight: 500;
  line-height: inherit;
  margin-left: 2px;
  text-indent: 0;
  text-transform: uppercase;
  vertical-align: baseline;
}

.meo-export-alert > p:first-child {
  margin-top: 0;
}

.meo-export-alert > p:last-child {
  margin-bottom: 0;
}

.meo-export-mermaid {
  margin: 0 0 1em;
  border-radius: 6px;
  border: 1px solid var(--meo-code-border);
  background: var(--meo-code-bg);
  overflow: hidden;
}
.meo-export-mermaid .meo-export-mermaid-svg {
  display: flex;
  justify-content: center;
  align-items: center;
  max-width: 100%;
  padding: 0.45em 0;
  overflow: hidden;
}
.meo-export-mermaid .meo-export-mermaid-svg svg {
  max-width: 100%;
  height: auto;
  display: block;
}
.meo-export-mermaid > pre.meo-export-code-block {
  margin: 0;
  border: 0;
  border-radius: 0;
}
.meo-export-mermaid.is-math {
  margin: 0 0 0.9em;
  border: 0;
  background: var(--meo-code-bg);
}
.meo-export-mermaid.is-math .meo-export-mermaid-svg {
  padding: 0.45em 0;
}
.meo-export-mermaid .katex-display {
  margin: 0 !important;
}
.meo-export-mermaid .nodeLabel > div {
  line-height: 1 !important;
}
.meo-export-mermaid .katex-html {
  display: none;
}
.meo-export-mermaid.is-error {
  border-color: var(--meo-mermaid-error-border);
}
.meo-export-mermaid.is-error::before {
  content: 'Mermaid render failed';
  display: block;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--meo-mermaid-error-fg);
}
.meo-export-mermaid.is-rendered pre { display: none; }

/* highlight.js token colors */
.hljs { color: var(--meo-fg); background: transparent; }
.hljs-comment, .hljs-quote { color: var(--meo-muted); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-title.function_ { color: var(--meo-heading); }
.hljs-string, .hljs-regexp { color: var(--meo-strong); }
.hljs-number, .hljs-literal, .hljs-symbol { color: var(--meo-number); }
.hljs-type, .hljs-class, .hljs-built_in, .hljs-function { color: var(--meo-accent-2); }
.hljs-attr, .hljs-attribute, .hljs-property { color: var(--meo-quote); }
.hljs-link { color: var(--meo-link); text-decoration: underline; }

@media (max-width: 700px) {
  .meo-export-page { padding: 12px; }
  .meo-export-doc { padding: 16px; }
  .meo-export-frontmatter-line.is-property {
    grid-template-columns: minmax(90px, 0.36fr) minmax(0, 1fr);
    column-gap: 10px;
  }
}

@page {
  size: A4;
  margin: 0;
}

@media print {
  * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .meo-export-page {
    min-height: auto;
  }
  pre, blockquote, table, img, .meo-export-mermaid, .meo-export-math-display {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
`.trim();
}

function resolveThemeColors(theme: ThemeSettings, environment: ExportStyleEnvironment): ThemeColors {
  const themeColors = theme.colors ?? defaultThemeColors;
  const envColors = environment.meoThemeColors ?? {};
  const resolved = {} as ThemeColors;

  for (const key of Object.keys(defaultThemeColors) as ThemeColorKey[]) {
    resolved[key] =
      sanitizeCssColor(envColors[key] ?? '') ||
      sanitizeCssColor(themeColors[key] ?? '') ||
      defaultThemeColors[key];
  }

  return resolved;
}

function sanitizeCssFont(value: string | undefined): string {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(styleValueInjectionPattern, ' ');
}

function sanitizeFontWeight(value: string | undefined, fallback: string): string {
  const trimmed = sanitizeCssFont(value);
  if (!trimmed) {
    return fallback;
  }
  if (/^var\(\s*--vscode-editor-font-weight\s*\)$/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function resolveThemeFontChoice(
  explicitValue: string,
  themeValue: string,
  fallback: string,
  fallbackDefault: string
): string {
  return explicitValue || themeValue || fallback || fallbackDefault;
}

function sanitizeCssColor(value: string): string {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(styleValueInjectionPattern, ' ');
}

function clampLineHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultThemeFonts.liveLineHeight;
  }
  return Math.min(3, Math.max(1, value));
}

function clampFontSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 14;
  }
  return Math.min(32, Math.max(8, value as number));
}

function resolveThemeFontSizePx(value: number | null | undefined, fallbackPx: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return fallbackPx;
  }
  return clampFontSize(value as number);
}

