import type { PreviewDocumentManifest, PreviewDocumentOperation, PreviewDocumentResult,
  PreviewDocumentChunk, PreviewDocumentPosition, PreviewDocumentBlock } from '../../../src/foundation/previewDocument';
import { previewBlockAtLine } from '../../../src/foundation/previewDocument';
import { createPreviewBlockLayout } from '../application/previewBlockLayout';

type MountedBlock = { start: Comment; end: Comment };
type CopyValue = { text: string; html: string };
const ignoredText = 'script,style,noscript,svg,.meo-preview-code-actions,.meo-preview-search-overview-ruler';

function gapRanges(blocks: readonly PreviewDocumentBlock[], from: number, to: number) {
  if (to <= from) return [];
  const footer = blocks.at(-1)?.kind === 'footnotes' ? blocks.length - 1 : -1;
  const bounds = footer >= from && footer < to ? [[from, footer], [footer, to]] : [[from, to]];
  return bounds.filter(([start, end]) => end! > start!).map(([first, last]) => {
    const block = blocks[first!]!, final = blocks[last! - 1]!;
    const ranges = first === footer ? block.sourceRanges : undefined;
    return { from: first!, to: last!, start: ranges?.length ? Math.min(...ranges.map(range => range.start)) : block.sourceLine,
      end: ranges?.length ? Math.max(...ranges.map(range => range.end)) : final.sourceEndLine };
  });
}

/** A bounded initial projection can use the existing morph rules to retain rich DOM across edits. */
export function previewWindowProjection(root: HTMLElement, manifest: PreviewDocumentManifest): string {
  const document = root.ownerDocument, window = document.defaultView!;
  const style = window.getComputedStyle(root), fontSize = Number.parseFloat(style.fontSize) || 16;
  const layout = createPreviewBlockLayout(manifest.blocks, { width: root.clientWidth || window.innerWidth,
    fontSize, lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.6 });
  const parts: string[] = [];
  const gap = (from: number, to: number) => {
    for (const range of gapRanges(manifest.blocks, from, to)) parts.push(
      `<div class="meo-preview-viewport-gap" data-meo-preview-gap="true" data-source-line="${range.start}" data-source-end-line="${range.end}" aria-hidden="true" style="height:${layout.top(range.to) - layout.top(range.from)}px;margin:0;padding:0;overflow-anchor:none;pointer-events:none"></div>`);
  };
  let from = 0;
  for (const chunk of [...manifest.chunks].sort((left, right) => left.index - right.index)) {
    gap(from, chunk.index);
    const template = document.createElement('template'); template.innerHTML = chunk.html;
    for (const element of Array.from(template.content.children)) (element as HTMLElement).dataset.meoPreviewBlock = String(chunk.index);
    parts.push(`<!--preview:${chunk.index}-->${template.innerHTML}<!--/preview-->`);
    from = chunk.index + 1;
  }
  gap(from, manifest.blocks.length);
  return parts.join('');
}

