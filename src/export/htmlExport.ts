import * as fs from 'node:fs/promises';
import { finalizeHtmlExportInHeadlessBrowser } from './pdfRenderer';

export type WriteHtmlExportOptions = {
  htmlDocument: string;
  outputHtmlPath: string;
  puppeteerRuntimeModulePath?: string;
  timeoutMs?: number;
  skipHeadlessFinalize?: boolean;
};

export async function writeFinalizedHtmlExport(options: WriteHtmlExportOptions): Promise<void> {
  if (options.skipHeadlessFinalize) {
    await fs.writeFile(options.outputHtmlPath, options.htmlDocument, 'utf8');
    return;
  }
  const finalizedHtml = await finalizeHtmlExportInHeadlessBrowser({
    htmlDocument: options.htmlDocument,
    puppeteerRuntimeModulePath: options.puppeteerRuntimeModulePath,
    timeoutMs: options.timeoutMs
  });
  await fs.writeFile(options.outputHtmlPath, finalizedHtml, 'utf8');
}
