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
import { imageFileNameCandidates } from '../src/application/imageStorage';
import { decodeImageStorage } from '../src/foundation/imageStorage';
import { encodeMarkdownPath } from '../src/foundation/linkDestination';

await mkdir(path.join(process.cwd(), '.local'), { recursive: true });
const root = await mkdtemp(path.join(process.cwd(), '.local', 'image-storage-test-'));
try {
  const namingContext = { documentName: '中文 方案[甲]', extension: 'png', timestamp: new Date(2026, 9, 20, 14, 30, 25).getTime(), existingNames: [] };
  const firstName = (naming: NonNullable<ImageStoragePreferences['naming']>, existingNames: string[] = []) =>
    imageFileNameCandidates({ ...namingContext, naming, existingNames }).next().value;
  assert.equal(firstName('documentSequence'), '中文 方案[甲]-1.png');
  assert.equal(firstName('imageSequence', ['image-2.jpg', 'image-7.PNG', 'unrelated-99.png']), 'image-8.png');
  assert.equal(firstName('dateTime'), '2026-10-20-143025.png');
  assert.equal(firstName('timestamp'), namingContext.timestamp + '.png');
  const dated = imageFileNameCandidates({...namingContext, naming: 'dateTime'});
  assert.equal(dated.next().value, '2026-10-20-143025.png');
  assert.equal(dated.next().value, '2026-10-20-143025-1.png', 'same-second collisions have a safe next candidate');
  assert.equal(imageFileNameCandidates({...namingContext, naming: 'documentSequence', documentName: '中文:方案?'}).next().value, '中文-方案--1.png');
  assert.equal(decodeImageStorage({mode: 'default', folder: 'assets', rule: 'assets'})?.naming, 'documentSequence');
  assert.equal(decodeImageStorage({...defaultImageStorage, naming: 'unknown'}), null);
  const chineseDirectory = path.join(root, '中文资料 空格');
  await mkdir(chineseDirectory);
  const chineseDocument = path.join(chineseDirectory, '中文 方案[甲].md');
  const chinesePreferences = {...defaultImageStorage, folder: '图片 资源(一)#50%'};
  const saveChinese = (extension = 'png', documentFsPath = chineseDocument) => saveClipboardImageFile({
    documentFsPath, imageStorage: chinesePreferences, extension, contents: Buffer.from('中文图片')
  });
  const chineseFirst = await saveChinese();
  assert.equal(chineseFirst.fileName, '中文 方案[甲]-1.png');
  assert.equal(chineseFirst.relativePath, '图片 资源(一)#50%/中文 方案[甲]-1.png');
  assert.equal(await readFile(path.join(chineseDirectory, chineseFirst.relativePath), 'utf8'), '中文图片');
  assert.equal(encodeMarkdownPath(chineseFirst.relativePath), '图片%20资源%28一%29%2350%25/中文%20方案%5B甲%5D-1.png');
  const chineseSecond = await saveChinese('jpg');
  assert.equal(chineseSecond.fileName, '中文 方案[甲]-2.jpg', 'sequence survives a new call and spans image formats');
  const concurrent = await Promise.all([saveChinese(), saveChinese(), saveChinese()]);
  assert.deepEqual(concurrent.map(value => value.fileName).sort(), ['中文 方案[甲]-3.png', '中文 方案[甲]-4.png', '中文 方案[甲]-5.png']);
  const renamedImage = await saveChinese('png', path.join(chineseDirectory, '新文档.md'));
  assert.equal(renamedImage.fileName, '新文档-1.png');
  assert.equal(await readFile(path.join(chineseDirectory, chineseFirst.relativePath), 'utf8'), '中文图片', 'renaming a document leaves older files intact');
  const chineseHost = createImageStorageHost({ read: () => ({documentFsPath: chineseDocument, imageStorage: chinesePreferences}), write: async () => {}, selectFolder: async () => null });
  const chinesePreview = await chineseHost.handle({type: 'imageLocation', action: 'read', requestId: 'chinese-preview'}, 'chinese');
  assert.ok(chinesePreview.result.ok);
  assert.equal(chinesePreview.result.value.state.examplePath, path.join(chineseDirectory, chinesePreferences.folder, '中文 方案[甲]-6.png'));
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
    const saved = await saveClipboardImageFile({ ...context, imageStorage: preferences, extension: 'png', contents: Buffer.from('image') });
    assert.equal(saved.relativePath, path.relative(documentDirectory, path.join(directory, 'draft.v2-1.png')).replace(/\\/g, '/'));
    assert.equal(await readFile(path.join(directory, 'draft.v2-1.png'), 'utf8'), 'image');
  }
  await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('advanced', 'images', documentFsPath), extension: 'png', contents: Buffer.from('image') }), /directories/);
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
  await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('advanced', 'images', link + '/new/sub'), extension: 'png', contents: Buffer.from('unsafe') }), /symbolic link|junction/);
  await assert.rejects(access(path.join(external, 'new')));
  if (process.platform === 'win32') {
    for (const extension of ['png:stream', '../png', 'png/', 'bad?png']) {
      await assert.rejects(saveClipboardImageFile({ ...context, imageStorage: storage('default'), extension, contents: Buffer.from('unsafe') }), /extension/);
    }
  }
  const same = await Promise.all([1, 2, 3].map(value => saveClipboardImageFile({ ...context, imageStorage: storage('perDocument'), extension: 'png', contents: Buffer.from(String(value)) })));
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
