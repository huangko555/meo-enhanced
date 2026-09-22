import HTMLtoDOCX from '@shyang1012/docx-convert';

export async function convertHtmlToDocx(
  html: string,
  options: { readonly lang: string; readonly title: string }
): Promise<Buffer> {
  const output = await HTMLtoDOCX(html, null, {
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 20, right: 20, bottom: 20, left: 20 },
      autoDetectContainer: false
    },
    title: options.title,
    creator: 'MEO Enhanced',
    font: 'DengXian',
    fontSize: 22,
    lineHeight: 1.15,
    paragraphSpacingAfter: 160,
    lang: options.lang,
    table: { row: { cantSplit: true } },
    imageProcessing: {
      svgHandling: 'native',
      suppressSharpWarning: true
    }
  });
  if (Buffer.isBuffer(output)) return output;
  if (output instanceof ArrayBuffer) return Buffer.from(output);
  return Buffer.from(await output.arrayBuffer());
}
