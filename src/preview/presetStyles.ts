import { buildPreviewStyles, type ExportStyleEnvironment } from '../export/exportStyles';
import { normalizeEditorLineHeight } from '../foundation/editorLineHeight';
import { getPreviewPreset, resolvePresetAppearance, type PreviewPresetId, type PreviewContentWidth, type PreviewPresetDefinition } from '../foundation/previewPresets';
import { getGithubMarkdownStyles } from './presets/github-readme/styles.js';
import { getReadingPresetStyles } from './presets/reading/styles.js';
import { normalizePreviewFontFamily } from '../protocol/editorStyleEnvironment';
import { readingMathReflowCss } from '../shared/mathStyles';

export function buildPresetPreviewStyles(
  preset: PreviewPresetId,
  environment: ExportStyleEnvironment,
  appearance: 'light' | 'dark',
  _contentWidth: PreviewContentWidth = 'responsive',
  definition: PreviewPresetDefinition = getPreviewPreset(preset)
): string {
  // A shared pixel basis keeps all presets readable at the user's editor size.
  const bodyFontSize = Number.isFinite(environment.editorFontSizePx) ? Math.min(32, Math.max(8, environment.editorFontSizePx!)) : 14;
  const fontSizeStyles = `:root { --meo-font-size-body: ${bodyFontSize}px; --meo-font-size-code: calc(var(--meo-font-size-body) * 0.88); }
.meo-export-doc { font-size: var(--meo-font-size-body); }
.meo-export-doc .meo-export-code-language-label { font-size: calc(var(--meo-font-size-body) * 0.75); }
`;
  // Non-default presets own document colors; only typography and switches inherit.
  const baseEnvironment: ExportStyleEnvironment = {
    previewFontFamily: '',
    previewCodeFontFamily: '',
    editorFontFamily: environment.editorFontFamily,
    editorFontSizePx: environment.editorFontSizePx,
    editorFontWeight: environment.editorFontWeight,
    liveFontWeight: environment.liveFontWeight,
    sourceFontWeight: environment.sourceFontWeight,
    previewSourceColoring: environment.previewSourceColoring,
    previewShowComments: environment.previewShowComments,
    previewThemeIsolation: true
  };
  const fontFamily = definition.controls.fontFamily.mode === 'editable' ? normalizePreviewFontFamily(environment.previewFontFamily) : null;
  const codeFontFamily = definition.controls.fontFamily.mode === 'editable' ? normalizePreviewFontFamily(environment.previewCodeFontFamily ?? '') : null;
  // Override family names only; inline and block code retain their separate typography.
  const fontOverride = fontFamily ? `.meo-export-doc { --meo-font-body: "${fontFamily}", var(--meo-preset-font-body, var(--meo-font-system-sans)); font-family: var(--meo-font-body); }` : '';
  const codeFontOverride = codeFontFamily ? `.meo-export-doc { --meo-font-code: "${codeFontFamily}", var(--meo-preset-font-code, var(--meo-font-system-mono)); }
.meo-export-doc :is(code, pre, .meo-export-code-language-label, .meo-export-code-line-source) { font-family: var(--meo-font-code); }` : '';
  if (definition.custom) {
    const custom = definition.custom;
    const effective = resolvePresetAppearance(definition, appearance, appearance);
    return `${buildPresetPreviewStyles(custom.base, baseEnvironment, effective, _contentWidth)}
body, .meo-export-page, .meo-export-doc { background: var(--meo-bg); }
.meo-export-doc { color: var(--meo-fg); }
html { scrollbar-color: color-mix(in srgb, var(--meo-fg) 38%, transparent) var(--meo-bg); }
html::-webkit-scrollbar-track, body::-webkit-scrollbar-track { background: var(--meo-bg); }
${custom.css.common ?? ''}
${custom.css[effective] ?? ''}
${fontOverride}
${codeFontOverride}
${fontSizeStyles}
html[data-meo-export-target='pdf'] .meo-export-doc { box-sizing: border-box; width: 100%; max-width: none; }
`;
  }
  if (definition.renderer === 'meo') {
    if (preset === 'default') return `${buildPreviewStyles(environment, appearance)}\n${fontSizeStyles}\n.meo-export-doc { --meo-line-height: ${normalizeEditorLineHeight(environment.liveLineHeight)}; }`;
    const effective = resolvePresetAppearance(definition, appearance, appearance);
    return `${buildPreviewStyles(baseEnvironment, effective)}\n${getReadingPresetStyles(preset, effective)}\n${fontOverride}\n${codeFontOverride}\n${fontSizeStyles}`;
  }
  const background = appearance === 'light' ? '#ffffff' : '#0d1117';
  const foreground = appearance === 'light' ? '#1f2328' : '#f0f6fc';
  return `${getGithubMarkdownStyles(appearance)}
${fontSizeStyles}
html { --meo-fg: ${foreground}; --meo-code-fg: ${foreground}; --meo-bg: ${background}; --meo-mermaid-background: ${background}; --meo-mermaid-node-background: ${appearance === 'light' ? '#f6f8fa' : '#151b23'}; --meo-mermaid-foreground: ${foreground}; --meo-mermaid-border: ${appearance === 'light' ? '#d1d9e0' : '#3d444d'}; --meo-mermaid-line: ${foreground}; }
/* Transparent native tracks expose the VS Code host rather than the reading background. */
html[data-meo-preview-preset='github-readme'],
html[data-meo-preview-preset='github-readme'] body { scrollbar-color: color-mix(in srgb, var(--meo-fg) 38%, transparent) var(--meo-bg); }
html[data-meo-preview-preset='github-readme']::-webkit-scrollbar-track,
html[data-meo-preview-preset='github-readme'] body::-webkit-scrollbar-track { background: var(--meo-bg) !important; }
body { margin: 0; background: ${background}; color: ${foreground}; }
.meo-export-page { min-height: 100vh; }
.markdown-body { --borderColor-muted: ${appearance === 'light' ? '#d1d9e0b3' : '#3d444db3'}; box-sizing: border-box; padding: 32px; width: 100%; max-width: 1076px; margin: 0 auto; font-family: 'Mona Sans VF', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'; }
@media (max-width: 767px) { .markdown-body { padding: 16px; } }
.markdown-body .meo-table-scroll { overflow-x: auto; }
.markdown-body .meo-table-scroll :is(th, td) { overflow-wrap: normal; word-break: normal; }
.markdown-body .meo-table-scroll :is(pre, code) { white-space: pre; overflow-wrap: normal; word-break: normal; }
.markdown-body table { table-layout: auto; }
.markdown-body a { text-decoration: underline; text-underline-offset: .2rem; }
/* Preview stores href separately for Host navigation; these remain active links. */
.markdown-body a[data-meo-preview-href] { color: ${appearance === 'light' ? '#0969da' : '#4493f8'}; text-decoration: underline; }
.markdown-body .meo-export-code-language-label, .markdown-body .meo-export-code-line-number { display: none; }
.markdown-body .meo-export-code-block-wrap { margin-bottom: 16px; position: relative; }
.markdown-body .meo-export-code-block-wrap pre { margin: 0; }
.markdown-body .meo-export-code-block-wrap pre > code { display: block; white-space: normal; }
.markdown-body .meo-export-code-line { display: block; }
.markdown-body .meo-export-code-line-source { white-space: pre; }
.markdown-body .meo-export-task-item { list-style: none; }
.markdown-body .meo-export-task-checkbox { margin: 0 .2em .25em -1.4em; vertical-align: middle; }
.markdown-body .meo-export-alert { padding: 8px 16px; border-left: 4px solid var(--meo-alert-color); color: inherit; }
.markdown-body .meo-export-alert-note { --meo-alert-color: ${appearance === 'light' ? '#0969da' : '#4493f8'}; }
.markdown-body .meo-export-alert-tip { --meo-alert-color: ${appearance === 'light' ? '#1a7f37' : '#3fb950'}; }
.markdown-body .meo-export-alert-important { --meo-alert-color: ${appearance === 'light' ? '#8250df' : '#ab7df8'}; }
.markdown-body .meo-export-alert-warning { --meo-alert-color: ${appearance === 'light' ? '#9a6700' : '#d29922'}; }
.markdown-body .meo-export-alert-caution { --meo-alert-color: ${appearance === 'light' ? '#d1242f' : '#f85149'}; }
.markdown-body .meo-export-alert-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-weight: 500; line-height: 1; color: var(--meo-alert-color); }
.markdown-body .meo-export-alert-icon { display: inline-flex; }
.markdown-body .meo-export-alert-icon svg { width: 16px; height: 16px; }
.markdown-body .meo-export-alert > :last-child { margin-bottom: 0; }
.markdown-body .meo-export-mermaid { margin-bottom: 16px; padding-top: 0; }
.markdown-body .meo-export-mermaid.is-rendered > pre { display: none; }
.markdown-body .meo-export-mermaid-svg svg { display: block; max-width: 100%; height: auto; margin-inline: auto; }
.markdown-body .meo-export-math-display { display: block; text-align: center; margin-bottom: 16px; }
.markdown-body .meo-export-math-display .meo-export-math-canvas { margin-left: auto; margin-right: auto; }
${readingMathReflowCss}
.markdown-body .footnotes p { margin-top: 16px; }
.markdown-body .footnote-backref { text-decoration: underline; }
html[data-meo-export-target='pdf'] .markdown-body .meo-table-scroll { overflow: visible; }
html[data-meo-export-target='pdf'] .markdown-body table { display: table; width: 100%; }
html[data-meo-export-target='pdf'] .markdown-body .meo-table-scroll :is(th, td, pre, code) { overflow-wrap: anywhere; white-space: normal; }
html[data-meo-export-target='pdf'] .markdown-body .meo-export-code-line-source,
html[data-meo-export-target='pdf'] .markdown-body pre { white-space: pre-wrap; overflow-wrap: anywhere; }
html[data-meo-export-target='pdf'] .markdown-body .meo-export-code-line-source { min-width: 0; }
html[data-meo-export-target='pdf'] .markdown-body :is(h1, h2, h3, h4, h5, h6) { break-after: avoid-page; }
html[data-meo-export-target='pdf'] .markdown-body :is(pre, blockquote, table, .meo-export-alert) { break-inside: avoid; }
html[data-meo-export-target='pdf'] .markdown-body [data-meo-pdf-allow-break] { break-inside: auto; }
@media print {
  .markdown-body { max-width: none; padding: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .meo-export-page { min-height: 0; }
  .markdown-body .meo-table-scroll { overflow: visible; }
  .markdown-body table { display: table; width: 100%; }
  .markdown-body .meo-table-scroll :is(th, td) { overflow-wrap: anywhere; }
  .markdown-body .meo-export-code-line-source, .markdown-body pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .markdown-body .meo-export-code-line-source { min-width: 0; }
}
`;
}
