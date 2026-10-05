export type TooltipContent =
  | { readonly text: string; readonly shortcut?: string; readonly kind?: 'hint' }
  | { readonly text: string; readonly shortcut?: never; readonly kind: 'fulltext' | 'description' };

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

type Bounds = { left: number; top: number; right: number; bottom: number };
let nextTooltipId = 0;
let activeTooltip: { hide(): void; reposition(): void; pointerDown(event: PointerEvent): void } | undefined;
const ownedAnchors = new WeakSet<HTMLElement>();
const menuSelector = '.heading-dropdown, .table-dropdown, .preview-dropdown-panel, [role="menu"], .changes-review-popover, .meo-md-html-table-context-menu';
const modalSelector = 'dialog[open], .meo-md-image-fullscreen-scrim, .meo-mermaid-fullscreen-scrim, .meo-latex-math-fullscreen-scrim';
const intersects = (a: Bounds, b: Bounds) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function painted(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView!;
  if (!element.isConnected || !element.getClientRects().length) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (parent.hidden || parent.inert || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  }
  return true;
}

function visibleBounds(anchor: HTMLElement, area: Bounds): Bounds | null {
  if (!painted(anchor)) return null;
  const view = anchor.ownerDocument.defaultView!;
  const bounds = anchor.getBoundingClientRect();
  const clipped = { left: Math.max(bounds.left, area.left), top: Math.max(bounds.top, area.top), right: Math.min(bounds.right, area.right), bottom: Math.min(bounds.bottom, area.bottom) };
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    // The document scroller's rectangle moves with scroll; viewport clipping is already in area.
    if (parent === anchor.ownerDocument.scrollingElement) continue;
    const style = view.getComputedStyle(parent), rect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      clipped.left = Math.max(clipped.left, rect.left + parent.clientLeft);
      clipped.right = Math.min(clipped.right, rect.left + parent.clientLeft + parent.clientWidth);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      clipped.top = Math.max(clipped.top, rect.top + parent.clientTop);
      clipped.bottom = Math.min(clipped.bottom, rect.top + parent.clientTop + parent.clientHeight);
    }
  }
  return clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
}

/**
 * One shared hint: 200ms hover/focus, above/below/right/left placement, menu avoidance.
 * Optional placement prefers that side, then its opposite, while keeping the hint visible.
 * Live updates retain a stateful control's hint and reveal changed content immediately
 * while hovered or keyboard-focused, until dismissal or a new interaction target.
 * Callers supply localized, concise content and the current effective shortcut.
 * Full-text / multiline content must never contain a shortcut. Dispose with its owner.
 */
