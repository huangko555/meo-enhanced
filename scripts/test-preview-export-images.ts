import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import exportRuntime from '../src/export/runtime';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-image-'));
const localImagePath = path.join(tempDir, 'absolute-image.png');
const pngBytes = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ),
  Buffer.alloc(2 * 1024 * 1024)
]);
fs.writeFileSync(localImagePath, pngBytes);

const remoteImageUrl = 'https://i2.hdslb.com/bfs/banner/example.jpg@976w_550h_!web-home-carousel-cover.avif';
const markdownText = `![local](${localImagePath} "title")\n\n<img src="${localImagePath}" alt="raw local">\n\n![remote](${remoteImageUrl})\n\n![missing fallback](missing-image.png)`;
const baseOptions = {
  sourceDocumentPath: path.join(tempDir, 'document.md'),
  mermaidRuntimeSrc: 'mermaid.min.js',
  baseHref: `file:///${tempDir.replace(/\\/g, '/')}/`,
  title: 'Image coverage'
};

try {
  const preview = exportRuntime.renderPreviewDocument({ ...baseOptions, markdownText, uiLanguage: 'en', styleEnvironment: { previewFontFamily: '' } });
  const exported = exportRuntime.renderExportHtmlDocument({
    ...baseOptions,
    readingSnapshot: { snapshotId: 'images-html', text: markdownText, appearance: 'dark', uiLanguage: 'en', environment: { previewFontFamily: '' } },
    outputFilePath: path.join(tempDir, 'export.html'),
    target: 'html' as const
  });
  const pdf = exportRuntime.renderExportHtmlDocument({
    ...baseOptions,
    readingSnapshot: { snapshotId: 'images-pdf', text: markdownText, appearance: 'dark', uiLanguage: 'en', environment: { previewFontFamily: '' } },
    outputFilePath: path.join(tempDir, 'export.pdf'),
    target: 'pdf' as const
  });

  if (preview.html.includes('src="data:image/png;base64,')) {
    throw new Error('Preview copied local image bytes into its first HTML payload');
  }
  if (preview.html.length > 20_000) {
    throw new Error(`Large local images inflated the first Preview payload to ${preview.html.length} characters`);
  }
  const deferredImages = preview.html.match(/data-meo-deferred-image-src=/g) ?? [];
  if (deferredImages.length !== 4 || !preview.html.includes('alt="raw local"')) {
    throw new Error(`Preview did not defer local and network images (${deferredImages.length})`);
  }
  if (!preview.html.includes(`data-meo-deferred-image-src="${remoteImageUrl}"`)) {
    throw new Error('A network image can still block Preview frame readiness');
  }
  for (const html of [exported.htmlDocument, pdf.htmlDocument]) {
    if (html.includes('data-meo-deferred-image-src=') || !html.includes(`src="${remoteImageUrl}"`)) {
      throw new Error('Export images must load without the Preview resource lifecycle');
    }
  }
  for (const [surface, html] of [['Preview', preview.html], ['Export', exported.htmlDocument]] as const) {
    if (!html.includes(remoteImageUrl)) throw new Error(`${surface} changed or dropped a valid remote AVIF image URL`);
    if (!html.includes('alt="missing fallback"')) throw new Error(`${surface} dropped fallback alt text`);
    if (html.includes('meo-md-image-controls')) throw new Error(`${surface} exposed Live image controls`);
  }
  if (!exported.htmlDocument.includes('src="data:image/png;base64,')) {
    throw new Error('HTML export did not embed a Windows absolute-path image');
  }
  if (!pdf.htmlDocument.includes(pathToFileURL(localImagePath).toString())) {
    throw new Error('PDF export did not convert a Windows absolute-path image to a file URL');
  }
  if (!pdf.htmlDocument.includes(remoteImageUrl)) {
    throw new Error('PDF export changed or dropped a valid remote AVIF image URL');
  }

  console.log('Preview and export image checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
