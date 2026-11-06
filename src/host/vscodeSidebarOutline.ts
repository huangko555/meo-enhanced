import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { SidebarOutlineHeading, SidebarOutlineHostEvent, SidebarOutlineMessage } from '../protocol/sidebarOutline';
import { outlineHeadingKeys } from '../foundation/outline';

export const SIDEBAR_OUTLINE_VIEW_ID = 'meoEnhanced.outline';
export const SIDEBAR_OUTLINE_REVEAL_COMMAND = 'meoEnhanced.outline.revealHeading';
export const SIDEBAR_OUTLINE_CONTEXT_KEY = 'meoEnhanced.outline.hasEditor';
export const SIDEBAR_OUTLINE_EXPAND_COMMAND = 'meoEnhanced.outline.expandAll';

type Entry = {
  readonly panel: vscode.WebviewPanel;
  readonly document: vscode.TextDocument;
  readonly treeIdPrefix: string;
  roots: OutlineNode[];
  nodes: OutlineNode[];
  activeIndex: number;
  collapsedKeys: Set<string>;
  loaded: boolean;
  enabled: boolean;
  lastFocused: number;
  expansionVersion: number;
  snapshot: string;
  post(event: SidebarOutlineHostEvent): void;
  dispose(): void;
};

export type OutlineNode = SidebarOutlineTreeNode<SidebarOutlineHeading, { readonly entry: Entry; readonly snapshot: string }>;

export type SidebarOutlineTreeNode<T, E> = E & {
  readonly heading: T;
  readonly id: string;
  readonly key: string;
  readonly parent: SidebarOutlineTreeNode<T, E> | null;
  readonly children: SidebarOutlineTreeNode<T, E>[];
};

/** Same nesting and stable keys as the in-editor outline, so collapse state survives edits. */
export function buildSidebarOutlineTree<T extends { level: number; text: string }, E extends object>(
  headings: readonly T[], prefix: string, extra: E
) {
  type Node = SidebarOutlineTreeNode<T, E>;
  const roots: Node[] = [];
  const nodes: Node[] = [];
  const stack: Node[] = [];
  const keys = outlineHeadingKeys(headings);
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
    const parent = stack.at(-1) ?? null;
    const key = keys[nodes.length];
    const node: Node = { ...extra, heading, id: `${prefix}/${key}`, key, parent, children: [] };
    (parent ? parent.children : roots).push(node);
    nodes.push(node);
    stack.push(node);
  }
  return { roots, nodes };
}

