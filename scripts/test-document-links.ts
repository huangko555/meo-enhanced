import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';
import { URI, Utils } from 'vscode-uri';
import assert from 'node:assert/strict';
import {
  createPanelSessionControllerParams, createPanelSessionTestDocument,
  createPanelSessionVscodeMock, panelSessionDisposable
} from './panel-session-test-helper';

const repoRoot = path.resolve(import.meta.dir, '..');
const openedExternal: string[] = [];
const commands: Array<{ command: string; uri: string; uriString: string; editor?: string; options: unknown }> = [];
const stats: string[] = [];
const documentUri = URI.file(path.join(repoRoot, 'README.md'));
const document = createPanelSessionTestDocument(documentUri as never, '# Test');
const api = createPanelSessionVscodeMock(document);
const virtualFiles = new Set<string>();
const virtualDirectories = new Set<string>();
const linkWatchers: Array<{ disposed: boolean; handlers: Array<(uri: URI) => void>; pattern: { baseUri: URI; pattern: string } }> = [];

const Uri = {
  parse: (value: string, strict?: boolean) => URI.parse(value, strict),
  file: (value: string) => URI.file(value),
  joinPath: (base: URI, ...parts: string[]) => Utils.joinPath(base, ...parts)
};

mock.module('vscode', () => ({
  ...api,
  Uri,
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class { constructor(readonly baseUri: URI, readonly pattern: string) {} },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: {
    openExternal: async (uri: URI) => {
      openedExternal.push(uri.toString());
      return true;
    }
  },
  extensions: { getExtension: () => undefined },
  commands: {
    executeCommand: async (command: string, uri: URI, editorOrOptions?: unknown, options?: unknown) => {
      commands.push({ command, uri: uri.fsPath, uriString: uri.toString(),
        editor: typeof editorOrOptions === 'string' ? editorOrOptions : undefined,
        options: typeof editorOrOptions === 'string' ? options : editorOrOptions });
    }
  },
  window: {
    ...(api.window as object),
    visibleTextEditors: [],
    showTextDocument: async () => undefined
  },
  workspace: {
    ...(api.workspace as object),
    workspaceFolders: [{ uri: URI.file(repoRoot) }],
    getWorkspaceFolder: () => ({ uri: URI.file(repoRoot) }),
    createFileSystemWatcher: (pattern: { baseUri: URI; pattern: string }) => {
      const watcher = { disposed: false, pattern, handlers: [] as Array<(uri: URI) => void>,
        onDidCreate(callback: (uri: URI) => void) { this.handlers.push(callback); return panelSessionDisposable(); },
        onDidDelete(callback: (uri: URI) => void) { this.handlers.push(callback); return panelSessionDisposable(); },
        onDidChange(callback: (uri: URI) => void) { this.handlers.push(callback); return panelSessionDisposable(); },
        dispose() { this.disposed = true; }
      };
      linkWatchers.push(watcher);
      return watcher;
    },
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: async () => undefined
    }),
    openTextDocument: async () => ({}),
    fs: {
      stat: async (uri: URI) => {
        stats.push(uri.fsPath);
        if (virtualDirectories.has(uri.toString())) return { type: 2, ctime: 0, mtime: 0, size: 0 };
        if (virtualFiles.has(uri.toString())) return { type: 1, ctime: 0, mtime: 0, size: 0 };
        const entry = fs.statSync(uri.fsPath);
        return { type: entry.isDirectory() ? 2 : 1, ctime: 0, mtime: 0, size: entry.size };
      }
    }
  }
}));

const { openLink, resolveLocalLinkTargetUri, getDocumentFragmentHref } = await import('../src/shared/documentLinks');
const hrefs = [
  'https://example.com/',
  'https://docs.example.com/issues',
  './CONTRIBUTING.md',
  './README.md#meo-enhanced',
  'CHANGELOG.md',
  'LICENSE'
];
const results = [];
for (const href of hrefs) {
  openedExternal.length = 0;
  commands.length = 0;
  stats.length = 0;
  await openLink(href, documentUri as never);
  results.push({ href, openedExternal: [...openedExternal], commands: [...commands], stats: [...stats] });
}
for (const result of results.slice(0, 2)) {
  if (result.openedExternal.length !== 1 || result.commands.length !== 0 || result.stats.length !== 0) {
    throw new Error(`External link did not route directly to the browser: ${JSON.stringify(result)}`);
  }
}
for (const result of results.slice(2, -1)) {
  if (
    result.openedExternal.length !== 0 ||
    result.commands.length !== 1 ||
    result.commands[0].command !== 'vscode.openWith' ||
    result.commands[0].editor !== 'meoEnhanced.editor'
  ) {
    throw new Error(`Markdown link did not route once to MEO: ${JSON.stringify(result)}`);
  }
}
assert.equal(results.at(-1)?.commands[0]?.command, 'vscode.open', 'non-Markdown files keep their associated editor');

