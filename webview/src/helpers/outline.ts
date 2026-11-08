import { createElement, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ArrowLeftToLine, ArrowRightToLine, Pin, PinOff, X, type IconNode } from 'lucide';
import { DEFAULT_OUTLINE_WIDTH, normalizeOutlineWidth } from '../../../src/shared/outlineWidth';
import { outlineHeadingKeys, visibleOutlineHeadingIndexes } from '../../../src/foundation/outline';
import type { HeadingInlineSegment } from './markdownSyntax';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { applyOutlinePalette, type OutlinePaletteInput } from './uiTheme';

export interface OutlineHeading {
  text: string;
  inlineSegments?: HeadingInlineSegment[];
  level: number;
  from: number;
  line: number;
}

interface EditorApi {
  getHeadings(): OutlineHeading[];
  isOutlinePending?(): boolean;
  getViewportAnchorOffset(ratio?: number): number;
  getVisibleDocumentRange(): { from: number; to: number; fromLine: number; toLine: number } | null;
  getScrollElement(): EventTarget;
  scrollToLine(line: number, position: string): void;
  preserveViewport?(mutate: () => void): void;
  preserveViewportLayout?(mutate: () => void): void;
}

type OutlineMode = 'floating' | 'fixed';
type OutlinePosition = 'left' | 'right';

interface OutlineUiState {
  mode: OutlineMode;
  width: number;
}

interface OutlineControllerOptions {
  root: HTMLElement;
  editorWrapper: HTMLElement;
  outlineButton: HTMLElement;
  outlineLeftButton?: HTMLElement;
  additionalOutlineLeftButtons?: HTMLElement[];
  getEditor: () => EditorApi | null;
  getPalette?: (position: OutlinePosition) => OutlinePaletteInput;
  onVisibilityRequest?: (visible: boolean) => void;
  onPositionRequest?: (position: OutlinePosition) => void;
  onUiStateChange?: (state: OutlineUiState) => void;
  onResizeEnd?: () => void;
}

export interface OutlineTreeNode {
  heading: OutlineHeading;
  index: number;
  depth: number;
  key: string;
  parentIndex: number | null;
  children: OutlineTreeNode[];
}

interface OutlineController {
  sidebar: HTMLElement;
  setVisible: (nextVisible: boolean) => void;
  refresh: () => void;
  refreshAppearance: () => void;
  /** Re-measures the current viewport after Preview layout changes, without rebuilding headings. */
  refreshViewport: () => void;
  setPosition: (position: OutlinePosition) => void;
  requestPosition: (position: OutlinePosition) => void;
  getPosition: () => OutlinePosition;
  setMode: (mode: OutlineMode) => void;
  setWidth: (width: number) => void;
  setUiLanguage: (language: UiLanguage) => void;
  isVisible: () => boolean;
}

const ACTIVE_VIEWPORT_RATIO = 0.2;
const OUTLINE_SCROLL_CONTEXT_PX = 100;
const OUTLINE_PENDING_REFRESH_MS = 50;
const OUTLINE_LOADING_DELAY_MS = 200;

function sameOutlinePresentation(before: OutlineHeading[], after: OutlineHeading[]): boolean {
  return before.length === after.length && before.every((heading, index) => {
    const next = after[index];
    if (heading.text !== next.text || heading.level !== next.level) return false;
    const segments = heading.inlineSegments ?? [], nextSegments = next.inlineSegments ?? [];
    return segments.length === nextSegments.length && segments.every((segment, i) => {
      const other = nextSegments[i];
      return segment.text === other.text && segment.strong === other.strong
        && segment.emphasis === other.emphasis && segment.strikethrough === other.strikethrough
        && segment.highlight === other.highlight;
    });
  });
}

