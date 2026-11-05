import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { MAX_SIDEBAR_OUTLINE_HEADINGS, MAX_SIDEBAR_OUTLINE_TEXT_LENGTH } from '../src/protocol/sidebarOutline';
import { createSidebarOutlineReporter, type SidebarOutlineSource } from '../webview/src/adapters/sidebarOutline';
import { findOutlineHeadingIndex as findActiveHeadingIndex, outlineHeadingKeys } from '../src/foundation/outline';
import englishLabels from '../package.nls.json';
import chineseLabels from '../package.nls.zh-cn.json';

// Protocol: both directions validate shape and bounds.
const heading = (level: number, text: string, line: number) => ({ level, text, line });
assert.deepEqual(decodeWebviewToHostMessage({ type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, 'A', 1)], activeIndex: 0 }),
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, 'A', 1)], activeIndex: 0 });
assert.deepEqual(decodeWebviewToHostMessage({ type: 'sidebarOutline', snapshot: 'test:1', activeIndex: -1 }), { type: 'sidebarOutline', snapshot: 'test:1', activeIndex: -1 });
for (const invalid of [
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(7, 'A', 1)], activeIndex: 0 },
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, 'A', 0)], activeIndex: 0 },
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, 'x'.repeat(MAX_SIDEBAR_OUTLINE_TEXT_LENGTH + 1), 1)], activeIndex: 0 },
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, 'A', 1)], activeIndex: 1 },
  { type: 'sidebarOutline', snapshot: 'test:1', headings: [], activeIndex: -2 },
  { type: 'sidebarOutline', snapshot: 'test:1', headings: 'A', activeIndex: 0 },
  { type: 'sidebarOutline', snapshot: 'test:1', activeIndex: 0.5 }
]) assert.equal(decodeWebviewToHostMessage(invalid), null, JSON.stringify(invalid).slice(0, 80));
const extra = decodeWebviewToHostMessage({ type: 'sidebarOutline', snapshot: 'test:1', headings: [{ ...heading(2, 'B', 3), from: 9 }], activeIndex: -1 });
assert.deepEqual(extra, { type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(2, 'B', 3)], activeIndex: -1 }, 'unknown heading fields are dropped');
assert.deepEqual(decodeHostToWebviewMessage({ type: 'sidebarOutlineSubscription', enabled: true }), { type: 'sidebarOutlineSubscription', enabled: true });
assert.deepEqual(decodeHostToWebviewMessage({ type: 'revealOutlineHeading', snapshot: 'test:1', key: 'root/h1:a:0' }), { type: 'revealOutlineHeading', snapshot: 'test:1', key: 'root/h1:a:0' });
assert.equal(decodeHostToWebviewMessage({ type: 'sidebarOutlineSubscription', enabled: 1 }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'revealOutlineHeading', snapshot: 'test:1', line: 0 }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'revealOutlineHeading', key: 'root/h1:a:0' }), null, 'navigation requires a displayed snapshot');
assert.equal(decodeWebviewToHostMessage({ type: 'sidebarOutline', activeIndex: 0 }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'revealOutlineHeading', snapshot: 'test:1', key: '' }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'sidebarOutline', snapshot: 'test:1', activeIndex: MAX_SIDEBAR_OUTLINE_HEADINGS }), null);

// Active heading: same rule as the in-editor outline.
assert.equal(findActiveHeadingIndex([], 10), -1);
assert.equal(findActiveHeadingIndex([5, 20, 40], 4), -1);
assert.equal(findActiveHeadingIndex([5, 20, 40], 20), 1);
assert.equal(findActiveHeadingIndex([5, 20, 40], 99), 2);