const anchoredResult = results.find((result) => result.href === './README.md#meo-enhanced');
if (anchoredResult?.commands[0]?.uriString !== `${documentUri.toString()}#meo-enhanced`) {
  throw new Error(`Relative file fragment was not preserved for navigation: ${JSON.stringify(anchoredResult)}`);
}

openedExternal.length = 0;
commands.length = 0;
stats.length = 0;
await openLink('CHANGELOG.md', documentUri as never);
if (commands.length !== 1 || commands[0].editor !== 'meoEnhanced.editor') {
  throw new Error(`Markdown routing must not depend on file associations: ${JSON.stringify(commands)}`);
}

// /... is workspace-root syntax; file: URIs identify OS files on every platform.
const localDestinations = [documentUri.toString(), `<${documentUri.toString()}>`, '/README.md'];
if (process.platform === 'win32') {
  localDestinations.push(documentUri.fsPath, documentUri.fsPath.replace(/\\/g, '%5C'), `<${documentUri.fsPath}>`);
}
for (const destination of localDestinations) {
  const resolved = await resolveLocalLinkTargetUri(destination, documentUri as never);
  if (resolved?.fsPath !== documentUri.fsPath) {
    throw new Error(`Absolute local destination did not survive shared resolution: ${destination}`);
  }
  openedExternal.length = 0;
  commands.length = 0;
  await openLink(destination, documentUri as never);
  if (commands.length !== 1 || commands[0].uri !== documentUri.fsPath || openedExternal.length) {
    throw new Error(`Absolute local destination did not resolve to the same file: ${JSON.stringify(commands)}`);
  }
}

// Decide from the resolved resource, including extension fallback and remote providers.
for (const extension of ['.md', '.markdown', '.mdx', '.mdc', '.MD']) {
  for (const base of [documentUri, URI.parse('vscode-remote://ssh-remote+fixture/workspace/current.md')]) {
    const target = base.with({ path: base.path.replace(/[^/]+$/, `linked${extension}`) });
    virtualFiles.add(target.toString());
    commands.length = 0;
    await openLink(`./linked${extension}#Heading%20one`, base as never);
    assert.equal(commands[0]?.editor, 'meoEnhanced.editor');
    assert.equal(commands[0]?.uriString, target.with({ fragment: 'Heading one' }).toString());
    assert.deepEqual(commands[0]?.options, { preview: false });
  }
}
const extensionlessTarget = documentUri.with({ path: documentUri.path.replace(/[^/]+$/, 'extensionless.mdc') });
virtualFiles.add(extensionlessTarget.toString());
commands.length = 0;
await openLink('./extensionless', documentUri as never);
assert.equal(commands[0]?.editor, 'meoEnhanced.editor');
assert.equal(commands[0]?.uriString, extensionlessTarget.toString());

