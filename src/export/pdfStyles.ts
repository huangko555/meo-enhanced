export const DEFAULT_PDF_MARGIN_MM = 20;

/** Paper shares the preset canvas; the fallback layer preserves explicit user margins. */
export function buildPdfExportStyles(presetStyles: string): string {
  return `@layer meo-pdf-default { @page { size: A4; margin: ${DEFAULT_PDF_MARGIN_MM}mm; background: var(--meo-bg); } }
${presetStyles}
/* Screen document padding must not add a second set of PDF page margins. */
html[data-meo-export-target='pdf'] .meo-export-page,
html[data-meo-export-target='pdf'] .meo-export-doc {
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
}
`;
}
