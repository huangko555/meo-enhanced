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
    this.fsPath = path.win32.normalize(fsPath);
    this.path = `/${this.fsPath.replace(/\\/g, '/')}`;
    this.query = query;
    this.fragment = fragment;
  }

  static file(filePath: string): TestUri {
    return new TestUri(filePath);
  }

  static parse(raw: string): TestUri {
    if (!raw.toLowerCase().startsWith('file:')) throw new Error(`Unsupported test URI: ${raw}`);
    return new TestUri(decodeURIComponent(new URL(raw).pathname.replace(/^\/(?=[a-z]:)/i, '')));
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
    return `file:///${this.fsPath.replace(/\\/g, '/')}`;
  }
}

const existingFiles = new Map<string, Uint8Array>();
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
        if (!existingFiles.has(uri.fsPath.toLowerCase())) throw new Error('File not found');
        return { type: 1, ctime: 0, mtime: 0, size: existingFiles.get(uri.fsPath.toLowerCase())!.length };
      },
      readFile: async (uri: TestUri) => {
        readFileCount += 1;
        const bytes = existingFiles.get(uri.fsPath.toLowerCase());
        if (!bytes) throw new Error('File not found');
        return bytes;
      }
    }
  }
}));

const { collectWebviewImageResourceRoots, resolveWebviewImageSrc } = await import('../src/shared/documentLinks');

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

const documentUri = TestUri.file('D:\\docs\\test.md');
const localImage = TestUri.file('D:\\docs\\local.png');
const externalImage = TestUri.file('D:\\Pictures\\external.jpg');
const newExternalImage = TestUri.file('D:\\Other\\new.jpg');
existingFiles.set(localImage.fsPath.toLowerCase(), new Uint8Array([1, 2, 3]));
existingFiles.set(externalImage.fsPath.toLowerCase(), new Uint8Array([1, 2, 3]));
existingFiles.set(newExternalImage.fsPath.toLowerCase(), new Uint8Array([1, 2, 3]));

const localWebview = createWebview([TestUri.file('D:\\docs')]);
const localResult = await resolveWebviewImageSrc('local.png', documentUri as never, localWebview.webview as never);
assert(localResult.startsWith('vscode-webview-resource:'), 'document-local image did not use its authorized webview URI');
assert(localWebview.optionsAssignments === 0, 'document-local image changed webview options');
assert(readFileCount === 0, 'document-local image was unnecessarily copied into a data URL');

const collectedRoots = collectWebviewImageResourceRoots(
  `![external](${externalImage.fsPath})`,
  documentUri as never
) as unknown as TestUri[];
assert(collectedRoots.length === 1, `initial image root count was ${collectedRoots.length}`);
assert(
  collectedRoots[0].fsPath === path.win32.dirname(externalImage.fsPath),
  `unexpected initial image root: ${collectedRoots[0].fsPath}`
);

const externalWebview = createWebview([TestUri.file('D:\\docs'), ...collectedRoots]);
const externalResult = await resolveWebviewImageSrc(externalImage.fsPath, documentUri as never, externalWebview.webview as never);
assert(externalResult.startsWith('vscode-webview-resource:'), 'initial external image did not use its exact authorized URI');
assert(externalWebview.optionsAssignments === 0, 'external image changed webview options and can reload the editor');
assert(readFileCount === 0, `initial external image was unnecessarily copied ${readFileCount} times`);

const newExternalResult = await resolveWebviewImageSrc(
  newExternalImage.fsPath,
  documentUri as never,
  externalWebview.webview as never
);
assert(newExternalResult === 'data:image/jpeg;base64,AQID', `unexpected new image result: ${newExternalResult.slice(0, 40)}`);
assert(externalWebview.optionsAssignments === 0, 'new external image changed webview options and can reload the editor');
assert(readFileCount === 1, `new external image read count was ${readFileCount}`);

console.log('webview image source checks passed');
