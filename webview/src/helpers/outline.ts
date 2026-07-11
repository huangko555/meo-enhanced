import { createElement, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, PanelLeft, PanelRight, Pin, PinOff, X } from 'lucide';
import type { HeadingInlineSegment } from './markdownSyntax';

export interface OutlineHeading {
  text: string;
  inlineSegments?: HeadingInlineSegment[];
  level: number;
  from: number;
  line: number;
}

interface EditorApi {
  getHeadings(): OutlineHeading[];
  getViewportAnchorOffset(ratio?: number): number;
  getVisibleDocumentRange(): { from: number; to: number; fromLine: number; toLine: number };
  getScrollElement(): HTMLElement;
  scrollToLine(line: number, position: string): void;
  moveHeadingSection(sourceFrom: number, targetFrom: number, placement: 'before' | 'after'): boolean;
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
  getEditor: () => EditorApi | null;
  onVisibilityRequest?: (visible: boolean) => void;
  onPositionRequest?: (position: OutlinePosition) => void;
  onUiStateChange?: (state: OutlineUiState) => void;
}

export interface OutlineTreeNode {
  heading: OutlineHeading;
  index: number;
  depth: number;
  key: string;
  parentIndex: number | null;
  children: OutlineTreeNode[];
}

interface OutlineDragState {
  sourceFrom: number;
  draggedElement: Element;
  dropTargetFrom: number | null;
  dropPlacement: 'before' | 'after' | null;
}

interface DropCandidate {
  targetFrom: number;
  placement: 'before' | 'after';
  targetItem: Element;
}

interface OutlineController {
  sidebar: HTMLElement;
  setVisible: (nextVisible: boolean) => void;
  refresh: () => void;
  setPosition: (position: OutlinePosition) => void;
  setMode: (mode: OutlineMode) => void;
  setWidth: (width: number) => void;
  isVisible: () => boolean;
}

const MIN_OUTLINE_WIDTH = 180;
const MAX_OUTLINE_WIDTH = 480;
const DEFAULT_OUTLINE_WIDTH = 260;
const ACTIVE_VIEWPORT_RATIO = 0.2;
const OUTLINE_SCROLL_CONTEXT_PX = 100;
const OUTLINE_DROP_CLICK_GRACE_PERIOD_MS = 250;

export function buildOutlineTree(headings: OutlineHeading[]): {
  roots: OutlineTreeNode[];
  nodeByIndex: Map<number, OutlineTreeNode>;
} {
  const roots: OutlineTreeNode[] = [];
  const stack: OutlineTreeNode[] = [];
  const siblingCounts = new Map<string, number>();
  const nodeByIndex = new Map<number, OutlineTreeNode>();

  headings.forEach((heading, index) => {
    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
    const parent = stack.at(-1) ?? null;
    const parentKey = parent?.key ?? 'root';
    const baseKey = `${parentKey}/h${heading.level}:${heading.text.trim().toLowerCase()}`;
    const occurrence = siblingCounts.get(baseKey) ?? 0;
    siblingCounts.set(baseKey, occurrence + 1);
    const node: OutlineTreeNode = {
      heading,
      index,
      depth: stack.length,
      key: `${baseKey}:${occurrence}`,
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
  visibleRange: { from: number; to: number; fromLine: number; toLine: number }
): number[] {
  return headings.flatMap((heading, index) => {
    const nextHeadingLine = headings[index + 1]?.line ?? Number.POSITIVE_INFINITY;
    const sectionLastLine = nextHeadingLine - 1;
    const visibleLines = Math.max(
      0,
      Math.min(sectionLastLine, visibleRange.toLine) - Math.max(heading.line, visibleRange.fromLine) + 1
    );
    const headingLineVisible = heading.line >= visibleRange.fromLine && heading.line <= visibleRange.toLine;
    return headingLineVisible || visibleLines >= 4 ? [index] : [];
  });
}

function iconButton(icon, action: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'outline-header-button';
  button.dataset.action = action;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.appendChild(createElement(icon, { width: 14, height: 14, 'aria-hidden': 'true' }));
  return button;
}

function clampOutlineWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_OUTLINE_WIDTH;
  return Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Math.round(width)));
}

