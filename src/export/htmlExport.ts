import * as fs from 'node:fs/promises';

export type WriteHtmlExportOptions = {
  htmlDocument: string;
  outputHtmlPath: string;
};

export async function writeHtmlExport(options: WriteHtmlExportOptions): Promise<void> {
  await fs.writeFile(options.outputHtmlPath, options.htmlDocument, 'utf8');
}
