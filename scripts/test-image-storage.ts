import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultImageStorage, type ImageStoragePreferences } from '../src/foundation/imageStorage';
import { resolveClipboardImageDirectory, saveClipboardImageFile } from '../src/host/clipboardImageSave';
import { createImageStorageHost, type ImageStorageContext } from '../src/host/imageStorage';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { ImageLocationRequest, ImageLocationResponse } from '../src/protocol/imageStorage';
import { createImageStorageTransport } from '../webview/src/adapters/imageStorageTransport';

await mkdir(path.join(process.cwd(), '.local'), { recursive: true });
const root = await mkdtemp(path.join(process.cwd(), '.local', 'image-storage-test-'));
try {
  const documentDirectory = path.join(root, 'notes with spaces');
  const documentFsPath = path.join(documentDirectory, 'draft.v2.md');
  await mkdir(documentDirectory); await writeFile(documentFsPath, '# Draft');
  const context = { documentFsPath, workspaceFsPath: path.join(root, 'unrelated-workspace') };
  const storage = (mode: ImageStoragePreferences['mode'], folder = 'images', rule = '${fileDirname}/assets'): ImageStoragePreferences => ({ mode, folder, rule });
  for (const [preferences, directory] of [
    [storage('default'), path.join(documentDirectory, 'images')],
    [storage('perDocument'), path.join(documentDirectory, 'images', 'draft.v2')],
    [storage('advanced', 'images', '../shared images'), path.join(root, 'shared images')],
    [storage('advanced', 'images', path.join(root, 'fixed')), path.join(root, 'fixed')],
    [storage('advanced', 'images', '${fileDirname}/vars/${fileBasename}/${fileBasenameNoExtension}/${fileExtname}'), path.join(documentDirectory, 'vars', 'draft.v2.md', 'draft.v2', '.md')]
  ] as const) {
    const resolved = resolveClipboardImageDirectory({ ...context, imageStorage: preferences });
    assert.equal(resolved.targetDirectory, directory);
    await assert.rejects(access(directory), 'preview resolution must not create directories');
    const saved = await saveClipboardImageFile({ ...context, imageStorage: preferences, requestedFileName: 'shot.png', contents: Buffer.from('image') });
    assert.equal(saved.relativePath, path.relative(documentDirectory, path.join(directory, 'shot.png')).replace(/\\/g, '/'));
    assert.equal(await readFile(path.join(directory, 'shot.png'), 'utf8'), 'image');
  }
  await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('advanced', 'images', documentFsPath), requestedFileName: 'file.png', contents: Buffer.from('image') }), /directories/);
  const standalone = resolveClipboardImageDirectory({ documentFsPath, imageStorage: storage('perDocument') });
  assert.equal(standalone.targetDirectory, path.join(documentDirectory, 'images', 'draft.v2'));
  const renamed = resolveClipboardImageDirectory({ documentFsPath: path.join(documentDirectory, 'next.md'), imageStorage: storage('perDocument') });
  assert.equal(renamed.targetDirectory, path.join(documentDirectory, 'images', 'next'));
  for (const preferences of [storage('default', '../escape'), storage('perDocument', '/absolute'), storage('default', 'C:\\absolute'), storage('advanced', 'images', '${unknown}/images'), storage('advanced', 'images', '${fileDirname'), storage('advanced', 'images', '~/images'), storage('advanced', 'images', '')]) {
    assert.throws(() => resolveClipboardImageDirectory({ ...context, imageStorage: preferences }));
  }
  assert.equal(resolveClipboardImageDirectory({ documentFsPath: path.join(root, '$notes', 'd.md'), imageStorage: storage('advanced', 'images', '${fileDirname}/images') }).targetDirectory, path.join(root, '$notes', 'images'));
  const external = path.join(root, 'external'); await mkdir(external);
  const link = path.join(documentDirectory, 'linked'); await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('advanced', 'images', link + '/new/sub'), requestedFileName: 'unsafe.png', contents: Buffer.from('unsafe') }), /symbolic link|junction/);
  await assert.rejects(access(path.join(external, 'new')));
  if (process.platform === 'win32') {
    for (const requestedFileName of ['image.png:stream', 'NUL.png', 'trailing.png.', 'bad?.png']) {
      await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('default'), requestedFileName, contents: Buffer.from('unsafe') }), /safe path segment/);
    }
  }
  const same = await Promise.all([1, 2, 3].map(value => saveClipboardImageFile({ ...context, imageStorage: storage('perDocument'), requestedFileName: 'same.png', contents: Buffer.from(String(value)) })));
  assert.equal(new Set(same.map(value => value.relativePath)).size, 3);

  let current: ImageStorageContext = { ...context, configuredFolder: 'legacy' };
  const writes: ImageStoragePreferences[] = []; let failWrite = false; let chosen: string | null = null;
  const host = createImageStorageHost({
    read: () => current,
    write: async (_resource, preferences) => { if (failWrite) throw new Error('write failed'); writes.push(preferences); current = { ...current, imageStorage: preferences }; },
    selectFolder: async () => chosen
  });
  let requestNumber = 0;
  const request = (action: 'read' | 'selectFolder' | 'preview' | 'save', preferences = defaultImageStorage): ImageLocationRequest =>
    action === 'read' || action === 'selectFolder' ? { type: 'imageLocation', action, requestId: String(requestNumber++) }
      : { type: 'imageLocation', action, preferences, requestId: String(requestNumber++) };
  const read = await host.handle(request('read'), 'document');
  assert.ok(read.result.ok);
  assert.equal(read.result.value.state.targetDirectory, path.join(context.workspaceFsPath, 'legacy'));
  assert.equal(read.result.value.state.preferences.mode, 'advanced');
  assert.equal(read.result.value.state.legacy, true);
  assert.equal(writes.length, 0);
  const preview = await host.handle(request('preview', storage('perDocument')), 'document');
  assert.ok(preview.result.ok);
  assert.equal(preview.result.value.state.targetDirectory, standalone.targetDirectory);
  assert.equal(writes.length, 0);
  const firstRequest = request('save', storage('perDocument'));
  const [saved, duplicate] = await Promise.all([host.handle(firstRequest, 'document'), host.handle(firstRequest, 'document')]);
  assert.deepEqual(saved, duplicate); assert.equal(writes.length, 1);
  assert.equal((await host.handle({ ...firstRequest, action: 'read' }, 'document')).result.ok, false);
  const invalid = await host.handle(request('save', storage('advanced', 'images', '${missing}')), 'document');
  assert.equal(invalid.result.ok, false); assert.equal(writes.length, 1);
  failWrite = true;
  assert.equal((await host.handle(request('save', storage('default', 'failed')), 'document')).result.ok, false);
  failWrite = false;
  await Promise.all([host.handle(request('save', storage('default', 'one')), 'document'), host.handle(request('save', storage('default', 'two')), 'document')]);
  assert.deepEqual(writes.slice(-2).map(value => value.folder), ['one', 'two']);
  const canceled = await host.handle(request('selectFolder'), 'document');
  assert.ok(canceled.result.ok); assert.equal(canceled.result.value.selectedFolder, null);
  chosen = path.join(root, 'chosen');
  const picked = await host.handle(request('selectFolder'), 'document');
  assert.ok(picked.result.ok); assert.equal(picked.result.value.selectedFolder, chosen);
  assert.equal(writes.length, 3, 'picker does not persist before a user accepts its value in the UI');
  current = { documentFsPath: null, imageStorage: storage('perDocument') };
  const untitled = await host.handle(request('read'), 'untitled');
  assert.ok(untitled.result.ok); assert.equal(untitled.result.value.state.targetDirectory, null);
  assert.equal(untitled.result.value.state.documentPath, null);

  assert.ok(decodeHostToWebviewMessage(read));
  assert.ok(decodeWebviewToHostMessage(firstRequest));
  for (const value of [{ type: 'imageLocation', action: 'save', requestId: 'x' }, { ...firstRequest, preferences: { mode: 'oops', folder: 'a', rule: 'a' } }, { ...firstRequest, requestId: '' }, { ...firstRequest, preferences: {...defaultImageStorage, mode: ['default']} }]) assert.equal(decodeWebviewToHostMessage(value), null);
  assert.equal(decodeHostToWebviewMessage({ ...read, result: { ok: true, value: { state: {}, selectedFolder: null } } }), null);
  assert.equal(decodeHostToWebviewMessage({ ...read, result: { ok: false, error: { code: 'unknown', message: 'bad' } } }), null);
  const posted: ImageLocationRequest[] = [];
  const transport = createImageStorageTransport(message => posted.push(message));
  let firstSettled = false;
  const pendingFirst = transport.request({ action: 'read' }).then(result => { firstSettled = true; return result; });
  const pendingSecond = transport.request({ action: 'preview', preferences: defaultImageStorage });
  assert.notEqual(posted[0].requestId, posted[1].requestId);
  transport.accept({ ...read, requestId: 'stale-session' });
  await Promise.resolve(); assert.equal(firstSettled, false);
  transport.accept({ ...read, requestId: posted[1].requestId });
  assert.deepEqual(await pendingSecond, read.result);
  transport.accept({ ...read, requestId: posted[1].requestId });
  transport.dispose(); assert.equal((await pendingFirst).ok, false);
  assert.equal((await transport.request({ action: 'read' })).ok, false);
  const broken = createImageStorageTransport(() => { throw new Error('disconnected'); });
  assert.equal((await broken.request({ action: 'read' })).ok, false); broken.dispose();
  const deadline = createImageStorageTransport(() => undefined);
  const timedOut = await deadline.request({ action: 'read' });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.error.code, 'timeout');
  deadline.dispose();
} finally { await rm(root, { recursive: true, force: true }); }
console.log('image storage paths, persistence, protocol and transport checks passed');