export function createOutlineController({
  root,
  editorWrapper,
  outlineButton,
  getEditor,
  onVisibilityRequest,
  onPositionRequest,
  onUiStateChange
}: OutlineControllerOptions): OutlineController {
  const outlineSidebar = document.createElement('div');
  outlineSidebar.className = 'outline-sidebar';
  outlineSidebar.setAttribute('role', 'navigation');
  outlineSidebar.setAttribute('aria-label', 'Document outline');

  const outlineHeader = document.createElement('div');
  outlineHeader.className = 'outline-header';
  const outlineLabel = document.createElement('span');
  outlineLabel.className = 'outline-header-label';
  outlineLabel.textContent = '目录';
  const collapseButton = iconButton(ChevronsUp, 'collapse-top2', '只展开前两层');
  const expandButton = iconButton(ChevronsDown, 'expand-all', '展开全部');
  const modeButton = iconButton(Pin, 'toggle-mode', '切换到固定目录');
  const positionButton = iconButton(PanelLeft, 'toggle-position', '切换到左侧');
  const closeButton = iconButton(X, 'close', '关闭目录');
  closeButton.classList.add('outline-close-button');
  outlineHeader.append(outlineLabel, collapseButton, expandButton, modeButton, positionButton, closeButton);

  const outlineContent = document.createElement('div');
  outlineContent.className = 'outline-content';
  const outlineResizer = document.createElement('div');
  outlineResizer.className = 'outline-resizer';
  outlineResizer.title = '拖动调整目录宽度';
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
  let outlineDragState: OutlineDragState | null = null;
  let suppressOutlineClickUntil = 0;
  let boundScrollElement: HTMLElement | null = null;
  let scrollFrame = 0;

  const notifyUiState = () => onUiStateChange?.({ mode, width });
  const applyOutlineWidth = () => {
    outlineSidebar.style.width = `${width}px`;
  };

  const buildOutlineSubtreeEndIndexes = (headings: OutlineHeading[]): number[] => {
    const subtreeEnds = new Array(headings.length);
    for (let index = 0; index < headings.length; index += 1) {
      let endIndex = headings.length - 1;
      for (let next = index + 1; next < headings.length; next += 1) {
        if (headings[next].level <= headings[index].level) {
          endIndex = next - 1;
          break;
        }
      }
      subtreeEnds[index] = endIndex;
    }
    return subtreeEnds;
  };

  const clearOutlineDropIndicators = () => {
    for (const indicator of outlineContent.querySelectorAll('.outline-drop-before, .outline-drop-after')) {
      indicator.classList.remove('outline-drop-before', 'outline-drop-after');
    }
  };

  const clearOutlineDragState = () => {
    clearOutlineDropIndicators();
    outlineContent.classList.remove('is-dragging-outline');
    if (outlineDragState?.draggedElement instanceof Element) {
      outlineDragState.draggedElement.classList.remove('is-dragging');
      outlineDragState.draggedElement.removeAttribute('aria-grabbed');
    }
    outlineDragState = null;
  };

  const getOutlineDropCandidate = (targetItem: Element, clientY: number): DropCandidate | null => {
    if (!outlineDragState) return null;
    const targetFrom = Number.parseInt((targetItem as HTMLElement).dataset.headingFrom ?? '', 10);
    if (!Number.isFinite(targetFrom)) return null;
    const sourceIndex = currentOutlineHeadingIndexByFrom.get(outlineDragState.sourceFrom);
    const targetIndex = currentOutlineHeadingIndexByFrom.get(targetFrom);
    if (typeof sourceIndex !== 'number' || typeof targetIndex !== 'number') return null;

    const subtreeEnds = buildOutlineSubtreeEndIndexes(currentOutlineHeadings);
    const sourceSubtreeEndIndex = subtreeEnds[sourceIndex];
    const targetSubtreeEndIndex = subtreeEnds[targetIndex];
    const rect = targetItem.getBoundingClientRect();
    const placement = clientY <= rect.top + rect.height / 2 ? 'before' : 'after';
    if (targetIndex >= sourceIndex && targetIndex <= sourceSubtreeEndIndex) return null;

    const insertionSlot = placement === 'before' ? targetIndex : targetSubtreeEndIndex + 1;
    const sourceBlockLength = sourceSubtreeEndIndex - sourceIndex + 1;
    const adjustedSlot = insertionSlot > sourceSubtreeEndIndex ? insertionSlot - sourceBlockLength : insertionSlot;
    if (adjustedSlot === sourceIndex) return null;
    return { targetFrom, placement, targetItem };
  };

  const applyOutlineDropIndicator = (candidate: DropCandidate | null) => {
    if (!outlineDragState || !candidate) {
      clearOutlineDropIndicators();
      if (outlineDragState) {
        outlineDragState.dropTargetFrom = null;
        outlineDragState.dropPlacement = null;
      }
      return;
    }
    if (
      outlineDragState.dropTargetFrom === candidate.targetFrom &&
      outlineDragState.dropPlacement === candidate.placement
    ) return;
    clearOutlineDropIndicators();
    candidate.targetItem.classList.add(candidate.placement === 'before' ? 'outline-drop-before' : 'outline-drop-after');
    outlineDragState.dropTargetFrom = candidate.targetFrom;
    outlineDragState.dropPlacement = candidate.placement;
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
      const item = outlineContent.querySelector<HTMLElement>(`.outline-item[data-heading-from="${node.heading.from}"]`);
      if (item) return item;
      node = node.parentIndex === null ? null : currentNodeByIndex.get(node.parentIndex) ?? null;
    }
    return null;
  };

  const highlightVisibleHeadings = () => {
    for (const item of outlineContent.querySelectorAll('.outline-item.is-visible')) item.classList.remove('is-visible');
    const visibleItems: HTMLElement[] = [];
    for (const index of visibleHeadingIndexes) {
      const item = findVisibleItem(index);
      if (!item) continue;
      item.classList.add('is-visible');
      if (!visibleItems.includes(item)) visibleItems.push(item);
    }
    const fallbackItem = findVisibleItem(activeHeadingIndex);
    scrollItemsIntoView(visibleItems.length > 0 ? visibleItems : fallbackItem ? [fallbackItem] : []);
  };

  const updateActiveHeadings = () => {
    if (currentOutlineHeadings.length === 0) return false;
    const editor = getEditor();
    if (!editor) return false;
    const visibleRange = editor.getVisibleDocumentRange();
    visibleHeadingIndexes = new Set(findVisibleHeadingIndexes(currentOutlineHeadings, visibleRange));
    const anchor = editor.getViewportAnchorOffset(ACTIVE_VIEWPORT_RATIO);
    let nextActive = -1;
    for (let index = 0; index < currentOutlineHeadings.length; index += 1) {
      if (currentOutlineHeadings[index].from <= anchor) nextActive = index;
      else break;
    }
    activeHeadingIndex = nextActive;
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
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      refreshActive();
    });
  }

  const appendHeadingContent = (item: HTMLElement, heading: OutlineHeading) => {
    if (!heading.inlineSegments?.length) {
      item.textContent = heading.text || '(空标题)';
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
      item.appendChild(content);
    }
  };

  const renderNode = (node: OutlineTreeNode): HTMLLIElement => {
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
      foldButton.title = collapsed ? '展开' : '折叠';
      foldButton.setAttribute('aria-label', foldButton.title);
      foldButton.appendChild(createElement(collapsed ? ChevronRight : ChevronDown, { width: 12, height: 12 }));
    } else {
      foldButton.disabled = true;
      foldButton.tabIndex = -1;
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `outline-item outline-level-${node.heading.level}`;
    appendHeadingContent(item, node.heading);
    item.title = node.heading.text;
    item.draggable = true;
    item.dataset.headingFrom = String(node.heading.from);
    row.append(foldButton, item);
    itemNode.appendChild(row);

    if (node.children.length > 0 && !collapsedKeys.has(node.key)) {
      const children = document.createElement('ul');
      children.className = 'outline-tree outline-tree-children';
      for (const child of node.children) children.appendChild(renderNode(child));
      itemNode.appendChild(children);
    }
    return itemNode;
  };

  const renderTree = () => {
    outlineContent.replaceChildren();
    if (currentTreeRoots.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'outline-empty';
      emptyMsg.textContent = '暂无标题';
      outlineContent.appendChild(emptyMsg);
      return;
    }
    const tree = document.createElement('ul');
    tree.className = 'outline-tree';
    for (const rootNode of currentTreeRoots) tree.appendChild(renderNode(rootNode));
    outlineContent.appendChild(tree);
    highlightVisibleHeadings();
  };

  const refresh = () => {
    if (outlineDragState) clearOutlineDragState();
    const editor = getEditor();
    if (!editor) {
      currentOutlineHeadings = [];
      currentOutlineHeadingIndexByFrom = new Map();
      currentTreeRoots = [];
      currentNodeByIndex = new Map();
      visibleHeadingIndexes = new Set();
      activeHeadingIndex = -1;
      renderTree();
      return;
    }
    currentOutlineHeadings = editor.getHeadings();
    currentOutlineHeadingIndexByFrom = new Map(currentOutlineHeadings.map((heading, index) => [heading.from, index]));
    const tree = buildOutlineTree(currentOutlineHeadings);
    currentTreeRoots = tree.roots;
    currentNodeByIndex = tree.nodeByIndex;
    const validKeys = new Set(Array.from(currentNodeByIndex.values(), (node) => node.key));
    collapsedKeys = new Set([...collapsedKeys].filter((key) => validKeys.has(key)));
    bindScroll();
    updateActiveHeadings();
    renderTree();
  };

  const updateModeButton = () => {
    modeButton.replaceChildren(createElement(mode === 'floating' ? Pin : PinOff, { width: 14, height: 14 }));
    modeButton.title = mode === 'floating' ? '切换到固定目录' : '切换到浮动目录';
    modeButton.setAttribute('aria-label', modeButton.title);
  };

  const updatePositionButton = () => {
    const nextPosition = position === 'left' ? 'right' : 'left';
    positionButton.replaceChildren(createElement(nextPosition === 'left' ? PanelLeft : PanelRight, { width: 14, height: 14 }));
    positionButton.title = nextPosition === 'left' ? '切换到左侧' : '切换到右侧';
    positionButton.setAttribute('aria-label', positionButton.title);
  };

  const updateOutlineUI = () => {
    outlineButton.classList.toggle('is-active', visible);
    root.classList.toggle('outline-visible', visible);
    editorWrapper.dataset.outlineMode = mode;
    editorWrapper.dataset.outlinePosition = position;
    applyOutlineWidth();
    updateModeButton();
    updatePositionButton();
  };

  const setVisible = (nextVisible: boolean) => {
    const changed = visible !== (nextVisible === true);
    visible = nextVisible === true;
    updateOutlineUI();
    if (visible && changed) refresh();
  };

  const requestVisible = (nextVisible: boolean) => {
    if (visible === nextVisible) return;
    setVisible(nextVisible);
    onVisibilityRequest?.(nextVisible);
  };

  const setMode = (nextMode: OutlineMode) => {
    const normalizedMode = nextMode === 'floating' ? 'floating' : 'fixed';
    if (mode === normalizedMode) return;
    mode = normalizedMode;
    updateOutlineUI();
    notifyUiState();
  };

  const setWidth = (nextWidth: number) => {
    const normalizedWidth = clampOutlineWidth(nextWidth);
    if (width === normalizedWidth) return;
    width = normalizedWidth;
    applyOutlineWidth();
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
      renderTree();
    } else if (action === 'collapse-top2') {
      collapsedKeys = new Set(
        [...currentNodeByIndex.values()]
          .filter((node) => node.depth >= 1 && node.children.length > 0)
          .map((node) => node.key)
      );
      renderTree();
    } else if (action === 'toggle-mode') setMode(mode === 'floating' ? 'fixed' : 'floating');
    else if (action === 'toggle-position') requestPosition(position === 'left' ? 'right' : 'left');
  });

  outlineContent.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const foldButton = target?.closest<HTMLElement>('.outline-fold-button[data-outline-key]');
    if (foldButton) {
      const key = foldButton.dataset.outlineKey;
      if (key) {
        if (collapsedKeys.has(key)) collapsedKeys.delete(key);
        else collapsedKeys.add(key);
        renderTree();
      }
      return;
    }
    const item = target?.closest<HTMLElement>('.outline-item');
    if (!item || !outlineContent.contains(item)) return;
    if (performance.now() < suppressOutlineClickUntil) {
      suppressOutlineClickUntil = 0;
      event.preventDefault();
      return;
    }
    const headingFrom = Number.parseInt(item.dataset.headingFrom ?? '', 10);
    const headingIndex = currentOutlineHeadingIndexByFrom.get(headingFrom);
    const heading = typeof headingIndex === 'number' ? currentOutlineHeadings[headingIndex] : null;
    if (heading) getEditor()?.scrollToLine(heading.line, 'top');
    if (mode === 'floating') requestVisible(false);
  });

  outlineContent.addEventListener('dragstart', (event) => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.outline-item') : null;
    if (!item || !outlineContent.contains(item)) return;
    const sourceFrom = Number.parseInt(item.dataset.headingFrom ?? '', 10);
    if (!getEditor() || !currentOutlineHeadingIndexByFrom.has(sourceFrom)) {
      event.preventDefault();
      return;
    }
    clearOutlineDragState();
    outlineDragState = { sourceFrom, draggedElement: item, dropTargetFrom: null, dropPlacement: null };
    outlineContent.classList.add('is-dragging-outline');
    item.classList.add('is-dragging');
    item.setAttribute('aria-grabbed', 'true');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(sourceFrom));
    }
  });

  outlineContent.addEventListener('dragover', (event) => {
    if (!outlineDragState) return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.outline-item') : null;
    const candidate = item && outlineContent.contains(item) ? getOutlineDropCandidate(item, event.clientY) : null;
    if (!candidate) {
      applyOutlineDropIndicator(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    applyOutlineDropIndicator(candidate);
  });

  outlineContent.addEventListener('drop', (event) => {
    if (!outlineDragState) return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.outline-item') : null;
    const candidate = item && outlineContent.contains(item) ? getOutlineDropCandidate(item, event.clientY) : null;
    event.preventDefault();
    event.stopPropagation();
    const sourceFrom = outlineDragState.sourceFrom;
    clearOutlineDragState();
    if (candidate && getEditor()?.moveHeadingSection(sourceFrom, candidate.targetFrom, candidate.placement)) {
      suppressOutlineClickUntil = performance.now() + OUTLINE_DROP_CLICK_GRACE_PERIOD_MS;
    }
  });

  outlineContent.addEventListener('dragend', clearOutlineDragState);

  document.addEventListener('pointerdown', (event) => {
    if (!visible || mode !== 'floating') return;
    const target = event.target instanceof Node ? event.target : null;
    if (!target || outlineSidebar.contains(target) || outlineButton.contains(target)) return;
    requestVisible(false);
  }, true);

  outlineResizer.addEventListener('pointerdown', (event) => {
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add('outline-resizing');
    const onMove = (moveEvent: PointerEvent) => {
      const direction = position === 'left' ? 1 : -1;
      const nextWidth = clampOutlineWidth(startWidth + (moveEvent.clientX - startX) * direction);
      if (nextWidth === width) return;
      width = nextWidth;
      applyOutlineWidth();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('outline-resizing');
      notifyUiState();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.preventDefault();
  });

  updateOutlineUI();

  return { sidebar: outlineSidebar, setVisible, refresh, setPosition, setMode, setWidth, isVisible: () => visible };
}