// Webview reporter with deterministic timers.
const queue: Array<{ id: number; run: () => void; frame: boolean }> = [];
let nextHandle = 0;
const timers = {
  setTimeout: (run: () => void) => { const id = ++nextHandle; queue.push({ id, run, frame: false }); return id; },
  clearTimeout: (id: unknown) => { const index = queue.findIndex(item => item.id === id); if (index >= 0) queue.splice(index, 1); },
  requestFrame: (run: () => void) => { const id = ++nextHandle; queue.push({ id, run, frame: true }); return id; },
  cancelFrame: (id: unknown) => { const index = queue.findIndex(item => item.id === id); if (index >= 0) queue.splice(index, 1); }
};
const flush = () => { while (queue.length) queue.shift()!.run(); };

let scrollListener: (() => void) | null = null;
const interactionListeners = new Map<string, () => void>();
const scrollElement = {
  addEventListener: (type: string, listener: () => void) => {
    interactionListeners.set(type, listener);
    if (type === 'scroll') scrollListener = listener;
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (interactionListeners.get(type) === listener) interactionListeners.delete(type);
    if (type === 'scroll' && scrollListener === listener) scrollListener = null;
  }
} as unknown as EventTarget;
let headings = [
  { level: 1, text: ' Intro ', from: 0, line: 1 },
  { level: 2, text: 'Detail', from: 30, line: 4 },
  { level: 1, text: 'End', from: 80, line: 9 }
];
let anchor = 0;
let pending = false;
let visibleRange = { fromLine: 1, toLine: 3 };
const scrolled: number[] = [];
const source: SidebarOutlineSource = {
  getHeadings: () => headings,
  isOutlinePending: () => pending,
  getViewportAnchorOffset: () => anchor,
  getVisibleDocumentRange: () => visibleRange,
  getScrollElement: () => scrollElement,
  scrollToLine: line => { scrolled.push(line); }
};
const posted: any[] = [];
const reporter = createSidebarOutlineReporter(() => source, message => posted.push(message), timers);

