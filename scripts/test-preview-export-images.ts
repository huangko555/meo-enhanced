import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import exportRuntime from '../src/export/runtime';
import { mapHtmlSrcset, normalizeHtmlAttribute } from '../src/shared/htmlPolicy';
import assert from 'node:assert/strict';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-image-'));
const localImagePath = path.join(tempDir, 'absolute-image.png');
// Keep drive-path coverage on Windows; leading slash destinations are document/workspace-relative.
const localImageTarget = process.platform === 'win32' ? localImagePath : pathToFileURL(localImagePath).toString();
const pngBytes = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ),
  Buffer.alloc(2 * 1024 * 1024)
]);
fs.writeFileSync(localImagePath, pngBytes);

const remoteImageUrl = 'https://i2.hdslb.com/bfs/banner/example.jpg@976w_550h_!web-home-carousel-cover.avif';
const markdownText = `![local](${localImageTarget} "title")\n\n<img src="${localImageTarget}" alt="raw local">\n\n![remote](${remoteImageUrl})\n\n![missing fallback](missing-image.png)`;
const baseOptions = {
  sourceDocumentPath: path.join(tempDir, 'document.md'),
  mermaidRuntimeSrc: 'mermaid.min.js',
  baseHref: pathToFileURL(tempDir + path.sep).toString(),
  title: 'Image coverage'
};

try {
  for (const [tag, attribute] of [['a', 'href'], ['img', 'src']] as const) {
    assert.equal(normalizeHtmlAttribute(tag, attribute, '//images.example.test/image.png'), '//images.example.test/image.png');
    for (const unsafe of ['javascript:alert(1)', 'java\nscript:alert(1)', 'vbscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
      assert.equal(normalizeHtmlAttribute(tag, attribute, unsafe), null, `${tag} rejects ${JSON.stringify(unsafe)}`);
    }
  }
  assert.equal(mapHtmlSrcset('//images.example.test/a.png 1x, https://images.example.test/b.png 2x', url => url),
    '//images.example.test/a.png 1x, https://images.example.test/b.png 2x');
  assert.equal(mapHtmlSrcset('//images.example.test/a.png 1x, javascript:alert(1) 2x', url => url), '');
  const preview = exportRuntime.renderPreviewDocument({ ...baseOptions, markdownText, uiLanguage: 'en', styleEnvironment: { previewFontFamily: '' } });
  const exported = await exportRuntime.renderExportHtmlDocument({
    ...baseOptions,
    readingSnapshot: { snapshotId: 'images-html', text: markdownText, appearance: 'dark', uiLanguage: 'en', environment: { previewFontFamily: '' } },
    outputFilePath: path.join(tempDir, 'export.html'),
    target: 'html' as const
  });
  const pdf = await exportRuntime.renderExportHtmlDocument({
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
    throw new Error('HTML export did not embed a local absolute image target');
  }
  if (!pdf.htmlDocument.includes(pathToFileURL(localImagePath).toString())) {
    throw new Error('PDF export did not preserve the local image file URL');
  }
  if (!pdf.htmlDocument.includes(remoteImageUrl)) {
    throw new Error('PDF export changed or dropped a valid remote AVIF image URL');
  }

  for (const source of ['http://images.example.test/image.png', '//images.example.test/image.png']) {
    const text = `![remote](${source})\n\n<img src="${source}" alt="HTML remote">`;
    const previewVariant = exportRuntime.renderPreviewDocument({ ...baseOptions, markdownText: text, uiLanguage: 'en' });
    if (previewVariant.html.split(`data-meo-deferred-image-src="${source}"`).length - 1 !== 2) {
      throw new Error(`Preview did not defer both network image syntaxes: ${source}`);
    }
    for (const target of ['html', 'pdf'] as const) {
      const exportedVariant = (await exportRuntime.renderExportHtmlDocument({
        ...baseOptions, target, outputFilePath: path.join(tempDir, `variant.${target}`),
        readingSnapshot: { snapshotId: `network-${target}`, text, appearance: 'dark', uiLanguage: 'en', environment: {} }
      })).htmlDocument;
      if (exportedVariant.includes('data-meo-deferred-image-src=')) {
        throw new Error(`${target} export depends on Preview's resource lifecycle: ${source}`);
      }
      if (source.startsWith('http:') && !exportedVariant.includes(`src="${source}"`)) {
        throw new Error(`${target} export changed an HTTP image source`);
      }
    }
  }

  const networkImage = '//images.example.test/image.png';
  for (const target of ['html', 'pdf', 'docx'] as const) for (const [text, expected] of [
    [`![remote](${networkImage})`, `src="https:${networkImage}"`],
    [`<img src="${networkImage}" alt="remote">`, `src="https:${networkImage}"`],
    [`<img srcset="${networkImage} 2x" alt="remote">`, `srcset="https:${networkImage} 2x"`],
    [`<video poster="${networkImage}"></video>`, `poster="https:${networkImage}"`],
    [`<p style="background-image:url(${networkImage})">remote</p>`, `https:${networkImage}`],
    [`<p style="background-image:url(' ${networkImage} ')">remote</p>`, `https:${networkImage}`]
  ] as const) {
    const { htmlDocument } = await exportRuntime.renderExportHtmlDocument({
      ...baseOptions, target, outputFilePath: path.join(tempDir, 'output', `network.${target}`),
      readingSnapshot: { snapshotId: `network-path-${target}`, text, appearance: 'dark', uiLanguage: 'en', environment: {} }
    });
    assert.ok(htmlDocument.includes(expected), `${target} export resolves ${text}`);
    assert.ok(!htmlDocument.includes('file://images.example.test'), `${target} export writes no file address on another host: ${text}`);
  }

  console.log('Preview and export image checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