export function createTooltip(anchor: HTMLElement, options: {
  readonly content: TooltipContent;
  readonly id?: string;
  readonly focusTarget?: HTMLElement;
  readonly placement?: TooltipPlacement;
  readonly liveUpdate?: boolean;
}) {
  const doc = anchor.ownerDocument, view = doc.defaultView!;
  const focusTarget = options.focusTarget ?? anchor;
  const tooltip = doc.createElement('span');
  tooltip.id = options.id ?? 'meo-tooltip-' + ++nextTooltipId;
  tooltip.className = 'meo-tooltip';
  tooltip.classList.toggle('meo-tooltip--window', !!anchor.closest('.mode-toolbar, .find-panel, .source-preview-toolbar, dialog'));
  tooltip.setAttribute('role', 'tooltip');
  const frameOwner = view.frameElement?.ownerDocument;
  if (frameOwner) {
    const ownerStyle = frameOwner.defaultView!.getComputedStyle(frameOwner.body);
    tooltip.style.setProperty('--vscode-font-family', ownerStyle.fontFamily);
    for (const variable of ['--meo-layer-document-popover', '--meo-layer-window-popover']) {
      tooltip.style.setProperty(variable, ownerStyle.getPropertyValue(variable));
    }
  }
  const label = doc.createElement('span'); label.className = 'meo-tooltip-label';
  const shortcut = doc.createElement('kbd'); shortcut.className = 'meo-tooltip-shortcut';
  tooltip.append(label, shortcut);
  // Portal outside scrolling content, while staying inside native modal / fullscreen ownership.
  const portal = anchor.closest<HTMLElement>(modalSelector) ?? doc.fullscreenElement ?? doc.body;
  portal.append(tooltip);
  anchor.removeAttribute('title'); focusTarget.removeAttribute('title');
  const descriptions = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  focusTarget.setAttribute('aria-describedby', [...descriptions, tooltip.id].join(' '));
  ownedAnchors.add(anchor);
  const events = new view.AbortController();
  let content = options.content;
  let hovering = anchor.matches(':hover'), visible = false, disposed = false;
  let engaged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportedConflict = '';
  const handle = { hide, reposition: position, pointerDown };

  function reportConflict() {
    const identity = content.text + '/' + content.shortcut;
    if (reportedConflict !== identity) {
      reportedConflict = identity;
      console.warn('[MEO tooltip] Needs a separate presentation: full-text or multiline hint with a shortcut.', { text: content.text, shortcut: content.shortcut, anchor });
    }
    hide();
  }

  function position() {
    if (!visible) return;
    const frame = view.frameElement as HTMLElement | null;
    let viewport: Bounds = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
    if (frame) {
      const parentView = frame.ownerDocument.defaultView!;
      const clipped = visibleBounds(frame, { left: 0, top: 0, right: parentView.innerWidth, bottom: parentView.innerHeight });
      if (!clipped) { hide(); return; }
      const rect = frame.getBoundingClientRect();
      viewport = { left: (clipped.left - rect.left) * view.innerWidth / rect.width, right: (clipped.right - rect.left) * view.innerWidth / rect.width,
        top: (clipped.top - rect.top) * view.innerHeight / rect.height, bottom: (clipped.bottom - rect.top) * view.innerHeight / rect.height };
    }
    const modal = anchor.closest<HTMLElement>(modalSelector);
    const owner = modal ?? doc.fullscreenElement ?? doc.body;
    if (tooltip.parentElement !== owner) owner.append(tooltip);
    tooltip.classList.toggle('meo-tooltip--window', !!anchor.closest('.mode-toolbar, .find-panel, .source-preview-toolbar, dialog'));
    const container = modal?.getBoundingClientRect();
    const margin = 8, gap = 6;
    const area: Bounds = { left: Math.max(viewport.left, container?.left ?? viewport.left) + margin, top: Math.max(viewport.top, container?.top ?? viewport.top) + margin,
      right: Math.min(viewport.right, container?.right ?? viewport.right) - margin, bottom: Math.min(viewport.bottom, container?.bottom ?? viewport.bottom) - margin };
    const bounds = visibleBounds(anchor, area);
    if (!bounds) { hide(); return; }
    tooltip.style.maxWidth = '';
    tooltip.classList.toggle('meo-tooltip--wrap', content.kind === 'fulltext' || content.kind === 'description');
    if (content.shortcut && ((content.kind && content.kind !== 'hint') || /[\r\n]/.test(content.text))) { reportConflict(); return; }
    let hint = tooltip.getBoundingClientRect();
    if (hint.width > area.right - area.left) {
      if (content.shortcut) { reportConflict(); return; }
      tooltip.classList.add('meo-tooltip--wrap');
      tooltip.style.maxWidth = Math.max(0, area.right - area.left) + 'px';
      hint = tooltip.getBoundingClientRect();
    }
    const menus = [...doc.querySelectorAll<HTMLElement>(menuSelector)].filter(element => painted(element));
    const requested = options.placement ?? anchor.dataset.tooltipPlacement;
    const placement = requested === 'top' || requested === 'bottom' || requested === 'left' || requested === 'right' ? requested : undefined;
    // Explicit menu-item hints belong to the small control, not its containing menu.
    const obstacles: Bounds[] = menus.filter(menu => !placement || !menu.contains(anchor)).map(menu => menu.getBoundingClientRect());
    const menuOwner = anchor.closest('.heading-wrapper, .table-wrapper, .preview-export-control, .preview-select-control, .changes-review-control, [data-hover-menu]') ?? anchor.parentElement;
    const blocked = new Set<TooltipPlacement>();
    for (const menu of menus) {
      if (menu.contains(anchor) || !menuOwner?.contains(menu)) continue;
      const rect = menu.getBoundingClientRect();
      const dx = (rect.left + rect.right - bounds.left - bounds.right) / 2;
      const dy = (rect.top + rect.bottom - bounds.top - bounds.bottom) / 2;
      blocked.add(rect.top >= bounds.bottom - 1 ? 'bottom' : rect.bottom <= bounds.top + 1 ? 'top' : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top'));
      // Protect the gap used to enter the menu, without blocking neighboring toolbar controls.
      if (rect.top >= bounds.bottom) obstacles.push({ left: Math.max(rect.left, bounds.left), right: Math.min(rect.right, bounds.right), top: bounds.bottom, bottom: rect.top });
      else if (rect.bottom <= bounds.top) obstacles.push({ left: Math.max(rect.left, bounds.left), right: Math.min(rect.right, bounds.right), top: rect.bottom, bottom: bounds.top });
      else if (rect.left >= bounds.right) obstacles.push({ left: bounds.right, right: rect.left, top: Math.max(rect.top, bounds.top), bottom: Math.min(rect.bottom, bounds.bottom) });
      else if (rect.right <= bounds.left) obstacles.push({ left: rect.right, right: bounds.left, top: Math.max(rect.top, bounds.top), bottom: Math.min(rect.bottom, bounds.bottom) });
    }
    const x = Math.max(area.left, Math.min((bounds.left + bounds.right - hint.width) / 2, area.right - hint.width));
    const y = Math.max(area.top, Math.min((bounds.top + bounds.bottom - hint.height) / 2, area.bottom - hint.height));
    const enclosing = placement ? [] : menus.filter(menu => menu.contains(anchor)).map(menu => menu.getBoundingClientRect());
    const outer = { left: Math.min(bounds.left, ...enclosing.map(rect => rect.left)), right: Math.max(bounds.right, ...enclosing.map(rect => rect.right)),
      top: Math.min(bounds.top, ...enclosing.map(rect => rect.top)), bottom: Math.max(bounds.bottom, ...enclosing.map(rect => rect.bottom)) };
    const candidates: Record<TooltipPlacement, { left: number; top: number }> = {
      top: { left: x, top: outer.top - hint.height - gap },
      bottom: { left: x, top: outer.bottom + gap },
      right: { left: outer.right + gap, top: y },
      left: { left: outer.left - hint.width - gap, top: y }
    };
    const sides: readonly TooltipPlacement[] = ['top', 'bottom', 'right', 'left'];
    const opposite: Record<TooltipPlacement, TooltipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const ordered: readonly TooltipPlacement[] = placement ? [placement, opposite[placement], ...sides.filter(side => side !== placement && side !== opposite[placement])] : sides;
    for (const side of ordered) {
      const candidate = candidates[side];
      const rect = { left: candidate.left, top: candidate.top, right: candidate.left + hint.width, bottom: candidate.top + hint.height };
      if (blocked.has(side) || rect.left < area.left || rect.right > area.right || rect.top < area.top || rect.bottom > area.bottom || obstacles.some(obstacle => intersects(rect, obstacle))) continue;
      tooltip.style.left = rect.left + 'px'; tooltip.style.top = rect.top + 'px';
      tooltip.dataset.side = side;
      return;
    }
    hide();
  }

  function reveal() {
    if (disposed) return;
    if (activeTooltip !== handle) { activeTooltip?.hide(); activeTooltip = handle; }
    clearTimeout(timer); timer = undefined;
    visible = true;
    position();
    if (!visible) return;
    tooltip.classList.add('is-visible');
    view.addEventListener('resize', position);
    view.addEventListener('scroll', position, { capture: true, passive: true });
  }

  function show() {
    if (disposed) return;
    engaged = true;
    if (activeTooltip !== handle) { activeTooltip?.hide(); activeTooltip = handle; }
    clearTimeout(timer);
    timer = setTimeout(reveal, 200);
  }

  function pointerDown(event: PointerEvent) {
    const live = options.liveUpdate ?? anchor.dataset.tooltipLiveUpdate === 'true';
    if (live && event.button === 0 && event.target instanceof view.Node && focusTarget.contains(event.target)) {
      // Keep an existing hint stable; a pending hint waits for the committed state.
      clearTimeout(timer); timer = undefined;
    } else hide();
  }

  function hide() {
    clearTimeout(timer); timer = undefined; visible = false; engaged = false;
    tooltip.classList.remove('is-visible');
    view.removeEventListener('resize', position); view.removeEventListener('scroll', position, true);
    if (activeTooltip === handle) activeTooltip = undefined;
  }

  function setContent(next: TooltipContent) {
    if (disposed) return;
    const changed = content.text !== next.text || content.shortcut !== next.shortcut || content.kind !== next.kind;
    content = next;
    if (label.textContent !== content.text) label.textContent = content.text;
    if (shortcut.textContent !== (content.shortcut ?? '')) shortcut.textContent = content.shortcut ?? '';
    if (shortcut.hidden !== !content.shortcut) shortcut.hidden = !content.shortcut;
    tooltip.classList.toggle('meo-tooltip--shortcut', !!content.shortcut);
    const live = options.liveUpdate ?? anchor.dataset.tooltipLiveUpdate === 'true';
    if (live && changed && engaged) {
      // Reparenting a mode toolbar can temporarily clear :hover before the
      // browser reconciles its pointer target; the hover session remains valid.
      if (hovering || focusTarget.matches(':focus-visible')) reveal();
      else hide();
    } else position();
  }

  anchor.addEventListener('mouseenter', () => { hovering = true; show(); }, { signal: events.signal });
  anchor.addEventListener('mouseleave', () => { hovering = false; if (!focusTarget.matches(':focus-visible')) hide(); }, { signal: events.signal });
  focusTarget.addEventListener('focus', () => { if (focusTarget.matches(':focus-visible')) show(); }, { signal: events.signal });
  focusTarget.addEventListener('blur', () => { if (!hovering) hide(); }, { signal: events.signal });
  focusTarget.addEventListener('pointerdown', pointerDown, { signal: events.signal });
  focusTarget.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Tab') hide(); }, { signal: events.signal });
  setContent(content);
  return {
    show, hide, setContent,
    isHovered: () => hovering,
    dispose() {
      if (disposed) return;
      disposed = true; hide(); events.abort(); tooltip.remove(); ownedAnchors.delete(anchor);
      const remaining = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (remaining.length) focusTarget.setAttribute('aria-describedby', remaining.join(' '));
      else focusTarget.removeAttribute('aria-describedby');
    }
  };
}

/**
 * Bootstrap-owned binding for data-tooltip, optional data-tooltip-shortcut and
 * data-tooltip-kind="fulltext|description", data-tooltip-placement="top|bottom|left|right",
 * and data-tooltip-live-update="true" for stateful controls.
 * Explicit placement uses the control's own anchor. Full-text reveals only clipped text.
 * Generated controls supply metadata; authored title attributes retain their meaning.
 */
export function bindTooltips(root: HTMLElement) {
  const doc = root.ownerDocument, view = doc.defaultView!;
  const events = new view.AbortController();
  let current: { anchor: HTMLElement; hint: ReturnType<typeof createTooltip> } | undefined;
  const ariaOwned = new WeakSet<HTMLElement>();
  const frames = new Map<HTMLIFrameElement, { doc: Document | null; dispose?: () => void }>();
  const conflicts = new WeakSet<HTMLElement>();
  const ignored = '.find-clear-button, .find-close-button, .outline-close-button, .editor-notice-close, .meo-hex-color-adjustment-close';

  function prepare(element: HTMLElement) {
    if (element.dataset.tooltip && element.matches('button, [role="button"]') && (!element.hasAttribute('aria-label') || ariaOwned.has(element))) {
      if (!element.textContent?.trim()) { element.setAttribute('aria-label', element.dataset.tooltip); ariaOwned.add(element); }
    }
  }

  function contentFor(element: HTMLElement): TooltipContent | null {
    if (element.matches(ignored) || element.closest('[inert]')) return null;
    const text = element.dataset.tooltip?.trim();
    if (!text) return null;
    const kind = element.dataset.tooltipKind;
    const key = element.dataset.tooltipShortcut;
    if (kind === 'fulltext' && element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) return null;
    if (key && (kind === 'fulltext' || kind === 'description' || /[\r\n]/.test(text))) {
      if (!conflicts.has(element)) { conflicts.add(element); console.warn('[MEO tooltip] Full-text / multiline content with a shortcut needs review.', { text, shortcut: key, element }); }
      return null;
    }
    if (kind === 'fulltext' || kind === 'description') return { text, kind };
    if (element.textContent?.trim().replace(/\s+/g, ' ') === text.replace(/\s+/g, ' ')) return null;
    return { text, shortcut: key || undefined };
  }

  function fromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof view.Element)) return null;
    const element = target.closest<HTMLElement>('[data-tooltip], [title]');
    if (!element || !root.contains(element) || element.tagName === 'IFRAME' || (ownedAnchors.has(element) && current?.anchor !== element)) return null;
    if (element.hasAttribute('title')) {
      // Authored HTML titles are content; they are displayed through the same bubble.
      element.dataset.tooltip = element.getAttribute('title') ?? '';
      element.dataset.tooltipKind = 'description';
      element.removeAttribute('title');
    }
    return element;
  }

  function enter(event: Event) {
    const anchor = fromTarget(event.target);
    // A pointer-driven mode switch may focus its source editor while the same
    // live-update button remains under the pointer. Keep that hint's ownership.
    if (event.type === 'focusin' && current?.anchor.dataset.tooltipLiveUpdate === 'true'
      && current.hint.isHovered() && (!anchor || !anchor.matches(':focus-visible'))) return;
    if (!anchor) { current?.hint.dispose(); current = undefined; return; }
    const content = contentFor(anchor);
    if (!content) { current?.hint.dispose(); current = undefined; return; }
    if (current?.anchor === anchor) return;
    current?.hint.dispose(); prepare(anchor);
    current = { anchor, hint: createTooltip(anchor, { content }) };
    if (event.type !== 'focusin' || anchor.matches(':focus-visible')) current.hint.show();
  }

  function sharedStyles(source: Document): string {
    const visit = (rules: CSSRuleList): string[] => [...rules].flatMap(rule => {
      if ('selectorText' in rule) return String(rule.selectorText).includes('.meo-tooltip') ? [rule.cssText] : [];
      if ('cssRules' in rule) {
        const nested = visit(rule.cssRules as CSSRuleList);
        return nested.length ? [rule.cssText.slice(0, rule.cssText.indexOf('{')) + '{' + nested.join('\n') + '}'] : [];
      }
      return [];
    });
    return [...source.styleSheets].flatMap(sheet => { try { return visit(sheet.cssRules); } catch { return []; } }).join('\n');
  }

  function bindFrame(frame: HTMLIFrameElement) {
    let state = frames.get(frame);
    if (!state) {
      state = { doc: null }; frames.set(frame, state);
      frame.addEventListener('load', () => bindFrame(frame), { signal: events.signal });
    }
    let child: Document | null;
    try { child = frame.contentDocument; } catch { return; }
    if (!child?.body || state.doc === child) return;
    state.dispose?.(); state.doc = child;
    const styles = child.createElement('style'); styles.dataset.meoTooltipStyle = '';
    // Keep tooltip UI appearance separate from Preview's own document theme and fonts.
    styles.textContent = sharedStyles(doc).replaceAll('data-editor-appearance', 'data-meo-tooltip-appearance'); child.head.append(styles);
    child.documentElement.dataset.meoTooltipAppearance = doc.documentElement.dataset.meoTooltipAppearance ?? doc.documentElement.dataset.editorAppearance ?? 'light';
    const binding = bindTooltips(child.body);
    state.dispose = () => { binding.dispose(); styles.remove(); };
  }

  function scan(node: Node) {
    if (!(node instanceof view.HTMLElement)) return;
    if (node.hasAttribute('data-tooltip')) prepare(node);
    for (const element of node.querySelectorAll<HTMLElement>('[data-tooltip]')) prepare(element);
    if (node.tagName === 'IFRAME') bindFrame(node as HTMLIFrameElement);
    for (const frame of node.querySelectorAll<HTMLIFrameElement>('iframe')) bindFrame(frame);
  }

  const observer = new view.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) scan(node);
      else if (record.target instanceof view.HTMLElement) prepare(record.target);
    }
    for (const [frame, state] of frames) {
      if (!frame.isConnected) { state.dispose?.(); frames.delete(frame); }
      else if (state.doc) state.doc.documentElement.dataset.meoTooltipAppearance = doc.documentElement.dataset.meoTooltipAppearance ?? doc.documentElement.dataset.editorAppearance ?? 'light';
    }
    if (current) {
      const content = contentFor(current.anchor);
      if (!content || !painted(current.anchor)) { current.hint.dispose(); current = undefined; }
      else current.hint.setContent(content);
    }
    activeTooltip?.reposition();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tooltip', 'data-tooltip-shortcut', 'data-tooltip-kind', 'data-tooltip-placement', 'data-tooltip-live-update', 'hidden', 'open'] });
  const appearance = new view.MutationObserver(() => {
    for (const state of frames.values()) if (state.doc) state.doc.documentElement.dataset.meoTooltipAppearance = doc.documentElement.dataset.meoTooltipAppearance ?? doc.documentElement.dataset.editorAppearance ?? 'light';
  });
  appearance.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-editor-appearance', 'data-meo-tooltip-appearance'] });
  root.addEventListener('pointerover', enter, { signal: events.signal });
  root.addEventListener('focusin', enter, { signal: events.signal });
  root.addEventListener('pointerdown', event => activeTooltip?.pointerDown(event), { capture: true, signal: events.signal });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Tab') activeTooltip?.hide(); }, { capture: true, signal: events.signal });
  view.addEventListener('blur', () => activeTooltip?.hide(), { signal: events.signal });
  view.addEventListener('scroll', () => activeTooltip?.reposition(), { capture: true, passive: true, signal: events.signal });
  view.addEventListener('resize', () => activeTooltip?.reposition(), { signal: events.signal });
  scan(root);
  return {
    dispose() {
      events.abort(); observer.disconnect(); appearance.disconnect(); current?.hint.dispose();
      for (const state of frames.values()) state.dispose?.(); frames.clear();
    }
  };
}