/** The reading window owns mounted roots; source, searching and copying belong to the parsed document. */
export function createPreviewViewport(root: HTMLElement, manifest: PreviewDocumentManifest, dependencies: {
  request(documentId: string, operation: PreviewDocumentOperation): Promise<PreviewDocumentResult>;
  mutate(run: () => void): void;
  changed(): void;
  error(error: unknown): void;
  reveal(element: HTMLElement, align: ScrollLogicalPosition): void;
  writeClipboard(value: Promise<CopyValue>): Promise<void>;
}) {
  const document = root.ownerDocument;
  const window = document.defaultView!;
  const scroll = document.scrollingElement!;
  const events = new AbortController();
  const mounted = new Map<number, MountedBlock>();
  const gaps = new Set<HTMLElement>();
  const cache = new Map<number, PreviewDocumentChunk>();
  const loading = new Map<number, Promise<void>>();
  const forced = new Set<number>();
  const owners = new WeakMap<Node, number>();
  let cacheBytes = 0, disposed = false, active = true, frame: number | null = null;
  let logicalAll = false, geometrySignature = '';
  let geometryDirty = true;
  let documentGeneration = 0;
  let layout = createLayout();

  function createLayout() {
    const style = window.getComputedStyle(root);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    geometrySignature = `${root.clientWidth}:${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${style.fontWeight}`;
    return createPreviewBlockLayout(manifest.blocks, { width: root.clientWidth || window.innerWidth,
      fontSize, lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.6 });
  }
  const origin = () => root.getBoundingClientRect().top + scroll.scrollTop;
  const nodes = (block: MountedBlock): Node[] => {
    const result: Node[] = [];
    for (let node = block.start.nextSibling; node && node !== block.end; node = node.nextSibling) result.push(node);
    return result;
  };
  const elements = (block: MountedBlock): HTMLElement[] => nodes(block).filter(node => node.nodeType === 1) as HTMLElement[];
  const acceptText = (node: Node) => !node.parentElement?.closest(ignoredText);
  const textNodes = (node: Node): Text[] => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: current => acceptText(current) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const result: Text[] = [];
    while (walker.nextNode()) result.push(walker.currentNode as Text);
    return result;
  };
  const owner = (node: Node | null): number | null => {
    for (let current = node; current && current !== root; current = current.parentNode) {
      const mapped = owners.get(current);
      if (mapped !== undefined) return mapped;
      if (current instanceof window.HTMLElement && current.dataset.meoPreviewBlock !== undefined) {
        return Number(current.dataset.meoPreviewBlock);
      }
    }
    return null;
  };
  const point = (node: Node | null, offset: number): PreviewDocumentPosition | null => {
    const index = owner(node);
    const block = index === null ? undefined : mounted.get(index);
    if (!node || index === null || !block) return null;
    try {
      const range = document.createRange();
      range.setStartAfter(block.start); range.setEnd(node, offset);
      return { block: index, offset: textNodes(range.cloneContents()).reduce((sum, text) => sum + text.length, 0) };
    } catch { return null; }
  };
  const selection = (): { from: PreviewDocumentPosition; to: PreviewDocumentPosition } | null => {
    if (logicalAll && manifest.blocks.length) return { from: { block: 0, offset: 0 },
      to: { block: manifest.blocks.length - 1, offset: Number.MAX_SAFE_INTEGER } };
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed) return null;
    const from = point(selected.anchorNode, selected.anchorOffset), to = point(selected.focusNode, selected.focusOffset);
    return from && to ? { from, to } : null;
  };
  const remember = (chunk: PreviewDocumentChunk) => {
    const previous = cache.get(chunk.index);
    if (previous) cacheBytes -= previous.html.length * 2;
    cache.delete(chunk.index); cache.set(chunk.index, chunk); cacheBytes += chunk.html.length * 2;
  };
  const trimCache = () => {
    while (cacheBytes > 2 * 1024 * 1024 && cache.size) {
      const oldest = [...cache.keys()].find(index => mounted.has(index) || !loading.has(index) && !forced.has(index));
      if (oldest === undefined) break;
      cacheBytes -= cache.get(oldest)!.html.length * 2; cache.delete(oldest);
    }
  };
  const desired = (): number[] => {
    const band = layout.window(Math.max(0, scroll.scrollTop - origin()), window.innerHeight);
    const indices = new Set(forced);
    for (let index = band.from; index < band.to; index += 1) indices.add(index);
    const selected = selection();
    if (selected && !logicalAll) { indices.add(selected.from.block); indices.add(selected.to.block); }
    return [...indices].filter(index => index >= 0 && index < manifest.blocks.length).sort((left, right) => left - right);
  };
  const addGap = (from: number, to: number, before: Node | null) => {
    for (const range of gapRanges(manifest.blocks, from, to)) {
    const gap = document.createElement('div');
    gap.className = 'meo-preview-viewport-gap';
    gap.dataset.meoPreviewGap = 'true';
    gap.dataset.sourceLine = String(range.start);
    gap.dataset.sourceEndLine = String(range.end);
    gap.setAttribute('aria-hidden', 'true');
    const next = before?.nextSibling instanceof window.HTMLElement ? before.nextSibling : null;
    const margin = next ? Number.parseFloat(window.getComputedStyle(next).marginTop) || 0 : 0;
    gap.style.cssText = `height:${Math.max(0, layout.top(range.to) - layout.top(range.from) - margin)}px;margin:0;padding:0;overflow-anchor:none;pointer-events:none`;
    root.insertBefore(gap, before); gaps.add(gap);
    }
  };
  const rebuildGaps = () => {
    for (const gap of gaps) gap.remove();
    gaps.clear();
    const indices = [...mounted.keys()].sort((left, right) => left - right);
    let from = 0;
    for (const index of indices) { addGap(from, index, mounted.get(index)!.start); from = index + 1; }
    addGap(from, manifest.blocks.length, null);
  };
  const measure = () => {
    let changed = false;
    const indices = [...mounted.keys()].sort((left, right) => left - right);
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const index = indices[cursor]!;
      const current = elements(mounted.get(index)!);
      if (!current.length) { changed = layout.measure(index, 1) || changed; continue; }
      const first = current[0]!.getBoundingClientRect();
      const nextIndex = indices[cursor + 1];
      const next = nextIndex === index + 1 ? elements(mounted.get(nextIndex)!)?.[0] : null;
      const last = current.at(-1)!;
      const bottom = next ? next.getBoundingClientRect().top
        : last.getBoundingClientRect().bottom + (Number.parseFloat(window.getComputedStyle(last).marginBottom) || 0);
      changed = layout.measure(index, Math.max(1, bottom - first.top)) || changed;
    }
    return changed;
  };
  const commit = () => {
    if (disposed || !active) return;
    const indices = desired();
    const wanted = new Set(indices);
    const structureChanged = [...mounted.keys()].some(index => !wanted.has(index))
      || indices.some(index => !mounted.has(index) && cache.has(index));
    if (!structureChanged && !geometryDirty) return;
    const atBottom = scroll.scrollHeight > scroll.clientHeight
      && scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1;
    geometryDirty = false;
    dependencies.mutate(() => {
      for (const [index, block] of mounted) if (!wanted.has(index)) {
        for (const node of [block.start, ...nodes(block), block.end]) node.parentNode?.removeChild(node);
        mounted.delete(index);
      }
      let before: Node | null = null;
      for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) {
        const index = indices[cursor]!;
        const existing = mounted.get(index);
        if (existing) { before = existing.start; continue; }
        const chunk = cache.get(index);
        if (!chunk) continue;
        const template = document.createElement('template');
        template.innerHTML = chunk.html;
        const start = document.createComment(`preview:${index}`), end = document.createComment('/preview');
        for (const node of Array.from(template.content.childNodes)) {
          owners.set(node, index);
          if (node instanceof window.HTMLElement) node.dataset.meoPreviewBlock = String(index);
        }
        const fragment = document.createDocumentFragment();
        fragment.append(start, template.content, end);
        root.insertBefore(fragment, before);
        mounted.set(index, { start, end }); before = start;
      }
      if (structureChanged) rebuildGaps();
      const measured = measure();
      if (structureChanged || measured) { rebuildGaps(); dependencies.changed(); }
    });
    // Replacing estimated gaps can change the native range. A bottom navigation
    // intent refers to the document boundary, not the old numerical scrollTop.
    if (atBottom) scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
    trimCache();
    if (logicalAll) {
      const selected = window.getSelection();
      if (selected && !(selected.anchorNode === root && selected.anchorOffset === 0
        && selected.focusNode === root && selected.focusOffset === root.childNodes.length)) {
        const range = document.createRange(); range.selectNodeContents(root);
        selected.removeAllRanges(); selected.addRange(range);
      }
    }
  };
  const ensureChunks = async (indices: readonly number[]): Promise<void> => {
    const revision = documentGeneration;
    const missing = indices.filter(index => !cache.has(index) && !mounted.has(index) && !loading.has(index));
    for (let from = 0; from < missing.length; from += 128) {
      const batch = missing.slice(from, from + 128);
      const operation = dependencies.request(manifest.id, { kind: 'blocks', indices: batch }).then(result => {
        if (disposed || revision !== documentGeneration) return;
        if (result.kind !== 'blocks') throw new Error('Preview returned a different block window');
        for (const chunk of result.chunks) remember(chunk);
      }).catch(error => { if (!disposed && revision === documentGeneration) throw error; })
        .finally(() => { for (const index of batch) if (loading.get(index) === operation) loading.delete(index); });
      for (const index of batch) loading.set(index, operation);
    }
    await Promise.all(indices.map(index => loading.get(index)));
  };
  const refresh = () => {
    if (disposed || !active || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (disposed || !active) return;
      commit();
      void ensureChunks(desired()).then(() => {
        if (disposed || !active) return;
        commit();
      }, error => { if (!disposed && active) dependencies.error(error); });
    });
  };
  const atLine = (line: number) => {
    return previewBlockAtLine(manifest.blocks, line) ?? 0;
  };
  const ensure = async (target: { block?: number; line?: number; anchor?: string;
    align?: ScrollLogicalPosition; scroll?: boolean; isCurrent?: () => boolean }): Promise<HTMLElement | null> => {
    if (target.isCurrent?.() === false || disposed) return null;
    const revision = documentGeneration;
    let index = target.block ?? atLine(target.line ?? 1);
    if (target.anchor !== undefined) {
      const result = await dependencies.request(manifest.id, { kind: 'locate', anchor: target.anchor });
      if (disposed || revision !== documentGeneration || result.kind !== 'locate' || result.block === null) return null;
      index = result.block;
    }
    if (index < 0 || index >= manifest.blocks.length || disposed) return null;
    forced.add(index);
    try {
      await ensureChunks([index]);
      if (disposed || revision !== documentGeneration || target.isCurrent?.() === false) return null;
      commit();
      const block = mounted.get(index);
      if (!block) return null;
      const roots = elements(block);
      const anchor = target.anchor;
      const element = anchor !== undefined ? document.getElementById(anchor) ?? document.getElementsByName(anchor)[0]
        ?? (document.documentElement.dataset.meoPreviewRenderer === 'github-readme'
          ? document.getElementById(`user-content-${anchor}`) ?? document.getElementsByName(`user-content-${anchor}`)[0] : null)
        : target.line !== undefined ? roots.flatMap(root => [root, ...root.querySelectorAll<HTMLElement>('[data-source-line]')])
          .find(element => Number(element.dataset.sourceLine) === target.line) ?? roots[0] ?? null : roots[0] ?? null;
      if (element && target.scroll !== false) dependencies.reveal(element, target.align ?? 'start');
      return element;
    } finally { forced.delete(index); refresh(); }
  };

  document.addEventListener('selectionchange', refresh, { signal: events.signal });
  document.addEventListener('scroll', refresh, { passive: true, signal: events.signal });
  document.addEventListener('pointerdown', () => { logicalAll = false; }, { capture: true, signal: events.signal });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'
      && !(event.target as Element | null)?.closest?.('input,textarea,[contenteditable="true"]')) {
      event.preventDefault(); logicalAll = true;
      const range = document.createRange(); range.selectNodeContents(root);
      const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
      refresh();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      // Copy consumes the logical selection, including currently unmounted blocks.
    } else if ((event.ctrlKey || event.metaKey) && ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); logicalAll = false;
      const index = event.key === 'Home' ? 0 : manifest.blocks.length - 1;
      void ensure({ block: index, align: event.key === 'Home' ? 'start' : 'end' }).then(element => {
        if (!element || !event.shiftKey) return;
        const texts = textNodes(element);
        const target = event.key === 'Home' ? texts[0] : texts.at(-1);
        if (target) window.getSelection()?.extend(target, event.key === 'Home' ? 0 : target.length);
      }).catch(dependencies.error);
    } else if (event.shiftKey && ['PageUp', 'PageDown'].includes(event.key)) {
      const selected = window.getSelection();
      const focus = selected ? point(selected.focusNode, selected.focusOffset) : null;
      if (!focus) return;
      const direction = event.key === 'PageDown' ? 1 : -1;
      const index = layout.at(layout.top(focus.block) + window.innerHeight * direction);
      if (index === focus.block) return;
      event.preventDefault(); logicalAll = false;
      void ensure({ block: index, align: 'nearest' }).then(element => {
        if (!element) return;
        const texts = textNodes(element);
        const target = direction > 0 ? texts.at(-1) : texts[0];
        if (target) window.getSelection()?.extend(target, direction > 0 ? target.length : 0);
      }).catch(dependencies.error);
    } else if (!['Control', 'Meta', 'Shift'].includes(event.key)) logicalAll = false;
  }, { capture: true, signal: events.signal });
  document.addEventListener('copy', event => {
    const selected = selection();
    if (!selected) return;
    const first = Math.min(selected.from.block, selected.to.block), last = Math.max(selected.from.block, selected.to.block);
    let complete = !logicalAll;
    for (let index = first; complete && index <= last; index += 1) complete = mounted.has(index);
    if (complete) return;
    event.preventDefault();
    const readCopy = async (from: PreviewDocumentPosition, to: PreviewDocumentPosition) => {
      const result = await dependencies.request(manifest.id, { kind: 'copy', from, to });
      if (result.kind !== 'copy') throw new Error('Preview returned a different selection');
      return result;
    };
    const endpoint = (range: Range): CopyValue => {
      const content = range.cloneContents();
      for (const control of content.querySelectorAll('script,style,noscript,.meo-preview-code-actions,.meo-preview-search-overview-ruler')) control.remove();
      const wrapper = document.createElement('div'); wrapper.append(content);
      return { html: wrapper.innerHTML, text: textNodes(wrapper).map(node => node.data).join('') };
    };
    // Endpoint offsets belong to hydrated DOM. Math/diagram source placeholders
    // may have changed their text; only unmounted interior uses parser offsets.
    const native = window.getSelection();
    const range = !logicalAll && native?.rangeCount ? native.getRangeAt(0) : null;
    let copied: Promise<CopyValue>;
    const firstBlock = mounted.get(first), lastBlock = mounted.get(last);
    if (range && firstBlock && lastBlock) {
      const start = range.cloneRange(); start.setEndBefore(firstBlock.end);
      const end = range.cloneRange(); end.setStartAfter(lastBlock.start);
      const prefix = endpoint(start), suffix = endpoint(end);
      const interior = first + 1 < last ? readCopy({ block: first + 1, offset: 0 },
        { block: last - 1, offset: Number.MAX_SAFE_INTEGER }) : Promise.resolve({ text: '', html: '' });
      copied = interior.then(value => ({ text: [prefix.text, value.text, suffix.text].filter(Boolean).join('\n'),
        html: prefix.html + value.html + suffix.html }));
    } else copied = readCopy(selected.from, selected.to);
    void dependencies.writeClipboard(copied).catch(dependencies.error);
  }, { capture: true, signal: events.signal });
  const Observer = (window as unknown as typeof globalThis).ResizeObserver;
  const resize = Observer ? new Observer(() => {
    const style = window.getComputedStyle(root);
    const signature = `${root.clientWidth}:${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${style.fontWeight}`;
    if (signature !== geometrySignature) layout = createLayout();
    geometryDirty = true;
    refresh();
  }) : null;
  resize?.observe(root);
  root.style.overflowAnchor = 'none';
  if (root.dataset.meoPreviewDocument === manifest.id) {
    let start: Comment | null = null, index = -1;
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType !== 8) continue;
      const value = (child as Comment).data;
      if (/^preview:\d+$/.test(value)) { start = child as Comment; index = Number(value.slice(8)); }
      else if (value === '/preview' && start && index >= 0 && index < manifest.blocks.length) {
        const block = { start, end: child as Comment };
        mounted.set(index, block);
        for (const node of nodes(block)) { owners.set(node, index);
          if (node instanceof window.HTMLElement) node.dataset.meoPreviewBlock = String(index); }
        start = null;
      }
    }
    for (const child of Array.from(root.children)) if ((child as HTMLElement).dataset.meoPreviewGap === 'true') gaps.add(child as HTMLElement);
  }
  root.dataset.meoPreviewDocument = manifest.id;
  for (const chunk of manifest.chunks) remember(chunk);
  const initial = atLine(manifest.anchorLine);
  if (manifest.blocks.length) forced.add(initial);
  commit();
  if (manifest.anchorLine > 1) scroll.scrollTop = origin() + layout.top(initial);
  forced.clear();
  refresh();
  return {
    get manifest() { return manifest; },
    ensure,
    async whenReady() {
      while (!disposed && active) {
        const indices = desired();
        await ensureChunks(indices); commit();
        if (indices.every(index => mounted.has(index))) return;
      }
    },
    rebind(next: PreviewDocumentManifest): boolean {
      if (next.blocks.length !== manifest.blocks.length || next.blocks.some((block, index) => {
        const previous = manifest.blocks[index]!;
        return block.sourceLine !== previous.sourceLine || block.sourceEndLine !== previous.sourceEndLine
          || block.kind !== previous.kind || block.sourceCharacters !== previous.sourceCharacters;
      })) return false;
      documentGeneration += 1; manifest = next;
      root.dataset.meoPreviewDocument = next.id;
      loading.clear(); cache.clear(); cacheBytes = 0;
      for (const chunk of next.chunks) remember(chunk);
      refresh();
      return true;
    },
    containsLine: (line: number) => mounted.has(atLine(line)),
    readAnchor(viewportOffset = 0) {
      if (!manifest.blocks.length) return null;
      const offset = Math.max(0, scroll.scrollTop + viewportOffset - origin());
      const index = layout.at(offset), block = manifest.blocks[index]!;
      const progress = Math.max(0, Math.min(1, (offset - layout.top(index)) / Math.max(1, layout.height(index))));
      return { line: block.sourceLine + Math.floor((block.sourceEndLine - block.sourceLine) * progress),
        rendered: mounted.has(index), sourceRange: { startLine: block.sourceLine, endLine: block.sourceEndLine, progress } };
    },
    projectLine(line: number, lineOffset = 0, viewportOffset = 0, progress?: number) {
      if (!manifest.blocks.length) return;
      const index = atLine(line), block = manifest.blocks[index]!;
      const ratio = progress ?? (line - block.sourceLine) / Math.max(1, block.sourceEndLine - block.sourceLine + 1);
      scroll.scrollTop = origin() + layout.top(index) + layout.height(index) * Math.max(0, Math.min(1, ratio))
        + Math.max(0, lineOffset) - Math.max(0, viewportOffset);
      refresh();
    },
    refresh(options: { active?: boolean; invalidateGeometry?: boolean } = {}) {
      if (options.active !== undefined) active = options.active;
      if (options.invalidateGeometry) { layout = createLayout(); geometryDirty = true; }
      refresh();
    },
    position: (index: number, ratio = 0) => layout.top(index) + layout.height(index) * ratio,
    totalHeight: () => layout.total(),
    selectedText: () => {
      const selected = selection();
      if (logicalAll) return '';
      if (selected) for (let index = Math.min(selected.from.block, selected.to.block);
        index <= Math.max(selected.from.block, selected.to.block); index += 1) if (!mounted.has(index)) return '';
      return window.getSelection()?.toString() ?? '';
    },
    dispose() {
      disposed = true; events.abort(); resize?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null; forced.clear(); cache.clear(); cacheBytes = 0;
      root.style.removeProperty('overflow-anchor');
    }
  };
}
