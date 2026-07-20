import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import exportRuntime from '../src/export/runtime';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-image-'));
const localImagePath = path.join(tempDir, 'absolute-image.png');
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
fs.writeFileSync(localImagePath, pngBytes);

const remoteImageUrl = 'https://i2.hdslb.com/bfs/banner/example.jpg@976w_550h_!web-home-carousel-cover.avif';
const markdownText = `![local](${localImagePath} "title")\n\n![remote](${remoteImageUrl})`;
const baseOptions = {
  markdownText,
  sourceDocumentPath: path.join(tempDir, 'document.md'),
  theme: defaultThemeSettings,
  appearance: 'dark' as const,
  styleEnvironment: {},
  mermaidRuntimeSrc: 'mermaid.min.js',
  baseHref: `file:///${tempDir.replace(/\\/g, '/')}/`,
  title: 'Image coverage'
};

try {
  const preview = exportRuntime.renderPreviewDocument(baseOptions);
  const exported = exportRuntime.renderExportHtmlDocument({
    ...baseOptions,
    outputFilePath: path.join(tempDir, 'export.html'),
    target: 'html' as const,
    htmlImageMode: 'embedded' as const
  });
  const pdf = exportRuntime.renderExportHtmlDocument({
    ...baseOptions,
    outputFilePath: path.join(tempDir, 'export.pdf'),
    target: 'pdf' as const,
    htmlImageMode: 'embedded' as const
  });

  for (const [surface, html] of [
    ['Preview', preview.html],
    ['Export', exported.htmlDocument]
  ] as const) {
    if (!html.includes('src="data:image/png;base64,')) {
      throw new Error(`${surface} did not embed a Windows absolute-path image`);
    }
    if (!html.includes(remoteImageUrl)) {
      throw new Error(`${surface} changed or dropped a valid remote AVIF image URL`);
    }
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
