export type BlockWidgetHeightRequest =
  | { kind: 'long-code-control'; measuredHeight?: number }
  | {
      kind: 'mermaid-preview';
      source: string;
      displayMath: boolean;
      measuredHeight?: number;
      contentWidth?: number;
    }
  | {
      kind: 'rendered-block-editor';
      renderer: 'mermaid' | 'latex';
      mode: 'source' | 'split';
      source: string;
      measuredHeight?: number;
      contentWidth?: number;
    }
  | {
      kind: 'latex-display';
      html: string;
      measuredHeight?: number;
    }
  | {
      kind: 'table';
      headerCells: readonly string[];
      rows: readonly (readonly string[])[];
      measuredHeight?: number;
      contentWidth?: number;
    }
  | {
      kind: 'html-block';
      source: string;
      collapsed: boolean;
      measuredHeight?: number;
    };

type BlockWidgetLayoutMetrics = {
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  lineHeight: number;
  contentWidth: number;
};

const FALLBACK_FONT_SIZE = 16;
const FALLBACK_CONTENT_WIDTH = 900;
const MIN_ESTIMATE = 16;
const MAX_ESTIMATE = 12_000;

function finitePositive(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

function boundedHeight(value: number): number {
  return Math.max(MIN_ESTIMATE, Math.min(MAX_ESTIMATE, value));
}

function readLayoutMetrics(contentWidth?: number): BlockWidgetLayoutMetrics {
  const editor = typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>('.editor-host > .cm-editor.meo-mode-live, .cm-editor.meo-mode-live');
  const content = editor?.querySelector<HTMLElement>('.cm-content');
  const style = (content ?? editor) && typeof getComputedStyle === 'function'
    ? getComputedStyle(content ?? editor!)
    : null;
  const fontSize = Number.parseFloat(style?.fontSize ?? '') || FALLBACK_FONT_SIZE;
  const fontFamily = style?.fontFamily || 'sans-serif';
  const fontWeight = style?.fontWeight || '400';
  const parsedLineHeight = Number.parseFloat(style?.lineHeight ?? '');
  const lineHeight = parsedLineHeight > 0 ? parsedLineHeight : fontSize * 1.5;
  const resolvedContentWidth = finitePositive(contentWidth)
    ? contentWidth
    : content && content.clientWidth > 0
      ? content.clientWidth
      : FALLBACK_CONTENT_WIDTH;
  return { fontSize, fontFamily, fontWeight, lineHeight, contentWidth: resolvedContentWidth };
}

function sourceLineCount(source: string): number {
  return Math.max(1, source.split(/\r?\n/).length);
}

function mermaidPreviewHeight(source: string, metrics: BlockWidgetLayoutMetrics): number {
  const lines = sourceLineCount(source);
  const normalized = source.trimStart().toLowerCase();
  if (/^sequencediagram\b/.test(normalized)) {
    return lines * 2 * metrics.lineHeight + metrics.fontSize * 8;
  }
  if (/^(?:flowchart|graph)\b/.test(normalized)) {
    const vertical = /^(?:flowchart|graph)\s+(?:tb|td)\b/.test(normalized);
    return lines * metrics.lineHeight * (vertical ? 1.512 : 1) + metrics.fontSize * 4;
  }
  if (/^(?:gantt|timeline|journey)\b/.test(normalized)) {
    return (lines * 1.75 + 2) * metrics.lineHeight;
  }
  return Math.max(8 * metrics.lineHeight, (lines * 1.4 + 2) * metrics.lineHeight);
}

function renderedBlockEditorHeight(
  request: Extract<BlockWidgetHeightRequest, { kind: 'rendered-block-editor' }>,
  metrics: BlockWidgetLayoutMetrics
): number {
  const sourceHeight = Math.max(4, sourceLineCount(request.source)) * metrics.lineHeight + metrics.fontSize;
  if (request.mode === 'source') return sourceHeight;
  const previewHeight = request.renderer === 'mermaid'
    ? mermaidPreviewHeight(request.source, metrics)
    : Math.max(metrics.lineHeight, metrics.fontSize * 1.2);
  // Wide layouts place source and preview side by side; narrow layouts stack them.
  return metrics.contentWidth >= 720
    ? Math.max(sourceHeight, previewHeight)
    : sourceHeight + previewHeight;
}

function visualText(source: string): string {
  return source
    .replace(/(^|[^\\])<br\s*\/?>/gi, '$1\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(?:\*\*|__|~~|==|`)/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function visualLineWidths(source: string, metrics: BlockWidgetLayoutMetrics): readonly number[] {
  return visualText(source).split(/\r?\n/).map((line) => textWidth(line, metrics));
}

let textMeasurementContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, metrics: BlockWidgetLayoutMetrics): number {
  if (typeof document !== 'undefined') {
    if (textMeasurementContext === undefined) {
      textMeasurementContext = document.createElement('canvas').getContext('2d');
    }
    if (textMeasurementContext) {
      textMeasurementContext.font = `${metrics.fontWeight} ${metrics.fontSize}px ${metrics.fontFamily}`;
      return textMeasurementContext.measureText(text).width;
    }
  }
  let width = 0;
  for (const character of text) {
    if (/\s/.test(character)) width += metrics.fontSize * 0.35;
    else if (/[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(character)) width += metrics.fontSize;
    else width += metrics.fontSize * 0.58;
  }
  return width;
}

function estimateTableHeight(
  request: Extract<BlockWidgetHeightRequest, { kind: 'table' }>,
  metrics: BlockWidgetLayoutMetrics
): number {
  const matrix = [request.headerCells, ...request.rows];
  const columnCount = Math.max(1, request.headerCells.length, ...request.rows.map((row) => row.length));
  const desiredColumnWidths = Array.from({ length: columnCount }, (_, column) => {
    const desired = Math.max(...matrix.map((row) => (
      Math.max(...visualLineWidths(row[column] ?? '', metrics)) + metrics.fontSize
    )));
    return Math.max(64, Math.min(metrics.contentWidth, desired));
  });
  const desiredTotal = desiredColumnWidths.reduce((sum, width) => sum + width, 0);
  const tableWidth = Math.max(352, Math.min(Math.max(352, metrics.contentWidth - 24), desiredTotal));
  const widthScale = tableWidth / desiredTotal;
  const contentWidths = desiredColumnWidths.map((width) => Math.max(32, width * widthScale - metrics.fontSize));
  const cellVerticalInset = metrics.fontSize * 0.5625;

  return matrix.reduce((height, row) => {
    const wrappedLines = row.reduce((maximum, cell, column) => {
      // The source editor is hidden outside an active cell. Reserving height for
      // Markdown punctuation or image URLs makes virtual rows taller than their
      // rendered table and causes a correction when the table first mounts.
      const renderedLines = visualLineWidths(cell, metrics).reduce((sum, width) => (
        sum + Math.max(1, Math.ceil(width / (contentWidths[column] ?? 32)))
      ), 0);
      const sourceLines = cell.split(/\r?\n/).reduce((sum, line) => (
        sum + Math.max(1, Math.ceil(textWidth(line, metrics) / (contentWidths[column] ?? 32)))
      ), 0);
      // A table row reserves enough room for both its rendered preview and the
      // hidden Markdown textarea, so focusing a cell never changes row height.
      return Math.max(maximum, renderedLines, sourceLines);
    }, 1);
    return height + metrics.lineHeight * wrappedLines + cellVerticalInset;
  }, 0);
}

function estimateHtmlBlockHeight(
  request: Extract<BlockWidgetHeightRequest, { kind: 'html-block' }>,
  metrics: BlockWidgetLayoutMetrics
): number {
  if (request.collapsed) return metrics.lineHeight;
  const count = (pattern: RegExp): number => request.source.match(pattern)?.length ?? 0;
  const tableRows = count(/<tr\b/gi);
  if (tableRows > 0) {
    return tableRows * (metrics.lineHeight + metrics.fontSize * 0.9);
  }

  const listItems = count(/<li\b/gi);
  if (listItems > 0) {
    return listItems * (metrics.lineHeight + metrics.fontSize * 0.2);
  }

  const summaries = count(/<summary\b/gi);
  const paragraphs = count(/<p\b/gi);
  if (summaries > 0) {
    return Math.max(1, summaries + paragraphs) * (metrics.lineHeight + metrics.fontSize * 0.55);
  }
  if (/<blockquote\b/i.test(request.source)) {
    return Math.max(1, paragraphs) * (metrics.lineHeight + metrics.fontSize * 0.2);
  }
  if (paragraphs > 0) {
    const paragraphHeight = paragraphs * (metrics.lineHeight + metrics.fontSize * 0.55);
    const containerGap = paragraphs > 1 ? metrics.fontSize * 0.95 : 0;
    const imageFallback = /<img\b/i.test(request.source) ? metrics.lineHeight * 1.5 : 0;
    return paragraphHeight + containerGap + imageFallback;
  }

  const headings = count(/<h[1-6]\b/gi);
  return Math.max(1, headings) * (metrics.lineHeight + metrics.fontSize * 0.55);
}

/**
 * Supplies CodeMirror with a useful height before an off-screen replacement
 * widget is mounted. The result is deliberately conservative: measuring a
 * block slightly early is cheaper than correcting the visible document late.
 */
export function estimateBlockWidgetHeight(request: BlockWidgetHeightRequest): number {
  if (finitePositive(request.measuredHeight)) return boundedHeight(request.measuredHeight);
  const metrics = readLayoutMetrics('contentWidth' in request ? request.contentWidth : undefined);
  switch (request.kind) {
    case 'long-code-control':
      return boundedHeight(metrics.fontSize * 2.4);
    case 'mermaid-preview':
      return boundedHeight(request.displayMath
        ? Math.max(metrics.fontSize * 1.2, metrics.lineHeight * 0.8)
        : mermaidPreviewHeight(request.source, metrics));
    case 'rendered-block-editor':
      return boundedHeight(renderedBlockEditorHeight(request, metrics));
    case 'latex-display':
      return boundedHeight(
        request.html.includes('class="mfrac"')
          ? metrics.fontSize * 2.27734375
          : (request.html.match(/op-symbol large-op/g)?.length ?? 0) >= 2
            ? metrics.fontSize * 1.9111328125
            : Math.max(1, Math.min(6, request.html.match(/class="mtr"/g)?.length ?? 1)) * metrics.fontSize * 1.2
      );
    case 'table':
      return boundedHeight(estimateTableHeight(request, metrics));
    case 'html-block':
      return boundedHeight(estimateHtmlBlockHeight(request, metrics));
  }
}