export function buildOutlineTree(headings: OutlineHeading[]): {
  roots: OutlineTreeNode[];
  nodeByIndex: Map<number, OutlineTreeNode>;
} {
  const roots: OutlineTreeNode[] = [];
  const stack: OutlineTreeNode[] = [];
  const keys = outlineHeadingKeys(headings);
  const nodeByIndex = new Map<number, OutlineTreeNode>();

  headings.forEach((heading, index) => {
    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
    const parent = stack.at(-1) ?? null;
    const node: OutlineTreeNode = {
      heading,
      index,
      depth: stack.length,
      key: keys[index],
      parentIndex: parent?.index ?? null,
      children: []
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    nodeByIndex.set(index, node);
    stack.push(node);
  });

  return { roots, nodeByIndex };
}

export function findVisibleHeadingIndexes(
  headings: OutlineHeading[],
  visibleRange: { from: number; to: number; fromLine: number; toLine: number } | null
): number[] {
  return visibleOutlineHeadingIndexes(headings, headings.map(heading => heading.line), visibleRange);
}

function iconButton(icon: IconNode, action: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'outline-header-button';
  button.dataset.action = action;
  if (action !== 'close') button.dataset.tooltip = title;
  button.setAttribute('aria-label', title);
  button.appendChild(createElement(icon, { width: 14, height: 14, 'aria-hidden': 'true' }));
  return button;
}

export function createOutlineController({
  root,
  editorWrapper,
  outlineButton,
  outlineLeftButton,
  additionalOutlineLeftButtons = [],
  getEditor,
  getPalette,
  onVisibilityRequest,
  onPositionRequest,
  onUiStateChange,
  onResizeEnd
}: OutlineControllerOptions): OutlineController {
  let uiStrings = getUiStrings('en');
  const outlineSidebar = document.createElement('div');
  outlineSidebar.className = 'outline-sidebar';
  outlineSidebar.setAttribute('role', 'navigation');
  outlineSidebar.setAttribute('aria-label', uiStrings.documentOutline);

  const outlineHeader = document.createElement('div');
  outlineHeader.className = 'outline-header';
  const outlineLabel = document.createElement('span');
  outlineLabel.className = 'outline-header-label';
  outlineLabel.textContent = uiStrings.outline;
  const collapseButton = iconButton(ChevronsDownUp, 'collapse-top2', uiStrings.outlineCollapseTopTwo);
  const expandButton = iconButton(ChevronsUpDown, 'expand-all', uiStrings.outlineExpandAll);
  const modeButton = iconButton(Pin, 'toggle-mode', uiStrings.outlineSwitchFixed);
  const positionButton = iconButton(ArrowLeftToLine, 'toggle-position', uiStrings.outlineSwitchLeft);
  const closeButton = iconButton(X, 'close', uiStrings.outlineClose);
  closeButton.classList.add('outline-close-button');
  outlineHeader.append(outlineLabel, collapseButton, expandButton, positionButton, modeButton, closeButton);

  const outlineContent = document.createElement('div');
  outlineContent.className = 'outline-content';
  const visibleRangeHighlight = document.createElement('div');
  visibleRangeHighlight.className = 'outline-visible-range';
  visibleRangeHighlight.hidden = true;
  const outlineResizer = document.createElement('div');
  outlineResizer.className = 'outline-resizer';
  outlineResizer.setAttribute('role', 'separator');
  outlineResizer.setAttribute('aria-orientation', 'vertical');
  outlineResizer.setAttribute('aria-label', uiStrings.outlineResize);
  outlineSidebar.append(outlineHeader, outlineContent, outlineResizer);

  let visible = false;
  let mode: OutlineMode = 'fixed';
  let position: OutlinePosition = 'right';
  let width = DEFAULT_OUTLINE_WIDTH;
  let currentOutlineHeadings: OutlineHeading[] = [];
  let currentOutlineHeadingIndexByFrom = new Map<number, number>();
  let currentTreeRoots: OutlineTreeNode[] = [];
  let currentNodeByIndex = new Map<number, OutlineTreeNode>();
  let collapsedKeys = new Set<string>();
  let activeHeadingIndex = -1;
  let visibleHeadingIndexes = new Set<number>();
  let boundScrollElement: EventTarget | null = null;
  let scrollFrame = 0;
  let headingRefreshTimer: number | null = null;
  let loadingTimer: number | null = null;
  let loadingVisible = false;
  let hasCompletedOutline = false;
  let headingLines: number[] = [];
  let expandedNodes: OutlineTreeNode[] = [];
  let expandedIndex = new Map<number, number>();
  let expandedKeys = new Map<string, number>();
  let windowed = false, windowSignature = '';
  let rowHeights: number[] = [], rowOffsets: number[] = [];
  let rowMetricsPending = false;
  let windowRows = new Map<string, HTMLLIElement>();
  let windowItems = new Map<number, HTMLElement>();
  let followScheduled = false;
  let pendingTreeProjection: (() => void) | null = null;

  const notifyUiState = () => onUiStateChange?.({ mode, width });
  const mutateLayoutWithViewportPreserved = (mutate: () => void) => {
    const editor = getEditor();
    if (editor?.preserveViewportLayout) editor.preserveViewportLayout(mutate);
    else if (editor?.preserveViewport) editor.preserveViewport(mutate);
    else mutate();
  };
  const applyOutlineWidth = () => {
    outlineSidebar.style.width = `${width}px`;
    editorWrapper.style.setProperty('--meo-outline-width', `${width}px`);
  };
  const refreshAppearance = () => {
    if (visible && getPalette && outlineSidebar.isConnected) applyOutlinePalette(outlineSidebar, getPalette(position));
  };

  const scrollItemsIntoView = (items: HTMLElement[]) => {
    if (items.length === 0) return;
    const bodyRect = outlineContent.getBoundingClientRect();
    const itemRects = items.map((item) => item.getBoundingClientRect());
    const groupTop = Math.min(...itemRects.map((rect) => rect.top));
    const groupBottom = Math.max(...itemRects.map((rect) => rect.bottom));
    const groupHeight = groupBottom - groupTop;
    const minimumContext = 8;
    if (groupHeight > bodyRect.height - minimumContext * 2) {
      const delta = groupTop - (bodyRect.top + minimumContext);
      if (Math.abs(delta) >= 2) outlineContent.scrollTop += Math.round(delta);
      return;
    }
    const context = groupHeight + OUTLINE_SCROLL_CONTEXT_PX * 2 <= bodyRect.height
      ? OUTLINE_SCROLL_CONTEXT_PX
      : minimumContext;
    const targetTop = bodyRect.top + context;
    const targetBottom = bodyRect.bottom - context;
    if (groupTop < targetTop) {
      const delta = groupTop - targetTop;
      if (Math.abs(delta) >= 2) outlineContent.scrollTop += Math.round(delta);
    } else if (groupBottom > targetBottom) {
      const delta = groupBottom - targetBottom;
      if (Math.abs(delta) >= 2) outlineContent.scrollTop += Math.round(delta);
    }
  };

  const findVisibleItem = (index: number): HTMLElement | null => {
    let node = currentNodeByIndex.get(index) ?? null;
    while (node) {
      const item = windowed ? windowItems.get(node.index)
        : outlineContent.querySelector<HTMLElement>(`.outline-item[data-heading-from="${node.heading.from}"]`);
      if (item) return item;
      node = node.parentIndex === null ? null : currentNodeByIndex.get(node.parentIndex) ?? null;
    }
    return null;
  };

  const highlightVisibleHeadings = (followContent = true) => {
    if (windowed && rowOffsets.length) {
      if (followContent) {
        const indexes = [...visibleHeadingIndexes].map(expandedHeadingIndex).filter((index): index is number => index !== undefined);
        if (!indexes.length) {
          const index = expandedHeadingIndex(activeHeadingIndex);
          if (index !== undefined) indexes.push(index);
        }
        revealWindowRows(indexes);
      }
      renderWindow();
    }
    for (const item of outlineContent.querySelectorAll('.outline-item.is-visible, .outline-item.is-visible-first')) {
      item.classList.remove('is-visible', 'is-visible-first');
    }
    const visibleItems: HTMLElement[] = [];
    for (const index of visibleHeadingIndexes) {
      const item = findVisibleItem(index);
      if (!item) continue;
      item.classList.add('is-visible');
      if (!visibleItems.includes(item)) visibleItems.push(item);
    }
    if (visibleItems.length === 0) {
      const fallbackItem = findVisibleItem(activeHeadingIndex);
      if (fallbackItem) {
        fallbackItem.classList.add('is-visible');
        visibleItems.push(fallbackItem);
      }
    }
    visibleItems[0]?.classList.add('is-visible-first');
    const visibleRows = visibleItems
      .map((item) => item.closest<HTMLElement>('.outline-row'))
      .filter((row): row is HTMLElement => row !== null);
    if (visibleRows.length === 0) {
      visibleRangeHighlight.hidden = true;
    } else {
      const contentRect = outlineContent.getBoundingClientRect();
      const rowRects = visibleRows.map((row) => row.getBoundingClientRect());
      const top = Math.min(...rowRects.map((rect) => rect.top)) - contentRect.top + outlineContent.scrollTop;
      const bottom = Math.max(...rowRects.map((rect) => rect.bottom)) - contentRect.top + outlineContent.scrollTop;
      visibleRangeHighlight.style.top = `${Math.round(top)}px`;
      visibleRangeHighlight.style.height = `${Math.ceil(bottom - top)}px`;
      visibleRangeHighlight.hidden = false;
    }
    if (followContent) scrollItemsIntoView(visibleItems);
  };

  const updateActiveHeadings = () => {
    if (currentOutlineHeadings.length === 0) return false;
    const editor = getEditor();
    if (!editor) return false;
    const visibleRange = editor.getVisibleDocumentRange();
    visibleHeadingIndexes = new Set(visibleOutlineHeadingIndexes(currentOutlineHeadings, headingLines, visibleRange));
    if (!visibleRange) {
      activeHeadingIndex = -1;
      return true;
    }
    const anchor = editor.getViewportAnchorOffset(ACTIVE_VIEWPORT_RATIO);
    let from = 0, to = currentOutlineHeadings.length;
    while (from < to) {
      const middle = (from + to) >>> 1;
      if (currentOutlineHeadings[middle].from <= anchor) from = middle + 1;
      else to = middle;
    }
    activeHeadingIndex = from - 1;
    return true;
  };

  const refreshActive = () => {
    if (!visible || !updateActiveHeadings()) return;
    highlightVisibleHeadings();
  };

  const bindScroll = () => {
    const nextScrollElement = getEditor()?.getScrollElement() ?? null;
    if (nextScrollElement === boundScrollElement) return;
    boundScrollElement?.removeEventListener('scroll', scheduleActiveRefresh);
    boundScrollElement = nextScrollElement;
    boundScrollElement?.addEventListener('scroll', scheduleActiveRefresh, { passive: true });
  };

  function scheduleActiveRefresh() {
    followScheduled = true;
    scheduleOutlineFrame();
  }
  function scheduleOutlineFrame() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      const follow = followScheduled;
      followScheduled = false;
      if (!visible) return;
      const project = pendingTreeProjection;
      pendingTreeProjection = null;
      if (project) { project(); return; }
      if (follow) refreshActive();
      else if (windowed) highlightVisibleHeadings(false);
    });
  }
  outlineContent.addEventListener('scroll', scheduleOutlineFrame, { passive: true });
  outlineContent.addEventListener('wheel', () => {
    // A newer gesture in this pane supersedes a queued body-follow frame.
    followScheduled = false;
    scheduleOutlineFrame();
  }, { passive: true });
  window.addEventListener('resize', scheduleOutlineFrame);

  const appendHeadingContent = (item: HTMLElement, heading: OutlineHeading) => {
    if (!heading.inlineSegments?.length) {
      item.textContent = heading.text || uiStrings.outlineEmptyHeading;
      return;
    }
    for (const segment of heading.inlineSegments) {
      let content: Node = document.createTextNode(segment.text);
      if (segment.strikethrough) {
        const del = document.createElement('del');
        del.appendChild(content);
        content = del;
      }
      if (segment.emphasis) {
        const em = document.createElement('em');
        em.appendChild(content);
        content = em;
      }
      if (segment.strong) {
        const strong = document.createElement('strong');
        strong.appendChild(content);
        content = strong;
      }
      if (segment.highlight) {
        const mark = document.createElement('mark');
        mark.appendChild(content);
        content = mark;
      }
      item.appendChild(content);
    }
  };

  const renderNode = (node: OutlineTreeNode, descendants = true): HTMLLIElement => {
    const itemNode = document.createElement('li');
    itemNode.className = 'outline-node';
    const row = document.createElement('div');
    row.className = 'outline-row';

    const foldButton = document.createElement('button');
    foldButton.type = 'button';
    foldButton.className = 'outline-fold-button';
    if (node.children.length > 0) {
      const collapsed = collapsedKeys.has(node.key);
      foldButton.dataset.outlineKey = node.key;
      foldButton.dataset.tooltip = collapsed ? uiStrings.outlineExpand : uiStrings.outlineCollapse;
      foldButton.setAttribute('aria-label', foldButton.dataset.tooltip ?? '');
      foldButton.appendChild(createElement(collapsed ? ChevronRight : ChevronDown, { width: 14, height: 14 }));
    } else {
      foldButton.disabled = true;
      foldButton.tabIndex = -1;
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `outline-item outline-level-${node.heading.level}`;
    appendHeadingContent(item, node.heading);
    item.dataset.tooltip = node.heading.text;
    item.dataset.tooltipKind = 'fulltext';
    item.dataset.headingFrom = String(node.heading.from);
    item.dataset.outlineKey = node.key;
    row.append(foldButton, item);
    itemNode.appendChild(row);

    if (descendants && node.children.length > 0 && !collapsedKeys.has(node.key)) {
      const children = document.createElement('ul');
      children.className = 'outline-tree outline-tree-children';
      for (const child of node.children) children.appendChild(renderNode(child));
      itemNode.appendChild(children);
    }
    return itemNode;
  };

  const expandedHeadingIndex = (index: number): number | undefined => {
    let node = currentNodeByIndex.get(index);
    while (node) {
      const position = expandedIndex.get(node.index);
      if (position !== undefined) return position;
      node = node.parentIndex === null ? undefined : currentNodeByIndex.get(node.parentIndex);
    }
  };
  const revealWindowRows = (indexes: number[]) => {
    if (!indexes.length) return;
    const top = 4 + rowOffsets[Math.min(...indexes)];
    const bottom = 4 + rowOffsets[Math.max(...indexes) + 1];
    const height = outlineContent.clientHeight, group = bottom - top;
    const context = group + OUTLINE_SCROLL_CONTEXT_PX * 2 <= height ? OUTLINE_SCROLL_CONTEXT_PX : 8;
    const current = outlineContent.scrollTop;
    if (group > height - 16 || top < current + context) outlineContent.scrollTop = Math.max(0, top - context);
    else if (bottom > current + height - context) outlineContent.scrollTop = bottom - height + context;
  };

  /** The complete tree owns navigation and folding. Only its expanded reading
   * window owns DOM, plus a focused row retained across native outline scrolling. */
  const renderWindow = () => {
    if (!windowed || !rowOffsets.length) return;
    const active = document.activeElement instanceof HTMLButtonElement && outlineContent.contains(document.activeElement)
      ? document.activeElement : null;
    const activeItem = active?.closest('.outline-row')?.querySelector<HTMLElement>('.outline-item');
    const focusKey = activeItem?.dataset.outlineKey;
    const focused = focusKey ? expandedKeys.get(focusKey) : undefined;
    const count = Math.max(24, Math.ceil(outlineContent.clientHeight / Math.min(...rowHeights)) + 16);
    let low = 0, high = expandedNodes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rowOffsets[middle + 1] <= outlineContent.scrollTop - 4) low = middle + 1;
      else high = middle;
    }
    const start = Math.min(Math.max(0, expandedNodes.length - count), Math.max(0, low - 8));
    const end = Math.min(expandedNodes.length, start + count);
    const pinned = focused !== undefined && (focused < start || focused >= end) ? focused : -1;
    const signature = `${start}:${end}:${pinned}`;
    if (signature === windowSignature) return;
    windowSignature = signature;
    const previousScroll = outlineContent.scrollTop;
    const positions = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
    if (pinned >= 0) { positions.push(pinned); positions.sort((a,b) => a-b); }
    const tree = document.createElement('ul'); tree.className = 'outline-tree';
    const nextRows = new Map<string, HTMLLIElement>();
    windowItems = new Map();
    let cursor = 0, parents = new Map<number, HTMLLIElement>();
    const gap = (count: number) => {
      if (!count) return;
      const space = document.createElement('li'); space.setAttribute('aria-hidden', 'true');
      space.style.height = `${rowOffsets[cursor + count] - rowOffsets[cursor]}px`; tree.append(space);
    };
    const append = (node: OutlineTreeNode, projected: boolean): HTMLLIElement => {
      const existing = parents.get(node.index);
      if (existing) return existing;
      const row = projected ? windowRows.get(node.key) ?? renderNode(node, false) : document.createElement('li');
      if (projected) {
        row.querySelector(':scope > ul')?.remove();
        const siblings = node.parentIndex === null ? currentTreeRoots : currentNodeByIndex.get(node.parentIndex)!.children;
        row.setAttribute('aria-posinset', String(siblings.indexOf(node) + 1));
        row.setAttribute('aria-setsize', String(siblings.length));
        nextRows.set(node.key, row);
        windowItems.set(node.index, row.querySelector<HTMLElement>('.outline-item')!);
      } else { row.className = 'outline-node outline-window-parent'; row.setAttribute('role', 'presentation'); }
      parents.set(node.index, row);
      if (node.parentIndex === null) tree.append(row);
      else {
        const parent = append(currentNodeByIndex.get(node.parentIndex)!, false);
        let children = parent.querySelector<HTMLUListElement>(':scope > ul');
        if (!children) {
          children = document.createElement('ul'); children.className = 'outline-tree outline-tree-children'; parent.append(children);
        }
        children.append(row);
      }
      return row;
    };
    for (const position of positions) {
      if (position !== cursor) { gap(position - cursor); parents = new Map(); }
      append(expandedNodes[position], true); cursor = position + 1;
    }
    gap(expandedNodes.length - cursor);
    windowRows = nextRows;
    outlineContent.replaceChildren(visibleRangeHighlight, tree);
    outlineContent.scrollTop = previousScroll;
    if (active && focusKey) {
      const row = windowRows.get(focusKey);
      row?.querySelector<HTMLButtonElement>(active.classList.contains('outline-fold-button') ? '.outline-fold-button' : '.outline-item')?.focus({ preventScroll: true });
    }
  };

  const renderTree = ({ followContent = true, preserveScroll = false } = {}) => {
    const previousScrollTop = preserveScroll ? outlineContent.scrollTop : null;
    expandedNodes = []; expandedIndex = new Map(); expandedKeys = new Map();
    const visit = (nodes: OutlineTreeNode[]) => { for (const node of nodes) {
      expandedIndex.set(node.index, expandedNodes.length); expandedKeys.set(node.key, expandedNodes.length); expandedNodes.push(node);
      if (!collapsedKeys.has(node.key)) visit(node.children);
    } };
    visit(currentTreeRoots);
    windowed = expandedNodes.length > 160;
    windowSignature = ''; windowRows = new Map(); windowItems = new Map();
    if (windowed) {
      // Levels have distinct type sizes. Measure one bounded style batch and
      // index exact row offsets instead of accumulating a uniform-height error.
      const samples = document.createElement('ul'); samples.className = 'outline-tree';
      samples.setAttribute('aria-hidden', 'true');
      samples.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none';
      for (let level = 1; level <= 6; level++) {
        const sample = document.createElement('li'); sample.className = 'outline-node';
        const item = document.createElement('button'); item.className = `outline-item outline-level-${level}`;
        item.textContent = 'M'; sample.append(item); samples.append(sample);
      }
      outlineContent.append(samples);
      const measuredHeights = [...samples.children].map(sample => sample.getBoundingClientRect().height);
      rowMetricsPending = measuredHeights.some(height => height === 0);
      if (!rowMetricsPending) rowHeights = measuredHeights;
      samples.remove();
      if (!rowHeights.length) return;
      rowOffsets = [0];
      for (const node of expandedNodes) rowOffsets.push(rowOffsets.at(-1)! + rowHeights[Math.max(0, Math.min(5, node.heading.level - 1))]);
      renderWindow(); highlightVisibleHeadings(followContent);
      if (previousScrollTop !== null) { outlineContent.scrollTop = previousScrollTop; renderWindow(); }
      return;
    }
    outlineContent.replaceChildren(visibleRangeHighlight);
    if (currentTreeRoots.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'outline-empty';
      emptyMsg.setAttribute('role', 'status');
      emptyMsg.textContent = hasCompletedOutline ? uiStrings.outlineNoHeadings
        : loadingVisible ? uiStrings.outlineLoading : '';
      outlineContent.appendChild(emptyMsg);
      return;
    }
    const tree = document.createElement('ul');
    tree.className = 'outline-tree';
    for (const rootNode of currentTreeRoots) tree.appendChild(renderNode(rootNode));
    outlineContent.appendChild(tree);
    highlightVisibleHeadings(followContent);
    if (previousScrollTop !== null) outlineContent.scrollTop = previousScrollTop;
  };

  const cancelHeadingRefresh = () => {
    if (headingRefreshTimer !== null) window.clearTimeout(headingRefreshTimer);
    headingRefreshTimer = null;
  };
  const cancelLoading = () => {
    if (loadingTimer !== null) window.clearTimeout(loadingTimer);
    loadingTimer = null;
    loadingVisible = false;
  };
  const updateLoading = (pending: boolean) => {
    if (!visible || !pending || hasCompletedOutline) {
      cancelLoading();
      return;
    }
    if (loadingTimer !== null || loadingVisible) return;
    loadingTimer = window.setTimeout(() => {
      loadingTimer = null;
      if (!visible || !outlineSidebar.isConnected || hasCompletedOutline) return;
      loadingVisible = true;
      // The result may have completed since the last bounded poll. Read once
      // at the deadline before painting a status that is already obsolete.
      refresh();
      if (loadingVisible && !hasCompletedOutline) renderTree();
    }, OUTLINE_LOADING_DELAY_MS);
  };
  const refresh = () => {
    cancelHeadingRefresh();
    refreshAppearance();
    const editor = getEditor();
    const headings = editor?.getHeadings() ?? currentOutlineHeadings;
    const pending = !editor || editor.isOutlinePending?.() === true;
    const busy = String(pending);
    const wasPending = outlineContent.getAttribute('aria-busy') === 'true';
    if (outlineContent.getAttribute('aria-busy') !== busy) outlineContent.setAttribute('aria-busy', busy);
    updateLoading(pending);
    // A partial CodeMirror tree is not a complete document outline. Advance it
    // in bounded tasks, retaining identical rows until more metadata is ready.
    const metadataChanged = headings !== currentOutlineHeadings && (!pending || headings.length > 0);
    const publish = () => {
      if (!pending) hasCompletedOutline = true;
      if (!(metadataChanged || !pending && wasPending)) return;
      const reuseRows = headings.length > 0 && sameOutlinePresentation(currentOutlineHeadings, headings);
      currentOutlineHeadings = headings;
      headingLines = headings.map(heading => heading.line);
      currentOutlineHeadingIndexByFrom = new Map(currentOutlineHeadings.map((heading, index) => [heading.from, index]));
      if (reuseRows) {
        const positions = new Map<string, number>();
        for (const node of currentNodeByIndex.values()) {
          node.heading = headings[node.index];
          positions.set(node.key, node.heading.from);
        }
        for (const item of outlineContent.querySelectorAll<HTMLElement>('.outline-item')) {
          const from = positions.get(item.dataset.outlineKey ?? '');
          if (from !== undefined && item.dataset.headingFrom !== String(from)) item.dataset.headingFrom = String(from);
        }
      } else {
        const tree = buildOutlineTree(currentOutlineHeadings);
        currentTreeRoots = tree.roots;
        currentNodeByIndex = tree.nodeByIndex;
        const validKeys = new Set(Array.from(currentNodeByIndex.values(), (node) => node.key));
        collapsedKeys = new Set([...collapsedKeys].filter((key) => validKeys.has(key)));
      }
      bindScroll();
      updateActiveHeadings();
      if (reuseRows) highlightVisibleHeadings();
      else renderTree();
    };
    // Complete metadata discovery can itself consume a frame in a huge file.
    // Keep accepted rows until the existing outline frame admits their DOM
    // projection; never combine the full read and its layout into one task.
    if (visible && headings.length > 160 && (metadataChanged || !pending && wasPending)) {
      outlineContent.setAttribute('aria-busy', 'true');
      pendingTreeProjection = () => {
        outlineContent.setAttribute('aria-busy', busy);
        publish();
      };
      scheduleOutlineFrame();
    } else {
      pendingTreeProjection = null;
      publish();
    }
    if (visible && pending) headingRefreshTimer = window.setTimeout(() => {
      headingRefreshTimer = null;
      if (visible && outlineSidebar.isConnected) refresh();
    }, OUTLINE_PENDING_REFRESH_MS);
  };

  const updateModeButton = () => {
    modeButton.dataset.tooltipLiveUpdate = 'true';
    modeButton.replaceChildren(createElement(mode === 'floating' ? Pin : PinOff, { width: 14, height: 14 }));
    modeButton.dataset.tooltip = mode === 'floating' ? uiStrings.outlineSwitchFixed : uiStrings.outlineSwitchFloating;
    modeButton.setAttribute('aria-label', modeButton.dataset.tooltip ?? '');
  };

  const updatePositionButton = () => {
    positionButton.dataset.tooltipLiveUpdate = 'true';
    const nextPosition = position === 'left' ? 'right' : 'left';
    positionButton.replaceChildren(createElement(nextPosition === 'left' ? ArrowLeftToLine : ArrowRightToLine, { width: 14, height: 14 }));
    positionButton.dataset.tooltip = nextPosition === 'left' ? uiStrings.outlineSwitchLeft : uiStrings.outlineSwitchRight;
    positionButton.setAttribute('aria-label', positionButton.dataset.tooltip ?? '');
  };

  const updateOutlineUI = () => {
    const updateToolbarButton = (button: HTMLElement, active: boolean) => {
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    };
    updateToolbarButton(outlineButton, visible && position === 'right');
    for (const button of [outlineLeftButton, ...additionalOutlineLeftButtons]) {
      if (button) updateToolbarButton(button, visible && position === 'left');
    }
    root.classList.toggle('outline-visible', visible);
    editorWrapper.dataset.outlineMode = mode;
    editorWrapper.dataset.outlinePosition = position;
    applyOutlineWidth();
    updatePositionButton();
    updateModeButton();
    refreshAppearance();
  };

  const setVisible = (nextVisible: boolean) => {
    if (!nextVisible) {
      pendingTreeProjection = null;
      cancelHeadingRefresh();
      cancelLoading();
      if (!hasCompletedOutline) renderTree();
    }
    const changed = visible !== (nextVisible === true);
    const update = () => {
      visible = nextVisible === true;
      updateOutlineUI();
    };
    if (changed && mode === 'fixed') mutateLayoutWithViewportPreserved(update);
    else update();
    if (visible && changed) {
      refresh();
      if (rowMetricsPending) renderTree({ preserveScroll: true });
    }
  };

  const requestVisible = (nextVisible: boolean) => {
    if (visible === nextVisible) return;
    setVisible(nextVisible);
    onVisibilityRequest?.(nextVisible);
  };

  const setMode = (nextMode: OutlineMode) => {
    const normalizedMode = nextMode === 'floating' ? 'floating' : 'fixed';
    if (mode === normalizedMode) return;
    const update = () => {
      mode = normalizedMode;
      updateOutlineUI();
    };
    if (visible && (mode === 'fixed' || normalizedMode === 'fixed')) {
      mutateLayoutWithViewportPreserved(update);
    } else {
      update();
    }
    notifyUiState();
  };

  const setWidth = (nextWidth: number) => {
    const normalizedWidth = normalizeOutlineWidth(nextWidth);
    if (width === normalizedWidth) return;
    const update = () => {
      width = normalizedWidth;
      applyOutlineWidth();
    };
    if (visible && mode === 'fixed') mutateLayoutWithViewportPreserved(update);
    else update();
    notifyUiState();
  };

  const setPosition = (nextPosition: OutlinePosition) => {
    position = nextPosition === 'left' ? 'left' : 'right';
    updateOutlineUI();
  };

  const requestPosition = (nextPosition: OutlinePosition) => {
    setPosition(nextPosition);
    onPositionRequest?.(position);
  };

  outlineHeader.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    const action = target?.dataset.action;
    if (action === 'close') requestVisible(false);
    else if (action === 'expand-all') {
      collapsedKeys.clear();
      renderTree({ followContent: false, preserveScroll: true });
    } else if (action === 'collapse-top2') {
      collapsedKeys = new Set(
        [...currentNodeByIndex.values()]
          .filter((node) => node.children.length > 0)
          .map((node) => node.key)
      );
      renderTree({ followContent: false, preserveScroll: true });
    } else if (action === 'toggle-position') requestPosition(position === 'left' ? 'right' : 'left');
    else if (action === 'toggle-mode') setMode(mode === 'floating' ? 'fixed' : 'floating');
  });

  outlineContent.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const foldButton = target?.closest<HTMLElement>('.outline-fold-button[data-outline-key]');
    if (foldButton) {
      const key = foldButton.dataset.outlineKey;
      if (key) {
        if (collapsedKeys.has(key)) collapsedKeys.delete(key);
        else collapsedKeys.add(key);
        renderTree({ followContent: false, preserveScroll: true });
      }
      return;
    }
    const item = target?.closest<HTMLElement>('.outline-item');
    if (!item || !outlineContent.contains(item)) return;
    const headingFrom = Number.parseInt(item.dataset.headingFrom ?? '', 10);
    const headingIndex = currentOutlineHeadingIndexByFrom.get(headingFrom);
    const cachedHeading = typeof headingIndex === 'number' ? currentOutlineHeadings[headingIndex] : null;
    const latestHeadings = getEditor()?.getHeadings() ?? [];
    const latestTree = buildOutlineTree(latestHeadings);
    const outlineKey = item.dataset.outlineKey;
    const keyedHeading = outlineKey
      ? Array.from(latestTree.nodeByIndex.values()).find((node) => node.key === outlineKey)?.heading
      : null;
    const sameHeadingCandidates = cachedHeading
      ? latestHeadings.filter((heading) => heading.level === cachedHeading.level && heading.text === cachedHeading.text)
      : [];
    const heading = keyedHeading ?? (
      sameHeadingCandidates.length === 1
        ? sameHeadingCandidates[0]
        : cachedHeading
    );
    if (heading) getEditor()?.scrollToLine(heading.line, 'top');
    if (mode === 'floating') requestVisible(false);
  });

  // Native Tab order must still cross unmounted rows. A focused row is pinned
  // while the user scrolls this pane, so wheel input never silently loses focus.
  outlineContent.addEventListener('keydown', event => {
    if (!windowed || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLButtonElement ? event.target : null;
    const item = target?.closest('.outline-row')?.querySelector<HTMLElement>('.outline-item');
    const key = item?.dataset.outlineKey, index = key ? expandedKeys.get(key) : undefined;
    if (!target || index === undefined) return;
    followScheduled = false;
    const fold = target.classList.contains('outline-fold-button');
    let next = index, selector = '.outline-item';
    if (event.shiftKey && !fold && expandedNodes[index].children.length) selector = '.outline-fold-button';
    else if (!event.shiftKey && fold) selector = '.outline-item';
    else {
      next += event.shiftKey ? -1 : 1;
      if (next < 0 || next >= expandedNodes.length) return;
      if (!event.shiftKey && expandedNodes[next].children.length) selector = '.outline-fold-button';
    }
    event.preventDefault();
    revealWindowRows([next]); renderWindow();
    windowRows.get(expandedNodes[next].key)?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    scheduleOutlineFrame();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!visible || mode !== 'floating') return;
    const target = event.target instanceof Node ? event.target : null;
    if (
      !target ||
      outlineSidebar.contains(target) ||
      outlineButton.contains(target) ||
      outlineLeftButton?.contains(target) ||
      additionalOutlineLeftButtons.some((button) => button.contains(target))
    ) return;
    requestVisible(false);
  }, true);

  window.addEventListener('blur', () => {
    if (!visible || mode !== 'floating') return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLIFrameElement) || !root.contains(activeElement)) return;
    requestVisible(false);
  }, true);

  outlineResizer.addEventListener('pointerdown', (event) => {
    const startX = event.clientX;
    const startWidth = width;
    const pointerId = event.pointerId;
    document.body.classList.add('outline-resizing');
    outlineResizer.setPointerCapture(pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const direction = position === 'left' ? 1 : -1;
      const nextWidth = normalizeOutlineWidth(startWidth + (moveEvent.clientX - startX) * direction);
      if (nextWidth === width) return;
      width = nextWidth;
      applyOutlineWidth();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (outlineResizer.hasPointerCapture(pointerId)) {
        outlineResizer.releasePointerCapture(pointerId);
      }
      document.body.classList.remove('outline-resizing');
      onResizeEnd?.();
      notifyUiState();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.preventDefault();
  });

  outlineResizer.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  updateOutlineUI();

  return {
    sidebar: outlineSidebar,
    setVisible,
    refresh,
    refreshAppearance,
    refreshViewport: scheduleActiveRefresh,
    setPosition,
    requestPosition,
    getPosition: () => position,
    setMode,
    setWidth,
    setUiLanguage: (language) => {
      uiStrings = getUiStrings(language);
      outlineSidebar.setAttribute('aria-label', uiStrings.documentOutline);
      outlineLabel.textContent = uiStrings.outline;
      collapseButton.dataset.tooltip = uiStrings.outlineCollapseTopTwo;
      collapseButton.setAttribute('aria-label', collapseButton.dataset.tooltip ?? '');
      expandButton.dataset.tooltip = uiStrings.outlineExpandAll;
      expandButton.setAttribute('aria-label', expandButton.dataset.tooltip ?? '');
      closeButton.setAttribute('aria-label', uiStrings.outlineClose);
      outlineResizer.setAttribute('aria-label', uiStrings.outlineResize);
      updateModeButton();
      updatePositionButton();
      renderTree();
    },
    isVisible: () => visible
  };
}
