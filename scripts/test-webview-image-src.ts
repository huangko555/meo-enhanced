import * as path from 'node:path';
import { mock } from 'bun:test';

class TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(fsPath: string, scheme = 'file', query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = '';
    this.fsPath = path.normalize(fsPath);
    const uriPath = this.fsPath.replace(/\\/g, '/');
    this.path = uriPath.startsWith('/') ? uriPath : `/${uriPath}`;
    this.query = query;
    this.fragment = fragment;
  }

  static file(filePath: string): TestUri {
    return new TestUri(filePath);
  }

  static parse(raw: string): TestUri {
    if (!raw.toLowerCase().startsWith('file:')) throw new Error(`Unsupported test URI: ${raw}`);
    const uriPath = decodeURIComponent(new URL(raw).pathname);
    return new TestUri(path.sep === '\\' ? uriPath.replace(/^\/(?=[a-z]:)/i, '') : uriPath);
  }

  with(changes: { path?: string; query?: string; fragment?: string }): TestUri {
    return new TestUri(
      changes.path ?? this.fsPath,
      this.scheme,
      changes.query ?? this.query,
      changes.fragment ?? this.fragment
    );
  }

  toString(): string {
    return `file://${encodeURI(this.path)}`;
  }
}

const existingFiles = new Map<string, Uint8Array>();
const fileKey = (fsPath: string) => path.sep === '\\' ? fsPath.toLowerCase() : fsPath;
let readFileCount = 0;

mock.module('vscode', () => ({
  Uri: TestUri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: { openExternal: async () => true },
  extensions: { getExtension: () => undefined },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: async () => undefined
    }),
    fs: {
      stat: async (uri: TestUri) => {
        if (!existingFiles.has(fileKey(uri.fsPath))) throw new Error('File not found');
        return { type: 1, ctime: 0, mtime: 0, size: existingFiles.get(fileKey(uri.fsPath))!.length };
      },
      readFile: async (uri: TestUri) => {
        readFileCount += 1;
        const bytes = existingFiles.get(fileKey(uri.fsPath));
        if (!bytes) throw new Error('File not found');
        return bytes;
      }
    }
  }
}));

const {
  collectWebviewImageResourceRoots,
  resolveWebviewImageSrc
} = await import('../src/shared/documentLinks');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createWebview(localResourceRoots: TestUri[]) {
  let optionsAssignments = 0;
  let options = { enableScripts: true, localResourceRoots };
  return {
    webview: {
      get options() { return options; },
      set options(value) {
        optionsAssignments += 1;
        options = value;
      },
      asWebviewUri(uri: TestUri) {
        return { toString: () => `vscode-webview-resource:${uri.path}` };
      }
    },
    get optionsAssignments() { return optionsAssignments; }
  };
}

// URI fixtures and production node:path operations must use the same host dialect.
// CI runs these contracts on both Windows (drive paths) and Ubuntu (POSIX paths).
const fixtureRoot = path.resolve(path.sep, 'meo-image-fixture');
const documentDirectory = path.join(fixtureRoot, 'docs');
const documentUri = TestUri.file(path.join(documentDirectory, 'test.md'));
const localImage = TestUri.file(path.join(documentDirectory, 'local.png'));
const externalImage = TestUri.file(path.join(fixtureRoot, 'Pictures', 'external.jpg'));
const newExternalImage = TestUri.file(path.join(fixtureRoot, 'Other', 'new.jpg'));
existingFiles.set(fileKey(localImage.fsPath), new Uint8Array([1, 2, 3]));
existingFiles.set(fileKey(externalImage.fsPath), new Uint8Array([1, 2, 3]));
existingFiles.set(fileKey(newExternalImage.fsPath), new Uint8Array([1, 2, 3]));

const localWebview = createWebview([TestUri.file(documentDirectory)]);
const localResult = await resolveWebviewImageSrc('local.png', documentUri as never, localWebview.webview as never);
assert(localResult.startsWith('vscode-webview-resource:'), 'document-local image did not use its authorized webview URI');
assert(localWebview.optionsAssignments === 0, 'document-local image changed webview options');
assert(readFileCount === 0, 'document-local image was unnecessarily copied into a data URL');

