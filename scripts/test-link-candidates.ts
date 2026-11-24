import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { URI, Utils } from 'vscode-uri';
import { searchWikiCandidates, shortestWikiTarget } from '../src/application/wikiCandidateSearch';
import { candidateMatchPositions } from '../src/foundation/candidateText';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { detectSuggestionContext } from '../webview/src/application/inputSuggestions';
import { decodeEditorServiceRequest, decodeEditorServiceResponse } from '../src/protocol/editorServices';
import { decodeHostEditorEvent } from '../src/protocol/hostEditorEvents';

const root = URI.file('D:/workspace'), vault = Utils.joinPath(root, 'vault');
let roots = [URI.file('E:/unrelated'), root];
const files = new Map<string, { uri: URI; text: string }>(), directories = new Map<string, URI>();
const searches: string[] = [];
const watchers: Array<{ change?: (uri: URI) => void; create?: (uri: URI) => void; remove?: (uri: URI) => void }> = [];
const addDirectory = (uri: URI) => { directories.set(uri.toString(), uri); };
const add = (uri: URI, text = '# Note') => {
  files.set(uri.toString(), { uri, text });
  for (let directory = Utils.joinPath(uri, '..'); ; directory = Utils.joinPath(directory, '..')) {
    addDirectory(directory); if (Utils.joinPath(directory, '..').path === directory.path) break;
  }
};
const owns = (base: URI, uri: URI) => base.scheme === uri.scheme && base.authority === uri.authority
  && (uri.path === base.path || uri.path.startsWith(base.path.replace(/\/$/, '') + '/'));
