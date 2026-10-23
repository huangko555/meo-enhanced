import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';
import { URI, Utils } from 'vscode-uri';
import { saveClipboardImageFile } from '../src/host/clipboardImageSave';
import { encodeMarkdownPath } from '../src/foundation/linkDestination';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-compatibility-'));
let workspaceRoots: URI[] = [];
const remoteFiles = new Map<string, { type: number; bytes?: Uint8Array }>();
mock.module('vscode', () => ({
  Uri: { file: URI.file, parse: URI.parse, joinPath: Utils.joinPath },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    get workspaceFolders() { return workspaceRoots.map(uri => ({ uri })); },
    getWorkspaceFolder: (document: URI) => {
      const uri = workspaceRoots.find(root => root.scheme === document.scheme && root.authority === document.authority
        && document.path.startsWith(`${root.path}/`));
      return uri ? { uri } : undefined;
    },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: {
      stat: async (uri: URI) => {
        if (uri.scheme !== 'file') {
          const entry = remoteFiles.get(uri.toString());
          if (!entry) throw new Error('Not found');
          return { type: entry.type };
        }
        const stat = fs.statSync(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1 };
      },
      readFile: async (uri: URI) => uri.scheme === 'file' ? fs.readFileSync(uri.fsPath) : remoteFiles.get(uri.toString())!.bytes!
    }
  }
}));
const links = await import('../src/shared/documentLinks');
const { default: runtime } = await import('../src/export/runtime');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const write = (filename: string, bytes = png) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
};
const embedded = `data:image/png;base64,${png.toString('base64')}`;
const webview = {
  options: { localResourceRoots: [] },
  asWebviewUri: (uri: URI) => ({ toString: () => uri.toString() })
};