const [{ createPanelSessionController }, { createPendingDraftRecovery }, { createVscodeViewNavigationAdapter }] = await Promise.all([
  import('../src/extension/panelSession'), import('../src/application/pendingDraftRecovery'),
  import('../src/host/vscodeViewNavigationAdapter')
]);
const reveals: unknown[] = [];
const viewNavigation = createVscodeViewNavigationAdapter({
  document: document as never, documentUri: documentUri as never,
  getDocumentFragmentHref, resolveLocalLinkTarget: resolveLocalLinkTargetUri,
  post: async message => { reveals.push(message); return true; }
});
await viewNavigation.ready();
const posted: Array<{ type: string; result?: { ok: boolean; value?: { results: Array<{ exists: boolean }> } } }> = [];
const panel = {
  active: true, visible: true,
  webview: { postMessage: async (message: typeof posted[number]) => { posted.push(message); return true; }, onDidReceiveMessage: () => panelSessionDisposable() },
  onDidChangeViewState: () => panelSessionDisposable(), onDidDispose: () => panelSessionDisposable()
};
const controller = createPanelSessionController(createPanelSessionControllerParams({
  panel, document, readDiskText: () => document.text,
  pendingDraftRecovery: createPendingDraftRecovery({ readCurrentText: () => document.text, applyDraft: async () => true }),
  overrides: { viewNavigation }
}) as never);
try {
  for (const source of [undefined, 'preview']) {
    commands.length = 0;
    await controller.handleMessage({ type: 'openLink', href: './CONTRIBUTING.md#guide', ...(source ? { source } : {}) });
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.editor, 'meoEnhanced.editor', 'Live/Source and full/split Preview must choose MEO');
    assert.ok(commands[0]?.uriString.endsWith('/CONTRIBUTING.md#guide'));
    commands.length = 0;
    await controller.handleMessage({ type: 'openLink', href: './README.md#same-document', ...(source ? { source } : {}) });
    assert.equal(commands.length, 0, 'same-document fragments must reveal in the existing editor');
    assert.deepEqual(reveals.at(-1), { type: 'revealDocumentFragment', href: '#same-document' });
  }
  const target = documentUri.with({ path: documentUri.path.replace(/[^/]+$/, 'folder/new file.md') });
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'missing-before-create', targets: ['folder/new%20file.md'] });
  assert.equal(posted.at(-1)?.result?.value?.results[0]?.exists, false);
  virtualFiles.add(target.toString());
  for (const watcher of linkWatchers.filter(watcher => !watcher.disposed)) for (const handler of watcher.handlers) handler(target);
  await Bun.sleep(150);
  assert.ok(posted.some(message => message.type === 'localLinkResourcesChanged'),
    'creating an angle-wrapped link target must invalidate the Live missing status without editing the document');
  posted.length = 0;
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'exists-after-create', targets: ['folder/new%20file.md'] });
  assert.equal(posted.at(-1)?.result?.value?.results[0]?.exists, true);
  commands.length = 0;
  await openLink('<folder/new%20file.md>', documentUri as never);
  assert.equal(commands[0]?.uriString, target.toString(), 'angle destinations resolve to the same existing file');
  virtualFiles.delete(target.toString());
  posted.length = 0;
  for (const watcher of linkWatchers.filter(watcher => !watcher.disposed)) for (const handler of watcher.handlers) handler(target);
  await Bun.sleep(150);
  assert.ok(posted.some(message => message.type === 'localLinkResourcesChanged'), 'deleting a target must invalidate its existing status');
  posted.length = 0;
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'extensionless', targets: ['folder/extensionless'] });
  const fallback = target.with({ path: target.path.replace(/[^/]+$/, 'extensionless.markdown') });
  for (const watcher of linkWatchers.filter(watcher => !watcher.disposed)) for (const handler of watcher.handlers) handler(fallback);
  await Bun.sleep(150);
  assert.equal(posted.filter(message => message.type === 'localLinkResourcesChanged').length, 1,
    'extension fallback events must invalidate once per coalesced burst');
  posted.length = 0;
  for (const watcher of linkWatchers.filter(watcher => !watcher.disposed)) for (const handler of watcher.handlers) handler(target);
  await Bun.sleep(150);
  assert.equal(posted.filter(message => message.type === 'localLinkResourcesChanged').length, 0,
    'replaced and unrelated targets must not invalidate this session');
  const external = URI.file(path.join(path.parse(repoRoot).root, 'meo-link-fixture-missing-parent', 'nested', 'outside.md'));
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'outside', targets: [external.toString()] });
  const externalWatcher = linkWatchers.find(watcher => !watcher.disposed && watcher.pattern.baseUri.toString() === URI.file(path.parse(repoRoot).root).toString());
  assert.ok(externalWatcher, 'file URIs outside the workspace must watch their missing directory subtree');
  assert.equal(externalWatcher.pattern.pattern, '*', 'an absent external directory must use a non-recursive ancestor watch');
  posted.length = 0;
  for (const handler of externalWatcher.handlers) handler(external.with({ path: external.path.replace(/\/nested\/outside.md$/, '') }));
  await Bun.sleep(150);
  assert.ok(posted.some(message => message.type === 'localLinkResourcesChanged'), 'ancestor create/delete events must invalidate missing nested targets');
  const fresh = target.with({ path: target.path.replace(/[^/]+$/, 'fresh/file.md') });
  virtualDirectories.add(fresh.with({ path: fresh.path.replace(/\/file.md$/, '') }).toString());
  virtualDirectories.add(target.with({ path: target.path.replace(/\/[^/]+$/, '') }).toString());
  virtualFiles.add(fresh.toString());
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'new-directory', targets: ['folder/fresh/file.md'] });
  assert.equal(posted.at(-1)?.result?.value?.results[0]?.exists, true);
  posted.length = 0;
  virtualFiles.delete(fresh.toString());
  // VS Code installs a new native watcher asynchronously. A deletion in that
  // registration window may have no watcher event, so a settling recheck is needed.
  await Bun.sleep(600);
  assert.ok(posted.some(message => message.type === 'localLinkResourcesChanged'),
    'new watcher roots must recheck changes missed while the native watcher was registering');
  await controller.handleMessage({ type: 'resolveLocalLinks', requestId: 'deleted-during-registration', targets: ['folder/fresh/file.md'] });
  assert.equal(posted.at(-1)?.result?.value?.results[0]?.exists, false);
} finally { controller.dispose(); }
assert.ok(linkWatchers.every(watcher => watcher.disposed), 'closing the panel must dispose every local resource watcher');

openedExternal.length = 0;
commands.length = 0;
await openLink('missing-local-document.md', documentUri as never);
assert.deepEqual(openedExternal, [], 'a missing Markdown filename must not become an external website');
assert.deepEqual(commands, []);

console.log('document link routing checks passed');