mock.module('vscode', () => ({
  Uri: { file: URI.file, parse: URI.parse, joinPath: Utils.joinPath },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  RelativePattern: class { constructor(readonly baseUri: URI, readonly pattern: string) {} },
  CancellationTokenSource: class {
    private cancelled = false;
    get token() { const source = this; return { get isCancellationRequested() { return source.cancelled; } }; }
    cancel() { this.cancelled = true; }
    dispose() {}
  },
  workspace: {
    getWorkspaceFolder: (uri: URI) => { const folder = roots.find(root => owns(root, uri)); return folder ? { uri: folder } : undefined; },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    asRelativePath: (uri: URI) => { const base = roots.find(root => owns(root, uri)); return base ? uri.path.slice(base.path.length + 1) : uri.path; },
    findFiles: async (pattern: { baseUri: URI }) => { searches.push(pattern.baseUri.toString()); return [...files.values()].filter(file => owns(pattern.baseUri, file.uri)).map(file => file.uri); },
    createFileSystemWatcher: () => {
      const watcher: (typeof watchers)[number] = {}; watchers.push(watcher);
      return { onDidCreate: (listener: (uri: URI) => void) => { watcher.create = listener; }, onDidDelete: (listener: (uri: URI) => void) => { watcher.remove = listener; },
        onDidChange: (listener: (uri: URI) => void) => { watcher.change = listener; }, dispose() {} };
    },
    fs: {
      stat: async (uri: URI) => {
        if (directories.has(uri.toString())) return { type: 2, size: 0 };
        const file = files.get(uri.toString()); if (!file) throw new Error('not found');
        return { type: 1, size: Buffer.byteLength(file.text) };
      },
      readFile: async (uri: URI) => { const file = files.get(uri.toString()); if (!file) throw new Error('not found'); return Buffer.from(file.text); },
      readDirectory: async (uri: URI) => {
        if (!directories.has(uri.toString())) throw new Error('not found');
        const rows = new Map<string, number>();
        for (const folder of directories.values()) if (Utils.joinPath(folder, '..').toString() === uri.toString()) rows.set(folder.path.split('/').at(-1)!, 2);
        for (const file of files.values()) if (Utils.joinPath(file.uri, '..').toString() === uri.toString()) rows.set(file.uri.path.split('/').at(-1)!, 1);
        return [...rows];
      }
    }
  }
}));
const { runEditorService } = await import('../src/host/editorServices');
const { resolveLocalLinkTargetUri, resolveLocalImageTargetUri } = await import('../src/shared/documentLinks');
const { resolveWikiResource, onDidChangeWikiResources, disposeWikiResources } = await import('../src/host/wikiResources');
const { rewriteExportImageSrc } = await import('../src/export/assetPaths');
const { renderMarkdownToHtml } = await import('../src/export/renderMarkdown');
const { currentHeadingSuggestions } = await import('../webview/src/editor/headingSuggestions');
const { findDocumentFragmentPosition } = await import('../webview/src/helpers/linkNavigation');
const document = Utils.joinPath(vault, 'notes', 'current.md');
add(document); addDirectory(Utils.joinPath(vault, '.obsidian'));
const plan = Utils.joinPath(vault, 'notes', 'project-plan.md');
add(plan, '---\ntitle: 项目说明\naliases: [项目规划, planning]\n---\n# Project Plan\n## Setup\n## Setup\n');
add(Utils.joinPath(vault, 'notes', 'todo.md'));
add(Utils.joinPath(vault, 'work', 'todo.md'));
add(Utils.joinPath(vault, 'notes', 'release.v1.md'));
add(Utils.joinPath(vault, 'notes', 'draft.md'));
add(Utils.joinPath(vault, 'notes', 'draft.markdown'));
add(Utils.joinPath(vault, 'notes', "docs'backup", 'note.md'));
add(Utils.joinPath(root, 'README.md'), '# Root\n## Overview');
add(URI.file('/README.md'), '# Wrong filesystem root');
add(Utils.joinPath(root, 'image.png'));
add(Utils.joinPath(vault, 'image.png'));
add(Utils.joinPath(roots[0], 'external-plan.md'));
const lookup = async (kind: 'documents' | 'paths' | 'headings', query: string, target = '', wiki = false) => {
  const result = await runEditorService({ type: 'editorService', requestId: 'candidate-test', action: 'links', kind, query, target, wiki }, document as never);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  assert.ok(result.result.ok && 'candidates' in result.result.value);
  return result.result.value.candidates;
};
const metadataChange = (candidatesOnly = true) => new Promise<void>((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout>;
  const listener = onDidChangeWikiResources(only => { if (only || !candidatesOnly) { listener.dispose(); clearTimeout(timer); resolve(); } });
  timer = setTimeout(() => { listener.dispose(); reject(new Error('metadata refresh did not arrive')); }, 2000);
});
try {
  for (const [input, expected, length] of [
    ["[Go](/vault/notes/docs'backup/no'te", "/vault/notes/docs'backup/note", 5],
    ["[Go](docs'backup\\no'te", "docs'backup\\note", 5],
    ["[[/notes/docs'backup/no'te", "/notes/docs'backup/note", 5],
    ["[[docs'backup/no'te", "docs'backup/note", 17]
  ] as const) {
    const context = detectSuggestionContext(input, defaultInputAssistance, true);
    assert.equal(context?.query, expected, 'IME filtering preserves the existing directory prefix');
    assert.equal(context?.length, length, 'replacement retains the raw preedit span');
  }
  const quotedPath = detectSuggestionContext("[Go](/vault/notes/docs'backup/no'te", defaultInputAssistance, true)!;
  assert.equal((await lookup('paths', quotedPath.query))[0].insert, 'note.md', 'quoted parent directories remain browsable during IME preedit');
  assert.equal(detectSuggestionContext("[Go](docs'backup/no'te", defaultInputAssistance)?.query, "docs'backup/no'te", 'ordinary filename quotes remain literal');
  const headingPreedit = detectSuggestionContext("[Go](docs'backup/note.md#o'ver", defaultInputAssistance, true)!;
  assert.equal(headingPreedit.target, "docs'backup/note.md", 'heading preedit preserves its document target');
  assert.equal(headingPreedit.query, 'over');
  assert.equal((await resolveLocalLinkTargetUri('/README.md', document as never))?.toString(), Utils.joinPath(root, 'README.md').toString());
  assert.equal((await resolveLocalImageTargetUri('/image.png', document as never))?.toString(), Utils.joinPath(root, 'image.png').toString(), 'explicit / uses the workspace even inside a vault');
  const paths = await lookup('paths', '/');
  assert.equal(paths[0].kind, 'directory');
  assert.ok(paths.some(item => item.insert === 'README.md' && item.kind === 'file'));
  assert.deepEqual((await lookup('paths', './pr')).map(item => item.insert), ['project-plan.md']);
  assert.equal((await lookup('headings', '', '/README.md'))[0].label, 'Root');
  const metadataReady = metadataChange();
  assert.equal((await lookup('documents', 'pp'))[0].detail, 'notes/project-plan.md');
  assert.equal((await lookup('documents', 'project plan'))[0].detail, 'notes/project-plan.md');
  assert.equal((await lookup('documents', 'notes project'))[0].detail, 'notes/project-plan.md');
  assert.ok((await lookup('documents', 'notes/')).every(item => item.detail.startsWith('notes/')));
  assert.deepEqual(await lookup('documents', 'external'), [], 'other workspaces are outside Wiki lookup');
  assert.ok(searches.every(path => path === vault.toString()), 'completion shares navigation scope');
  const todos = await lookup('documents', 'todo');
  assert.deepEqual(todos.map(item => item.insert), ['notes/todo', 'work/todo']);
  for (const item of todos) assert.equal((await resolveWikiResource(item.insert, document as never)).uri?.toString(), Utils.joinPath(vault, item.detail).toString());
  const dotted = (await lookup('documents', 'release.v1'))[0];
  assert.equal(dotted.insert, 'release.v1.md');
  assert.equal((await resolveWikiResource(dotted.insert, document as never)).uri?.toString(), Utils.joinPath(vault, dotted.detail).toString());
  const extensions = await lookup('documents', 'draft');
  assert.deepEqual(extensions.map(item => item.insert).sort(), ['/notes/draft.markdown', '/notes/draft.md']);
  for (const item of extensions) assert.equal((await resolveWikiResource(item.insert, document as never)).uri?.toString(), Utils.joinPath(vault, item.detail).toString());
  assert.equal(shortestWikiTarget('a/Note.md', ['a/Note.md', 'b/note.md'], true), 'a/Note');
  assert.deepEqual(candidateMatchPositions('x🚀y文档', '🚀文'), [1, 2, 4], 'fuzzy highlighting retains complete Unicode characters');
  assert.equal((await resolveWikiResource('/notes/project-plan', document as never)).uri?.toString(), plan.toString());
  assert.equal((await lookup('paths', '/', '', true)).find(item => item.label === 'image.png')?.detail, 'vault/image.png');
  // Filename candidates are available before the metadata read finishes; a bounded event refreshes aliases.
  await metadataReady;
  const alias = (await lookup('documents', '项目规划'))[0];
  assert.equal(alias.insert, 'project-plan|项目规划');
  assert.equal((await lookup('documents', '项目说明'))[0].insert, 'project-plan|项目说明');
  assert.deepEqual((await lookup('headings', 'Setup', 'project-plan', true)).map(item => item.anchor), ['setup', 'setup-2']);
  for (const [headings, anchors] of [
    [['Notes', 'Notes', 'Notes 2'], ['notes', 'notes-2', 'notes-2-2']],
    [['Notes 2', 'Notes', 'Notes', 'Notes'], ['notes-2', 'notes', 'notes-3', 'notes-4']],
    [['Notes', 'Notes', 'Notes 3'], ['notes', 'notes-2', 'notes-3']]
  ] as const) {
    const text = headings.map(heading => `# ${heading}`).join('\n\n');
    const repeated = Utils.joinPath(vault, 'notes', 'repeated.md'); add(repeated, text);
    try {
      assert.deepEqual((await lookup('headings', '', 'repeated.md')).map(item => item.anchor), anchors, 'every heading candidate has its own anchor');
      assert.deepEqual(currentHeadingSuggestions(text).map(item => item.anchor), anchors);
      const rendered = renderMarkdownToHtml({ markdownText: text, markdownFilePath: repeated.fsPath, target: 'html' }).html;
      assert.deepEqual([...rendered.matchAll(/<h1\b[^>]*\bid="([^"]*)"/g)].map(match => match[1]), anchors, 'candidates match rendered ids');
      const state = EditorState.create({ doc: text, extensions: [markdown()] });
      assert.deepEqual(anchors.map(anchor => state.doc.lineAt(findDocumentFragmentPosition(state, '#' + anchor)!).number),
        headings.map((_, index) => index * 2 + 1), 'Live and Source navigate each anchor to its own heading');
    } finally { files.delete(repeated.toString()); }
  }
  const updatedMetadata = metadataChange();
  add(plan, '---\naliases: [新规划]\n---\n# Updated'); watchers.forEach(watcher => watcher.change?.(plan));
  await lookup('documents', '新规划');
  await updatedMetadata;
  assert.equal((await lookup('documents', '新规划'))[0].insert, 'project-plan|新规划');
  assert.deepEqual(await lookup('documents', '项目规划'), [], 'old aliases are invalidated');
  for (const [frontmatter, anchors] of [
    ['---\ntitle: My Post\ndate: 2026-11-24\n---\n', ['intro', 'setup']],
    ['---\n# internal note\ntags: [a]\n---\n', ['intro', 'setup']],
    ['﻿---\r\ntitle: My Post\r\n--- \r\n', ['intro', 'setup']],
    ['---\ntitle: [unclosed\n---\n', ['intro', 'setup']],
    ['---\ntitle: My Post\n\n', ['intro', 'setup']],
    ['Text\n\n---\n', ['intro', 'setup']],
    ['Title\n---\n', ['title', 'intro', 'setup']]
  ] as const) {
    const text = frontmatter + '# Intro\n\n***\n\n## Setup\n', post = Utils.joinPath(vault, 'notes', 'post.md'); add(post, text);
    try {
      for (const wiki of [false, true]) {
        assert.deepEqual((await lookup('headings', '', wiki ? 'notes/post' : 'post.md', wiki)).map(item => item.anchor), anchors, frontmatter);
      }
      assert.deepEqual(currentHeadingSuggestions(text).map(item => item.anchor), anchors, frontmatter);
      const rendered = renderMarkdownToHtml({ markdownText: text, markdownFilePath: post.fsPath, target: 'html' }).html;
      assert.deepEqual([...rendered.matchAll(/<h[12]\b[^>]*\bid="([^"]*)"/g)].map(match => match[1]), anchors, 'candidates match rendered ids');
      const state = EditorState.create({ doc: text, extensions: [markdown()] });
      assert.equal(state.doc.lineAt(findDocumentFragmentPosition(state, '#intro')!).text, '# Intro', 'the frontmatter lines still count');
      assert.equal(findDocumentFragmentPosition(state, '#title-my-post-date-2026-11-24'), null);
    } finally { files.delete(post.toString()); }
  }
  const newNote = Utils.joinPath(vault, 'notes', 'fresh.md'), namesChanged = metadataChange(false);
  add(newNote); watchers.forEach(watcher => watcher.create?.(newNote));
  await namesChanged;
  assert.equal((await lookup('documents', 'fresh'))[0].detail, 'notes/fresh.md', 'filename changes refresh an unclosed Wiki candidate menu');
  const removedNote = metadataChange(false); files.delete(newNote.toString()); watchers.forEach(watcher => watcher.remove?.(newNote));
  await removedNote;
  assert.deepEqual(await lookup('documents', 'fresh'), [], 'deleted files invalidate the shared index');
  const many = Array.from({ length: 80 }, (_, index) => ({ name: 'plan-' + index, path: 'archive/plan-' + index + '.md' }));
  many.push({ name: 'plan', path: 'work/plan.md' });
  const ranked = searchWikiCandidates(many, 'plan', 'notes');
  assert.equal(ranked.length, 50); assert.equal(ranked[0].entry.name, 'plan', 'score before limiting');
  assert.deepEqual(searchWikiCandidates([...many].reverse(), 'plan', 'notes').map(item => item.entry.path), ranked.map(item => item.entry.path), 'enumeration order does not change ranking');
  const remote = URI.parse('vscode-remote://test-host/workspace'); roots = [remote];
  const remoteDocument = Utils.joinPath(remote, 'notes', 'current.md'); add(remoteDocument); add(Utils.joinPath(remote, 'README.md'));
  assert.equal((await resolveLocalLinkTargetUri('/README.md', remoteDocument as never))?.toString(), Utils.joinPath(remote, 'README.md').toString());
  roots = [];
  assert.equal((await resolveLocalLinkTargetUri('/todo.md', document as never))?.toString(), Utils.joinPath(vault, 'notes', 'todo.md').toString(), 'no workspace uses the document directory');
  disposeWikiResources();
  assert.equal((await lookup('documents', 'todo')).length, 2, 'standalone vault completion uses its filesystem provider');
  assert.equal(decodeEditorServiceRequest({ type: 'editorService', requestId: 'x', action: 'links', kind: 'headings', query: '', target: '', wiki: 'yes' }), null);
  assert.equal(decodeEditorServiceResponse({ type: 'editorServiceResult', requestId: 'x', result: { ok: true, value: { candidates: [{ label: 'x', insert: 'x', detail: '', kind: 'unknown' }] } } }), null);
  assert.deepEqual(decodeHostEditorEvent({ type: 'wikiCandidatesChanged' }), { type: 'wikiCandidatesChanged' });
  assert.equal(rewriteExportImageSrc('/image.png', { markdownFilePath: document.fsPath, workspaceRootPath: root.fsPath, target: 'pdf' }).includes('/workspace/image.png'), true, 'export uses the same explicit root');
  console.log('Link candidates: workspace/remote paths, single-level directories, vault scope, fuzzy/multiword ranking, aliases, unique targets, refresh and codecs passed');
} finally { disposeWikiResources(); }
