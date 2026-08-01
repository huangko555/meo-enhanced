import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';
import { URI, Utils } from 'vscode-uri';

const repoRoot = path.resolve(import.meta.dir, '..');
const openedExternal: string[] = [];
const commands: Array<{ command: string; uri: string; uriString: string; editor?: string }> = [];
const stats: string[] = [];

const Uri = {
  parse: (value: string, strict?: boolean) => URI.parse(value, strict),
  file: (value: string) => URI.file(value),
  joinPath: (base: URI, ...parts: string[]) => Utils.joinPath(base, ...parts)
};

mock.module('vscode', () => ({
  Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: {
    openExternal: async (uri: URI) => {
      openedExternal.push(uri.toString());
      return true;
    }
  },
  extensions: { getExtension: () => undefined },
  commands: {
    executeCommand: async (command: string, uri: URI, editor?: string) => {
      commands.push({ command, uri: uri.fsPath, uriString: uri.toString(), editor });
    }
  },
  window: {
    showTextDocument: async () => undefined
  },
  workspace: {
    workspaceFolders: [{ uri: URI.file(repoRoot) }],
    getWorkspaceFolder: () => ({ uri: URI.file(repoRoot) }),
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: async () => undefined
    }),
    openTextDocument: async () => ({}),
    fs: {
      stat: async (uri: URI) => {
        stats.push(uri.fsPath);
        const entry = fs.statSync(uri.fsPath);
        return { type: entry.isDirectory() ? 2 : 1, ctime: 0, mtime: 0, size: entry.size };
      }
    }
  }
}));

const { openLink } = await import('../src/shared/documentLinks');
const documentUri = URI.file(path.join(repoRoot, 'README.md'));
const hrefs = [
  'https://example.com/',
  'https://docs.example.com/issues',
  './docs/theming.md',
  './README.md#meo-enhanced',
  'CHANGELOG.md',
  'LICENSE'
];
const results = [];
for (const href of hrefs) {
  openedExternal.length = 0;
  commands.length = 0;
  stats.length = 0;
  await openLink(href, documentUri as never, { localEditor: 'default' });
  results.push({ href, openedExternal: [...openedExternal], commands: [...commands], stats: [...stats] });
}
for (const result of results.slice(0, 2)) {
  if (result.openedExternal.length !== 1 || result.commands.length !== 0 || result.stats.length !== 0) {
    throw new Error(`External link did not route directly to the browser: ${JSON.stringify(result)}`);
  }
}
for (const result of results.slice(2)) {
  if (
    result.openedExternal.length !== 0 ||
    result.commands.length !== 1 ||
    result.commands[0].command !== 'vscode.openWith' ||
    result.commands[0].editor !== 'default'
  ) {
    throw new Error(`Local link did not route once to VS Code: ${JSON.stringify(result)}`);
  }
}

const anchoredResult = results.find((result) => result.href === './README.md#meo-enhanced');
if (anchoredResult?.commands[0]?.uriString !== `${documentUri.toString()}#meo-enhanced`) {
  throw new Error(`Relative file fragment was not preserved for navigation: ${JSON.stringify(anchoredResult)}`);
}

openedExternal.length = 0;
commands.length = 0;
stats.length = 0;
await openLink('CHANGELOG.md', documentUri as never);
if (commands.length !== 1 || commands[0].command !== 'vscode.open') {
  throw new Error(`Associated editor routing changed outside Preview: ${JSON.stringify(commands)}`);
}

console.log('document link routing checks passed');