reporter.schedule(); flush();
assert.equal(posted.length, 0, 'hidden sidebar does no work');
reporter.setEnabled(true); flush();
assert.deepEqual(posted.at(-1), { type: 'sidebarOutline', snapshot: posted[0].snapshot, activeIndex: 0, headings: [heading(1, 'Intro', 1), heading(2, 'Detail', 4), heading(1, 'End', 9)] });
assert.ok(scrollListener, 'scroll is observed while enabled');
reporter.schedule(); flush();
assert.equal(posted.length, 1, 'unchanged headings are not resent');
anchor = 35; visibleRange = { fromLine: 4, toLine: 8 }; scrollListener!(); scrollListener!(); flush();
assert.deepEqual(posted.slice(1), [{ type: 'sidebarOutline', snapshot: posted[0].snapshot, activeIndex: 1 }], 'scroll sends only the current heading, once per frame');
visibleRange = { fromLine: 3, toLine: 7 }; scrollListener!(); flush();
assert.equal(posted.length, 2, 'changing the visible range within the same section sends nothing');
headings = [...headings, { level: 2, text: 'More', from: 90, line: 11 }];
pending = true; reporter.schedule();
queue.shift()!.run();
assert.equal(posted.length, 2, 'pending outline is not published');
pending = false; flush();
assert.equal(posted.at(-1).headings.length, 4, 'retry publishes once the outline settles');
const endKey = outlineHeadingKeys(headings)[2];
reporter.reveal(endKey, posted.at(-1).snapshot);
assert.deepEqual(scrolled, [9], 'reveal uses the in-editor outline navigation');
headings = headings.map(heading => ({ ...heading, line: heading.line + 10 }));
reporter.schedule();
reporter.reveal(endKey, posted.at(-1).snapshot);
assert.deepEqual(scrolled, [9, 19], 'navigation resolves current source lines before the deferred publication');
pending = true;
const beforePendingReveal = scrolled.length;
reporter.reveal(endKey, posted.at(-1).snapshot);
assert.deepEqual(scrolled, [9, 19], 'pending cached headings cannot validate a stale navigation target');
scrollListener!();
reporter.refreshViewport();
pending = false;
flush();
assert.equal(scrolled.length, beforePendingReveal + 1, 'passive layout scrolling must not discard the pending heading click');
assert.equal(scrolled.at(-1), 19, 'the pending click navigates after complete identities are validated');
const beforeCanceledNavigation = scrolled.length;
const cancelByInteraction = ['wheel', 'pointerdown', 'keydown', 'beforeinput'].map(type => () => {
  assert.ok(interactionListeners.has(type), type + ' owns cancellation of an older heading click');
  interactionListeners.get(type)!();
});
for (const cancel of [...cancelByInteraction, () => reporter.schedule(), () => reporter.setEnabled(false)]) {
  pending = true;
  reporter.reveal(endKey, posted.at(-1).snapshot);
  cancel();
  pending = false;
  reporter.setEnabled(true);
  flush();
  assert.equal(scrolled.length, beforeCanceledNavigation, 'new user input, edits and hiding retire a pending click');
}
const beforePendingRename = scrolled.length;
pending = true;
reporter.reveal(endKey, posted.at(-1).snapshot);
headings = headings.map((heading, index) => index === 2 ? { ...heading, text: 'Renamed End' } : heading);
pending = false;
flush();
assert.equal(scrolled.length, beforePendingRename, 'a renamed target retires the pending click');
reporter.reveal(endKey, posted.at(-1).snapshot);
assert.equal(scrolled.length, beforePendingRename, 'a renamed old row cannot jump to an unrelated heading');
assert.equal(posted.at(-1).headings[2].text, 'Renamed End', 'stale navigation immediately refreshes the tree');
const renamedKey = outlineHeadingKeys(headings)[2];
reporter.reveal(renamedKey, posted.at(-1).snapshot);
assert.equal(scrolled.at(-1), 19, 'the refreshed row navigates normally');
const snapshotBeforeDuplicate = posted.at(-1).snapshot;
headings = [...headings.slice(0, 2), { ...headings[2], line: 18 }, ...headings.slice(2)];
const beforeDuplicate = scrolled.length;
reporter.reveal(renamedKey, posted.at(-1).snapshot);
assert.equal(scrolled.length, beforeDuplicate, 'inserting a duplicate invalidates old row identities');
reporter.reveal(renamedKey, snapshotBeforeDuplicate);
assert.equal(scrolled.length, beforeDuplicate, 'a delayed old row cannot select the new duplicate after publication');
reporter.setEnabled(false);
assert.equal(scrollListener, null, 'disabling releases the scroll listener');
assert.equal(interactionListeners.size, 0, 'disabling releases all navigation interaction listeners');
const resumedKey = outlineHeadingKeys(headings)[0];
reporter.setEnabled(true);
reporter.reveal(resumedKey, posted.at(-1).snapshot);
assert.equal(scrolled.at(-1), headings[0].line, 'the first click reopens a hidden editor before its subscription publication');
reporter.setEnabled(false);
const before = posted.length;
anchor = 0; reporter.schedule(); flush();
assert.equal(posted.length, before);
reporter.setEnabled(true); flush();
assert.ok(posted.at(-1).headings, 're-enabling resends all headings');

headings = Array.from({ length: MAX_SIDEBAR_OUTLINE_HEADINGS + 5 }, (_, index) => ({ level: 1, text: 'x'.repeat(MAX_SIDEBAR_OUTLINE_TEXT_LENGTH + 10), from: index, line: index + 1 }));
anchor = MAX_SIDEBAR_OUTLINE_HEADINGS + 100;
reporter.schedule(); flush();
const large = posted.at(-1);
assert.equal(large.headings.length, MAX_SIDEBAR_OUTLINE_HEADINGS);
assert.equal(large.headings[0].text.length, MAX_SIDEBAR_OUTLINE_TEXT_LENGTH);
assert.ok(decodeWebviewToHostMessage(large), 'bounded payload stays valid');
reporter.dispose();