try {
  const chineseNote = URI.file(path.join(fixture, '中文资料 空格', '中文 方案[甲]&copy;.md'));
  write(chineseNote.fsPath, Buffer.from('# 中文文档'));
  const savedChinese = await saveClipboardImageFile({ documentFsPath: chineseNote.fsPath,
    imageStorage: {mode: 'default', folder: '图片(一)#50%', rule: 'assets'}, extension: 'png', contents: png });
  const chineseTarget = encodeMarkdownPath(savedChinese.relativePath);
  assert.equal(savedChinese.fileName, '中文 方案[甲]&copy;-1.png');
  assert.equal((await links.resolveLocalImageTargetUri(chineseTarget, chineseNote as never))?.fsPath,
    path.join(path.dirname(chineseNote.fsPath), savedChinese.relativePath));
  assert.equal(await links.resolveWebviewImageSrc(chineseTarget, chineseNote as never, webview as never, {delivery: 'embedded'}), embedded,
    'newly named images in Chinese directories resolve to the actual saved bytes');
  const workspace = URI.file(path.join(fixture, 'workspace')).fsPath;
  const note = URI.file(path.join(workspace, 'notes', 'chapter', 'note.md'));
  write(note.fsPath, Buffer.from('# Note'));
  const image = path.join(workspace, 'resources', 'test 图 (v1) #100%.png');
  write(image);
  const target = `resources/${encodeURIComponent(path.basename(image))}`;
  workspaceRoots = [URI.file(path.join(fixture, 'unrelated')), URI.file(workspace)];
  write(path.join(fixture, 'unrelated', 'resources', path.basename(image)), Buffer.from('wrong workspace'));
  assert.equal(await links.resolveWebviewImageSrc(target, note as never, webview as never, { delivery: 'embedded' }), embedded,
    'A root-relative image must resolve in the owning workspace, including encoded names');

  const imageRoots = await links.resolveImageSearchRoots(note as never);
  assert.deepEqual(imageRoots, [workspace]);
  assert.equal((await links.resolveLocalImageTargetUri(target, note as never))?.fsPath, image,
    'External image opening must select the same file');
  for (const source of [`![image](${target})`, `<img src="${target}" alt="image">`]) {
    const preview = runtime.renderPreviewDocument({ markdownText: source, sourceDocumentPath: note.fsPath, uiLanguage: 'en' });
    const deferred = /data-meo-deferred-image-src="([^"]+)"/.exec(preview.html)?.[1];
    assert.ok(deferred);
    assert.equal(await links.resolveWebviewImageSrc(deferred, note as never, webview as never, { delivery: 'embedded' }), embedded);
    for (const format of ['html', 'pdf', 'docx'] as const) {
      const rendered = await runtime.renderExportHtmlDocument({
        readingSnapshot: { snapshotId: 'image-compatibility', text: source, appearance: 'light', uiLanguage: 'en', environment: { previewSourceColoring: false } },
        sourceDocumentPath: note.fsPath, imageSearchRoots: imageRoots,
        outputFilePath: path.join(fixture, `output.${format}`), target: format,
        mermaidRuntimeSrc: '', baseHref: '', title: 'Images', shikiLanguageAssetsRoot: ''
      });
      assert.ok(rendered.htmlDocument.includes(format === 'pdf' ? pathToFileURL(image).toString() : embedded), `${format} must use the same resolved image`);
    }
  }

  assert.equal(await links.resolveWebviewImageSrc(`./${target}`, note as never, webview as never), '', 'Explicit document-relative paths must not fall back');
  assert.equal(await links.resolveWebviewImageSrc(`../${target}`, note as never, webview as never), '', 'Parent-relative paths must not fall back');
  const localImage = path.join(path.dirname(note.fsPath), 'resources', path.basename(image));
  write(localImage, Buffer.from('local precedence'));
  assert.equal((await links.resolveLocalImageTargetUri(target, note as never))?.fsPath, localImage, 'Existing document-local images take precedence');

  const vault = path.join(workspace, 'vault');
  const vaultNote = URI.file(path.join(vault, 'notes', 'note.md'));
  write(vaultNote.fsPath, Buffer.from('# Vault note'));
  fs.mkdirSync(path.join(vault, '.obsidian'));
  write(path.join(vault, 'resources', 'vault.png'));
  write(path.join(workspace, 'resources', 'vault.png'), Buffer.from('wrong outer workspace'));
  assert.deepEqual(await links.resolveImageSearchRoots(vaultNote as never), [vault], 'The nearest vault takes precedence over an outer workspace');
  assert.equal(await links.resolveWebviewImageSrc('resources/vault.png', vaultNote as never, webview as never, { delivery: 'embedded' }), embedded);
  workspaceRoots = [];
  assert.equal(await links.resolveWebviewImageSrc('resources/vault.png', vaultNote as never, webview as never, { delivery: 'embedded' }), embedded, 'Opening a vault note alone must still work');
  workspaceRoots = [URI.file(path.join(fixture, 'unrelated'))];
  assert.deepEqual(await links.resolveImageSearchRoots(note as never), [], 'Unrelated workspace roots are not image search roots');
  assert.equal(await links.resolveWebviewImageSrc(target, URI.file(path.join(fixture, 'outside', 'note.md')) as never, webview as never), '', 'Unrelated workspaces must not supply missing images');
  write(path.join(workspace, 'escaped.png'));
  assert.equal(await links.resolveWebviewImageSrc('nested/../../escaped.png', vaultNote as never, webview as never), '', 'Root fallback must stay inside the vault');

  const remoteRoot = URI.parse('vscode-remote://test-host/workspace');
  const remoteNote = Utils.joinPath(remoteRoot, 'notes', 'note.md');
  const remoteImage = Utils.joinPath(remoteRoot, 'resources', 'image.png');
  workspaceRoots = [remoteRoot];
  remoteFiles.set(remoteImage.toString(), { type: 1, bytes: png });
  assert.equal((await links.resolveLocalImageTargetUri('resources/image.png', remoteNote as never))?.toString(), remoteImage.toString(), 'Remote images preserve URI scheme and authority');
  assert.equal(await links.resolveWebviewImageSrc('resources/image.png', remoteNote as never, webview as never, { delivery: 'embedded' }), embedded);
  console.log('image path compatibility checks passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