function documentName(document: vscode.TextDocument): string {
  const path = document.uri.path;
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/**
 * Explorer view mirroring the outline of the most recently active MEO editor.
 * Webviews publish headings only while this view is visible.
 */
export function createVscodeSidebarOutline(language: () => string) {
  const entries = new Set<Entry>();
  let current: Entry | null = null;
  let disposed = false;
  let expansionGeneration = 0;
  let focusSequence = 0;
  const changed = new vscode.EventEmitter<OutlineNode | OutlineNode[] | undefined>();
  // Native callbacks visit every heading; shared labels follow configuration
  // changes without reading configuration again for every tree item.
  let uiLanguage = language();
  const zh = () => uiLanguage === 'zh-CN';

  const provider: vscode.TreeDataProvider<OutlineNode> = {
    onDidChangeTreeData: changed.event,
    getChildren: node => node ? node.children : current?.roots ?? [],
    getParent: node => node.parent ?? undefined,
    getTreeItem: node => {
      const item = new vscode.TreeItem(
        node.heading.text || (zh() ? '（空标题）' : '(empty heading)'),
        node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.id = `${node.entry.expansionVersion}/${node.id}`;
      item.accessibilityInformation = { label: `${node.heading.text || (zh() ? '空标题' : 'Empty heading')}, H${node.heading.level}` };
      return item;
    },
    resolveTreeItem: (item, node) => {
      // Bulk expansion can visit every heading. Native hover/open resolution
      // avoids allocating and transferring action metadata for untouched rows.
      item.tooltip ??= zh() ? `H${node.heading.level} · 第 ${node.heading.line} 行` : `H${node.heading.level} · Line ${node.heading.line}`;
      item.command ??= { command: SIDEBAR_OUTLINE_REVEAL_COMMAND, title: zh() ? '跳转到标题' : 'Go to Heading', arguments: [node] };
      return item;
    }
  };
  const view = vscode.window.createTreeView(SIDEBAR_OUTLINE_VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  const presentHeader = () => {
    view.title = 'MEO Outline';
    view.description = current ? documentName(current.document) : undefined;
    view.message = !current
      ? (zh() ? '没有活动的 MEO 编辑器。' : 'No active MEO editor.')
      : current.loaded && current.nodes.length === 0
        ? (zh() ? '当前文档没有标题。' : 'The document has no headings.')
        : undefined;
  };
  const revealActive = () => {
    if (!current || !view.visible) return;
    let node = current.nodes[current.activeIndex];
    for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
      if (current.collapsedKeys.has(ancestor.key)) node = ancestor;
    }
    if (node) void Promise.resolve(view.reveal(node, { select: true, focus: false })).catch(() => undefined);
  };
  const syncSubscriptions = () => {
    for (const entry of entries) {
      const enabled = !disposed && view.visible && entry === current && entry.panel.visible;
      if (entry.enabled === enabled) continue;
      entry.enabled = enabled;
      entry.post({ type: 'sidebarOutlineSubscription', enabled });
    }
  };
  const show = (entry: Entry | null) => {
    expansionGeneration += 1;
    current = entry;
    if (entry) entry.lastFocused = ++focusSequence;
    syncSubscriptions();
    presentHeader();
    changed.fire(undefined);
    revealActive();
  };
  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', SIDEBAR_OUTLINE_CONTEXT_KEY, entries.size > 0);
  };

  const subscriptions: vscode.Disposable[] = [
    view,
    changed,
    view.onDidChangeVisibility(() => {
      expansionGeneration += 1;
      syncSubscriptions();
      if (view.visible) revealActive();
    }),
    view.onDidCollapseElement(({ element }) => {
      expansionGeneration += 1;
      element.entry.collapsedKeys.add(element.key);
    }),
    view.onDidExpandElement(({ element }) => element.entry.collapsedKeys.delete(element.key)),
    vscode.commands.registerCommand(SIDEBAR_OUTLINE_EXPAND_COMMAND, async () => {
      const entry = current;
      if (!entry || !view.visible) return;
      const generation = ++expansionGeneration;
      const selectedKey = view.selection[0]?.key;
      // TreeView has no public bulk-expand API and reveal expands only three
      // levels. Reset view identities once for this explicit action, so native
      // rendering applies Expanded to every branch without thousands of IPCs.
      // Only native row identities change: reuse the heading tree and snapshot
      // rather than rebuilding every node for an unchanged document.
      entry.expansionVersion += 1;
      entry.collapsedKeys.clear();
      changed.fire(undefined);
      const selected = entry.nodes.find(node => node.key === selectedKey) ?? entry.roots[0];
      if (selected && generation === expansionGeneration && current === entry && !disposed) {
        try { await view.reveal(selected, { select: true, focus: false }); }
        catch (error) {
          if (generation !== expansionGeneration || current !== entry || disposed) return;
          throw error;
        }
      }
    }),
    vscode.commands.registerCommand(SIDEBAR_OUTLINE_REVEAL_COMMAND, (node?: OutlineNode) => {
      if (!node || !entries.has(node.entry)) return;
      const { panel } = node.entry;
      // Keep focus in the tree, like the native Outline: arrow keys continue to navigate.
      if (!panel.visible) panel.reveal(panel.viewColumn, true);
      node.entry.post({ type: 'revealOutlineHeading', key: node.key, snapshot: node.snapshot });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('meoEnhanced.language')) {
        uiLanguage = language();
        presentHeader();
        changed.fire(undefined);
      }
    })
  ];
  presentHeader();

  function attach(panel: vscode.WebviewPanel, document: vscode.TextDocument) {
    let ready = false;
    let detached = false;
    const deliver = async (event: SidebarOutlineHostEvent) => {
      if (!ready || detached || disposed) return;
      // Visibility/focus can change while initialization is in flight.
      await panel.webview.postMessage(event.type === 'sidebarOutlineSubscription'
        ? { type: event.type, enabled: entry.enabled } : event);
    };
    const entry: Entry = {
      panel,
      document,
      // Keep identities stable without repeating a potentially long URI in
      // every native row and child request.
      treeIdPrefix: createHash('sha256').update(document.uri.toString()).digest('base64url'),
      roots: [],
      nodes: [],
      activeIndex: -1,
      collapsedKeys: new Set(),
      loaded: false,
      enabled: false,
      lastFocused: 0,
      expansionVersion: 0,
      snapshot: '',
      post: event => { void deliver(event).catch(error => {
        if (!detached && !disposed) console.error('MEO outline message could not be delivered', error);
      }); },
      dispose() {
        if (detached) return;
        detached = true;
        panelSubscriptions.forEach(subscription => subscription.dispose());
        entries.delete(entry);
        if (disposed) return;
        updateContext();
        if (current === entry) {
          const remaining = [...entries];
          show(remaining.find(other => other.panel.active)
            ?? remaining.sort((left, right) => right.lastFocused - left.lastFocused)[0] ?? null);
        }
      }
    };
    entries.add(entry);
    updateContext();
    if (panel.active || !current) show(entry);

    const panelSubscriptions = [
      panel.onDidChangeViewState(() => {
        if (panel.active && current !== entry) show(entry);
        else syncSubscriptions();
      })
    ];

    return {
      setReady(value: boolean) {
        if (detached || disposed) return;
        ready = value;
        if (ready) entry.post({ type: 'sidebarOutlineSubscription', enabled: entry.enabled });
      },
      update(message: SidebarOutlineMessage) {
        if (detached || disposed || !ready || !entry.enabled) return;
        if (!message.headings && message.snapshot !== entry.snapshot) return;
        if (message.activeIndex >= (message.headings?.length ?? entry.nodes.length)) return;
        if (message.headings) {
          entry.snapshot = message.snapshot;
          expansionGeneration += 1;
          ({ roots: entry.roots, nodes: entry.nodes } = buildSidebarOutlineTree(message.headings, entry.treeIdPrefix, { entry, snapshot: entry.snapshot }));
          entry.loaded = true;
          const keys = new Set(entry.nodes.map(node => node.key));
          entry.collapsedKeys = new Set([...entry.collapsedKeys].filter(key => keys.has(key)));
        }
        const headingsChanged = message.headings !== undefined;
        const activeChanged = entry.activeIndex !== message.activeIndex;
        entry.activeIndex = message.activeIndex;
        if (entry !== current) return;
        if (headingsChanged) { presentHeader(); changed.fire(undefined); }
        // Initial data must not open an ancestor before native collapse events
        // arrive (for example while a webview is reinitialized).
        if (!headingsChanged && activeChanged) revealActive();
      },
      dispose: entry.dispose
    };
  }

  return {
    attach,
    dispose() {
      if (disposed) return;
      disposed = true;
      expansionGeneration += 1;
      for (const entry of [...entries]) entry.dispose();
      current = null;
      updateContext();
      subscriptions.forEach(subscription => subscription.dispose());
    }
  };
}
