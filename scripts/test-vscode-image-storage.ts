import assert from 'node:assert/strict';
import path from 'node:path';
import { mock } from 'bun:test';
import { defaultImageStorage, type ImageStoragePreferences } from '../src/foundation/imageStorage';

class TestUri {
  constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(value: string) { return new TestUri('file', path.resolve(value)); }
  static parse(value: string) {
    if (!value.startsWith('file:')) return new TestUri('untitled', value);
    const filePath = decodeURIComponent(new URL(value).pathname).replace(/^\/(?=[a-z]:)/i, '');
    return TestUri.file(filePath);
  }
  static joinPath(uri: TestUri, ...segments: string[]) { return TestUri.file(path.join(uri.fsPath, ...segments)); }
  toString() { return this.scheme === 'file' ? 'file:///' + this.fsPath.replace(/\\/g, '/') : this.fsPath; }
}
let value: unknown = null;
let modern: Record<string, unknown> = {};
let legacy: Record<string, unknown> = {};
let workspace: { uri: TestUri } | undefined;
let selected: TestUri[] | undefined;
let dialogOptions: any;
const calls: {section: string; resource: TestUri}[] = [];
const updates: {key: string; preferences: ImageStoragePreferences; target: number}[] = [];
mock.module('vscode', () => ({
  Uri: TestUri, env: {language: 'en'},
  ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
  workspace: {
    getWorkspaceFolder: () => workspace,
    getConfiguration: (section: string, resource: TestUri) => {
      calls.push({section, resource});
      return {
        get: () => value,
        inspect: (key: string) => key === 'imageStorage' ? modern : legacy,
        update: async (key: string, preferences: ImageStoragePreferences, target: number) => {
          updates.push({key, preferences, target}); value = preferences;
        }
      };
    }
  },
  window: {showOpenDialog: async (options: any) => {dialogOptions = options; return selected;}}
}));
const { createVscodeImageStorage, readVscodeImageStorage } = await import('../src/host/vscodeImageStorage');
const document = TestUri.file(path.join(process.cwd(), 'fixtures', 'draft.md'));
const resource = document.toString();
let number = 0;
for (const [scope, target] of [['globalValue', 1], ['workspaceValue', 2], ['workspaceFolderValue', 3]] as const) {
  value = null; modern = {}; legacy = {[scope]: 'legacy-images'};
  workspace = {uri: TestUri.file(path.join(process.cwd(), 'selected-folder'))};
  const owner = createVscodeImageStorage();
  const read = await owner.handle({type: 'imageLocation', action: 'read', requestId: String(number++)}, resource);
  assert.ok(read.result.ok);
  assert.equal(read.result.value.state.targetDirectory, path.join(workspace.uri.fsPath, 'legacy-images'));
  assert.equal(updates.length, target - 1, 'read does not migrate the old config');
  const saved = await owner.handle({type: 'imageLocation', action: 'save', requestId: String(number++), preferences: defaultImageStorage}, resource);
  assert.ok(saved.result.ok);
  assert.equal(updates.at(-1)!.target, target);
  assert.equal(updates.at(-1)!.key, 'imageStorage');
  assert.equal(saved.result.value.state.targetDirectory, path.join(path.dirname(document.fsPath), 'assets'));
}
value = null; legacy = {}; modern = {}; workspace = undefined;
const owner = createVscodeImageStorage();
const read = readVscodeImageStorage(document as never);
assert.equal(read.documentFsPath, document.fsPath);
assert.equal(read.workspaceFsPath, undefined);
assert.equal(read.imageStorage, undefined);
const saved = await owner.handle({type: 'imageLocation', action: 'save', requestId: String(number++), preferences: defaultImageStorage}, resource);
assert.ok(saved.result.ok); assert.equal(updates.at(-1)!.target, 1);
assert.ok(calls.every(call => call.section === 'meoEnhanced' && call.resource.fsPath === document.fsPath));
selected = undefined;
const canceled = await owner.handle({type: 'imageLocation', action: 'selectFolder', requestId: String(number++)}, resource);
assert.ok(canceled.result.ok); assert.equal(canceled.result.value.selectedFolder, null);
assert.deepEqual([dialogOptions.canSelectFiles, dialogOptions.canSelectFolders, dialogOptions.canSelectMany], [false, true, false]);
assert.equal(dialogOptions.defaultUri.fsPath, path.join(path.dirname(document.fsPath), 'assets'));
selected = [TestUri.file(path.join(process.cwd(), 'chosen-images'))];
const picked = await owner.handle({type: 'imageLocation', action: 'selectFolder', requestId: String(number++)}, resource);
assert.ok(picked.result.ok); assert.equal(picked.result.value.selectedFolder, selected[0].fsPath);
assert.equal(updates.length, 4, 'folder selection itself does not change configuration');
assert.equal(readVscodeImageStorage(new TestUri('untitled', 'Untitled-1') as never).documentFsPath, null);
value = {mode: 'bad'};
assert.throws(() => readVscodeImageStorage(document as never), /Invalid imageStorage/);
console.log('VS Code image storage resource, legacy scopes and native folder dialog contract passed');