// The production editor updates its pending flag only when getHeadings is read.
let parsed = false;
let cachedPending = false;
const coldMessages: any[] = [];
const cold = createSidebarOutlineReporter(() => ({
  ...source,
  getHeadings() { cachedPending = !parsed; return [{ level: 1, text: 'Cold', from: 0, line: 1 }]; },
  isOutlinePending: () => cachedPending
}), message => coldMessages.push(message), timers);
cold.setEnabled(true);
queue.shift()!.run();
assert.equal(coldMessages.length, 0, 'an incomplete initial outline is not published as empty or complete');
parsed = true;
queue.shift()!.run();
assert.equal(coldMessages[0].headings[0].text, 'Cold', 'retry probes the editor again after background parsing completes');
cold.dispose();

// Host tree view.
const contextKeys = new Map<string, unknown>();
const commands = new Map<string, (...args: any[]) => unknown>();
type Listener<T> = (value: T) => void;
class EventEmitter<T> {
  listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; };
  fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners = []; }
}
let treeView: any;
let provider: any;
const reveals: any[] = [];
const configuration = new EventEmitter<{ affectsConfiguration(key: string): boolean }>();
const collapsedNodes = new Set<string>();
mock.module('vscode', () => ({
  EventEmitter,
  TreeItem: class { id?: string; iconPath?: unknown; tooltip?: string; command?: any; constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  commands: {
    executeCommand: async (command: string, key: string, value: unknown) => { if (command === 'setContext') contextKeys.set(key, value); },
    registerCommand: (id: string, run: (...args: any[]) => unknown) => { commands.set(id, run); return { dispose: () => commands.delete(id) }; }
  },
  workspace: { onDidChangeConfiguration: configuration.event },
  window: {
    createTreeView: (_id: string, options: any) => {
      provider = options.treeDataProvider;
      const visibility = new EventEmitter<void>();
      const collapse = new EventEmitter<{ element: any }>();
      const expand = new EventEmitter<{ element: any }>();
      treeView = { visible: false, description: undefined, message: undefined, visibility,
        selection: [], collapse, expand,
        onDidChangeVisibility: visibility.event,
        onDidCollapseElement: collapse.event,
        onDidExpandElement: expand.event,
        reveal: async (node: any, options: any) => {
          reveals.push({ node, options });
          const expandChildren = (element: any, depth: number) => {
            if (depth <= 0 || !element.children.length) return;
            collapsedNodes.delete(element.id); expand.fire({ element });
            element.children.forEach((child: any) => expandChildren(child, depth - 1));
          };
          expandChildren(node, Math.min(3, Number(options.expand) || 0));
        }, dispose() {} };
      return treeView;
    }
  }
}));
const { createVscodeSidebarOutline, buildSidebarOutlineTree, SIDEBAR_OUTLINE_REVEAL_COMMAND, SIDEBAR_OUTLINE_EXPAND_COMMAND, SIDEBAR_OUTLINE_CONTEXT_KEY } = await import('../src/host/vscodeSidebarOutline');

const tree = buildSidebarOutlineTree([heading(1, 'A', 1), heading(3, 'B', 2), heading(2, 'C', 3), heading(2, 'C', 4), heading(1, 'D', 5)], 'p', {});
assert.deepEqual(tree.roots.map(node => node.heading.text), ['A', 'D']);
assert.deepEqual(tree.roots[0].children.map(node => node.heading.text), ['B', 'C', 'C']);
assert.equal(new Set(tree.nodes.map(node => node.id)).size, tree.nodes.length, 'duplicate headings get unique ids');
assert.equal(tree.nodes[2].parent, tree.roots[0]);
const edited = buildSidebarOutlineTree([heading(1, 'A', 1), heading(2, 'New', 2), heading(3, 'B', 3)], 'p', {});
assert.equal(edited.nodes[0].id, tree.nodes[0].id, 'ids stay stable across edits for preserved collapse state');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const createPanel = (active: boolean) => {
  const messages = new EventEmitter<unknown>();
  const viewState = new EventEmitter<void>();
  const panel = {
    active, visible: true, viewColumn: 1, revealed: 0, posted: [] as any[],
    webview: { onDidReceiveMessage: messages.event, postMessage: async (message: unknown) => { panel.posted.push(message); return true; } },
    onDidChangeViewState: viewState.event,
    reveal() { panel.revealed += 1; panel.visible = true; },
    receive: (message: unknown) => messages.fire(message),
    changeViewState: () => viewState.fire()
  };
  return panel;
};
const documentFor = (path: string) => ({ uri: { path, toString: () => `file://${path}` } });
let language = 'zh-CN';
const outline = createVscodeSidebarOutline(() => language);
assert.equal(treeView.message, '没有活动的 MEO 编辑器。');
const left = createPanel(true), right = createPanel(false);
const leftHandle = outline.attach(left as any, documentFor('/w/1.md') as any);
const rightHandle = outline.attach(right as any, documentFor('/w/2.md') as any);
await settle();
assert.equal(contextKeys.get(SIDEBAR_OUTLINE_CONTEXT_KEY), true);
assert.equal(treeView.description, '1.md', 'the active editor is shown');
assert.deepEqual(left.posted, [], 'subscription waits for the Panel Session initialization boundary');
leftHandle.setReady(true); rightHandle.setReady(true); await settle();
assert.deepEqual(left.posted, [{ type: 'sidebarOutlineSubscription', enabled: false }]);
treeView.visible = true; treeView.visibility.fire(); await settle();
assert.deepEqual(right.posted.at(-1), { type: 'sidebarOutlineSubscription', enabled: false }, 'background editors remain unsubscribed');

leftHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, '1', 1), heading(2, '11', 2)], activeIndex: 1 });
const roots = provider.getChildren(undefined);
assert.deepEqual(roots.map((node: any) => node.heading.text), ['1']);
assert.deepEqual(provider.getChildren(roots[0]).map((node: any) => node.heading.text), ['11']);
const item = provider.getTreeItem(roots[0]);
assert.equal(typeof item.label, 'string', 'rows use plain labels without viewport range emphasis');
assert.equal(item.collapsibleState, 2);
assert.equal(item.tooltip, 'H1 · 第 1 行');
assert.equal(item.iconPath, undefined, 'heading rows have no leading icon');
assert.equal(provider.getParent(provider.getChildren(roots[0])[0]), roots[0]);
await settle();
assert.equal(reveals.length, 0, 'initial publication does not open a collapsed ancestor');
leftHandle.update({ type: 'sidebarOutline', snapshot: 'old', activeIndex: 0 });
assert.equal(reveals.length, 0, 'viewport deltas from another snapshot are ignored');
leftHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', activeIndex: 0 });
leftHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', activeIndex: 1 });
assert.equal(reveals.at(-1).node.heading.text, '11', 'the current heading is selected');
assert.equal(reveals.at(-1).options.focus, false, 'following never steals focus');