for (const source of [
  './local.png', 'nested/../local.png', 'nested\\..\\local.png',
  localImage.fsPath, localImage.fsPath.replace(/\\/g, '/'), localImage.toString()
]) {
  const result = await resolveWebviewImageSrc(source, documentUri as never, localWebview.webview as never);
  assert(result === localResult, `local image path variant resolved differently: ${source}`);
}
const missingResult = await resolveWebviewImageSrc('missing.png', documentUri as never, localWebview.webview as never);
assert(missingResult === '', 'missing image was exposed as an authorized resource');
assert(localWebview.optionsAssignments === 0, 'local image path variants changed webview options');
assert(readFileCount === 0, 'local image path variants unnecessarily copied image bytes');

const collectedRoots = collectWebviewImageResourceRoots(
  `![external](${externalImage.fsPath})`,
  documentUri as never
) as unknown as TestUri[];
assert(collectedRoots.length === 1, `initial image root count was ${collectedRoots.length}`);
assert(
  collectedRoots[0].fsPath === path.dirname(externalImage.fsPath),
  `unexpected initial image root: ${collectedRoots[0].fsPath}`
);

const externalWebview = createWebview([TestUri.file(documentDirectory), ...collectedRoots]);
const externalResult = await resolveWebviewImageSrc(externalImage.fsPath, documentUri as never, externalWebview.webview as never);
assert(externalResult.startsWith('vscode-webview-resource:'), 'initial external image did not use its exact authorized URI');
assert(externalWebview.optionsAssignments === 0, 'external image changed webview options and can reload the editor');
assert(readFileCount === 0, `initial external image was unnecessarily copied ${readFileCount} times`);
const embeddedPreviewResult = await resolveWebviewImageSrc(
  externalImage.fsPath,
  documentUri as never,
  externalWebview.webview as never,
  { delivery: 'embedded' }
);
assert(embeddedPreviewResult === 'data:image/jpeg;base64,AQID', 'Preview did not request iframe-compatible image data');
assert(readFileCount === 1, 'embedded Preview image was not read exactly once');

const newExternalResult = await resolveWebviewImageSrc(
  newExternalImage.fsPath,
  documentUri as never,
  externalWebview.webview as never
);
assert(newExternalResult === 'data:image/jpeg;base64,AQID', `unexpected new image result: ${newExternalResult.slice(0, 40)}`);
assert(externalWebview.optionsAssignments === 0, 'new external image changed webview options and can reload the editor');
assert(readFileCount === 2, `new external image read count was ${readFileCount}`);

// Exercise the actual Preview-to-Host seam: Markdown normalizes Windows
// backslashes to %5C before the deferred resource request reaches the resolver.
const { default: exportRuntime } = await import('../src/export/runtime');
for (const source of [externalImage.fsPath, encodeURI(externalImage.fsPath)]) {
  const preview = exportRuntime.renderPreviewDocument({
    markdownText: `![external](${source})\n\n<img src="${source}" alt="HTML external">`,
    sourceDocumentPath: documentUri.fsPath,
    uiLanguage: 'en'
  });
  const deferredSources = Array.from(preview.html.matchAll(/data-meo-deferred-image-src="([^"]+)"/g), match => match[1]!);
  assert(deferredSources.length === 2, 'Preview must preserve both local image syntaxes');
  for (const deferredSource of deferredSources) {
    const resolved = await resolveWebviewImageSrc(
      deferredSource, documentUri as never, externalWebview.webview as never,
      { delivery: 'embedded' }
    );
    assert(resolved === 'data:image/jpeg;base64,AQID',
      `Rendered Preview image did not resolve to image bytes: ${deferredSource}`);
    const direct = await resolveWebviewImageSrc(
      deferredSource, documentUri as never, externalWebview.webview as never
    );
    assert(direct === externalResult, 'Rendered local image must retain its authorized resource identity');
  }
}

assert(await resolveWebviewImageSrc('//images.example.test/image.png', documentUri as never,
  externalWebview.webview as never, { delivery: 'embedded' }) === 'https://images.example.test/image.png',
  'Protocol-relative Preview images must use the existing HTTPS normalization');

console.log('webview image source checks passed');
