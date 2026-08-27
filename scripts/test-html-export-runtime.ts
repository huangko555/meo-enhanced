import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { buildExportHtmlDocument } from '../src/export/exportHtmlTemplate';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-export-runtime-'));

try {
  const outputHtmlPath = path.join(fixtureRoot, 'diagram.html');
  const rendered = exportRuntime.renderExportHtmlDocument({
    readingSnapshot: {
      snapshotId: 'html-runtime',
      text: '```mermaid\ngraph TD\n  A --> B\n```',
      appearance: 'light',
      uiLanguage: 'en',
      environment: { previewFontFamily: '' }
    },
    sourceDocumentPath: path.join(fixtureRoot, 'diagram.md'),
    outputFilePath: outputHtmlPath,
    target: 'html',
    mermaidRuntimeSrc: 'file:///missing-mermaid-runtime.js',
    baseHref: 'file:///',
    title: 'Mermaid export'
  });

  assert.equal(rendered.hasMermaid, true, 'fixture must exercise the Mermaid HTML path');

  await exportRuntime.writeHtmlExport({
    htmlDocument: rendered.htmlDocument,
    outputHtmlPath
  });

  const written = fs.readFileSync(outputHtmlPath, 'utf8');
  assert.equal(written, rendered.htmlDocument, 'HTML export must not require headless-browser finalization');
  assert.match(written, /class="meo-export-mermaid"/);
  assert.match(written, /data-source-b64=/);
  assert.match(written, /missing-mermaid-runtime\.js/);

  const injectedStyles = '.safe{color:green}</StYlE><script data-meo-style-injection>globalThis.__meoInjected=true</script><style>';
  const injectionProbe = buildExportHtmlDocument({
    title: 'Style raw-text safety',
    bodyHtml: '<p class="safe">safe</p>',
    stylesCss: injectedStyles,
    target: 'html',
    hasMermaid: false,
    hasMath: false
  });
  assert.match(injectionProbe, /\.safe\{color:green\}/, 'normal CSS must remain unchanged');
  assert.doesNotMatch(
    injectionProbe,
    /<\/style><script data-meo-style-injection>/i,
    'internal CSS must not terminate its containing style element'
  );

  console.log('HTML export runtime contract passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
