const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtimePath = path.resolve(__dirname, '..', 'dist', 'export-runtime.js');
  const importedRuntime = await import(pathToFileURL(runtimePath).href);
  let current = importedRuntime;
  let runtime = null;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current && typeof current.renderExportHtmlDocument === 'function') {
      runtime = current;
      break;
    }
    if (!current || typeof current !== 'object' || !('default' in current)) break;
    current = current.default;
  }
  assert.ok(runtime, 'built export runtime did not expose renderExportHtmlDocument in Node');

  const rendered = await runtime.renderExportHtmlDocument({
    readingSnapshot: {
      snapshotId: 'export-shiki-runtime-node',
      text: [
        '```ts',
        'const answer: number = 42;',
        '```',
        '',
        '```zig',
        'const answer: u8 = 42;',
        '```',
        '',
        '```wolfram',
        'Plot[x^2, {x, 0, 1}]',
        '```'
      ].join('\n'),
      appearance: 'dark',
      uiLanguage: 'en',
      environment: {
        previewFontFamily: '',
        editorBackgroundColor: '#1e1e1e',
        editorForegroundColor: '#d4d4d4',
        codeBlockBackgroundColor: '#1e1e1e',
        sideBarBackgroundColor: '#252526',
        panelBorderColor: '#454545',
        previewSourceColoring: true
      }
    },
    sourceDocumentPath: 'C:/tmp/source.md',
    outputFilePath: 'C:/tmp/export.html',
    target: 'html',
    mermaidRuntimeSrc: '',
    baseHref: 'file:///C:/tmp/',
    title: 'Export Shiki Node runtime'
  });

  assert.equal((rendered.htmlDocument.match(/<div class="meo-export-code-block-wrap/g) ?? []).length, 3);
  assert.ok(
    (rendered.htmlDocument.match(/<span style="color:/g) ?? []).length >= 3,
    'Node export runtime must highlight common and uncommon languages through shared assets'
  );
  console.log('Export Shiki Node runtime passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