left.active = false; right.active = true; left.changeViewState(); right.changeViewState();
rightHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', headings: [heading(1, '2', 1), heading(2, '2', 2)], activeIndex: 0 });
assert.equal(treeView.description, '2.md', 'split editing follows the focused editor');
assert.deepEqual(provider.getChildren(undefined).map((node: any) => node.heading.text), ['2']);
right.active = false; right.changeViewState();
assert.equal(treeView.description, '2.md', 'focusing the sidebar keeps the last editor');

const target = provider.getChildren(provider.getChildren(undefined)[0])[0];
right.visible = false;
commands.get(SIDEBAR_OUTLINE_REVEAL_COMMAND)!(target); await settle();
assert.deepEqual(right.posted.at(-1), { type: 'revealOutlineHeading', snapshot: 'test:1', key: target.key });
assert.equal(right.revealed, 1, 'a hidden editor tab is brought back without focus');
assert.ok(!left.posted.some(message => message.type === 'revealOutlineHeading'));

rightHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', headings: [], activeIndex: -1 });
assert.equal(treeView.message, '当前文档没有标题。');
rightHandle.dispose();
assert.equal(treeView.description, '1.md', 'closing the shown editor falls back to another one');
const deep = Array.from({ length: 6 }, (_, index) => heading(index + 1, `Heading ${index + 1}`, index + 1));
leftHandle.update({ type: 'sidebarOutline', snapshot: 'test:1', headings: deep, activeIndex: 5 });
let deepNode = provider.getChildren(undefined)[0];
while (deepNode.children.length) {
  collapsedNodes.add(deepNode.id); treeView.collapse.fire({ element: deepNode }); deepNode = deepNode.children[0];
}
await commands.get(SIDEBAR_OUTLINE_EXPAND_COMMAND)!();
const expandedRoots = provider.getChildren(undefined);
assert.ok(expandedRoots[0].id !== roots[0].id, 'explicit expand all resets native expansion identities once');
let expandedNode = expandedRoots[0];
for (let level = 1; level < 6; level += 1) {
  assert.equal(provider.getTreeItem(expandedNode).collapsibleState, 2);
  assert.ok(!collapsedNodes.has(expandedNode.id), 'every branch receives fresh expanded state');
  expandedNode = expandedNode.children[0];
}
language = 'en'; configuration.fire({ affectsConfiguration: key => key === 'meoEnhanced.language' });
assert.equal(treeView.title, 'MEO Outline');
assert.equal(provider.getTreeItem(deepNode).tooltip, 'H6 · Line 6');
language = 'zh-CN'; configuration.fire({ affectsConfiguration: key => key === 'meoEnhanced.language' });
assert.equal(treeView.title, 'MEO Outline');
assert.equal(treeView.title, englishLabels['view.outline']);
assert.equal(treeView.title, chineseLabels['view.outline'], 'view and container titles match in both locales');
assert.equal(provider.getTreeItem(deepNode).tooltip, 'H6 · 第 6 行');
commands.get(SIDEBAR_OUTLINE_REVEAL_COMMAND)!(target); await settle();
assert.equal(right.posted.filter(message => message.type === 'revealOutlineHeading').length, 1, 'closed editors ignore stale tree items');
leftHandle.dispose(); await settle();
assert.equal(contextKeys.get(SIDEBAR_OUTLINE_CONTEXT_KEY), false);
assert.equal(treeView.message, '没有活动的 MEO 编辑器。');
outline.dispose();
assert.equal(commands.has(SIDEBAR_OUTLINE_REVEAL_COMMAND), false);

const recentOutline = createVscodeSidebarOutline(() => 'en');
const first = createPanel(true), second = createPanel(false), newest = createPanel(false);
const firstHandle = recentOutline.attach(first as any, documentFor('/first.md') as any);
const secondHandle = recentOutline.attach(second as any, documentFor('/second.md') as any);
recentOutline.attach(newest as any, documentFor('/newest.md') as any);
first.active = false; second.active = true; second.changeViewState();
second.active = false; first.active = true; first.changeViewState();
first.active = false; second.visible = false; newest.visible = false;
firstHandle.dispose();
assert.equal(treeView.description, 'second.md', 'closing a hidden editor restores the most recently focused MEO document');
const postedBeforeDispose = second.posted.length;
recentOutline.dispose();
secondHandle.setReady(true); second.changeViewState(); await settle();
assert.equal(second.posted.length, postedBeforeDispose, 'owner disposal detaches every panel and rejects late initialization');

console.log('Sidebar outline: protocol, active heading, webview reporter, tree, split focus, reveal and lifecycle passed');
