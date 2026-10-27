import { getUiStrings } from '../application/uiLanguage';
import { formatLinkDestination } from '../../../src/foundation/linkDestination';
import { createElement as createIconElement, Info } from 'lucide';

export type TooltipContent =
  | { readonly text: string; readonly shortcut?: string; readonly kind?: 'hint' }
  | { readonly text: string; readonly shortcut?: never; readonly kind: 'fulltext' | 'link' }
  | { readonly text: string; readonly shortcut?: never; readonly kind: 'description';
      readonly rows?: readonly { readonly label: string; readonly value: string }[];
      readonly error?: { readonly title: string; readonly text: string } };

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type TooltipPositioning = 'element' | 'pointer';

type Bounds = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };
type Dismissal = 'leave' | 'dismiss';
let nextTooltipId = 0;
let activeTooltip: { hide(reason?: Dismissal): void; reposition(): void; pointerDown(event: PointerEvent): void } | undefined;
// One module clock keeps parent and Preview frame time origins out of the sequence.
let hoverReadyUntil = 0;
const ownedAnchors = new WeakMap<HTMLElement, 'automatic' | 'manual'>();
const textMeasurementContexts = new WeakMap<Document, CanvasRenderingContext2D | null>();
const menuSelector = '.heading-dropdown, .table-dropdown, .preview-dropdown-panel, .preview-options-panel, .source-preview-more-panel, [role="menu"], .changes-review-popover, .meo-md-html-table-context-menu';
const modalSelector = 'dialog[open], .meo-md-image-fullscreen-scrim, .meo-mermaid-fullscreen-scrim, .meo-latex-math-fullscreen-scrim';
const keyboardFocusSelector = ':focus-visible:not([data-meo-pointer-focus])';
const intersects = (a: Bounds, b: Bounds) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function painted(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView!;
  if (!element.isConnected || !element.getClientRects().length) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (parent.hidden || parent.inert || style.visibility === 'hidden' || style.display === 'none') return false;
    // Hover controls can still be at zero opacity when their fade-in has just started.
    if (Number(style.opacity) === 0 && !parent.getAnimations().some(animation => animation instanceof view.CSSTransition
      && animation.transitionProperty === 'opacity' && Number((animation.effect as KeyframeEffect | null)?.getKeyframes().at(-1)?.opacity) > 0)) return false;
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

/** Fit the actual wrapped glyphs; font leading must not determine visual centering. */
function fitTooltipText(text: HTMLElement, minimumLineHeight: number): number {
  const doc = text.ownerDocument, view = doc.defaultView!;
  text.style.height = ''; text.style.transform = '';
  const node = text.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return 0;
  const range = doc.createRange();
  const lines = new Map<number, { left: number; right: number; text: string }>();
  let offset = 0;
  // DOM ranges retain the browser's real wrapping, bidi layout and fallback fonts.
  for (const character of node.textContent ?? '') {
    range.setStart(node, offset); offset += character.length; range.setEnd(node, offset);
    if (character === '\n' || character === '\r') continue;
    const rect = range.getBoundingClientRect();
    const line = lines.get(rect.top);
    lines.set(rect.top, { left: Math.min(line?.left ?? rect.left, rect.left), right: Math.max(line?.right ?? rect.right, rect.right), text: (line?.text ?? '') + character });
  }
  const width = Math.max(0, ...[...lines.values()].map(line => line.right - line.left));
  let context = textMeasurementContexts.get(doc);
  if (context === undefined) { context = doc.createElement('canvas').getContext('2d'); textMeasurementContexts.set(doc, context); }
  if (!context || !lines.size) return width;
  const style = view.getComputedStyle(text);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.textBaseline = 'alphabetic';
  // Reuse the inline probe: inserting it during layout would retrigger bindTooltips' observer.
  const probe = text.firstElementChild!;
  const baselineOffset = probe.getBoundingClientRect().top - Math.max(...lines.keys());
  let inkTop = Infinity, inkBottom = -Infinity, lineInkHeight = 0;
  for (const [top, line] of lines) {
    const metrics = context.measureText(line.text);
    if (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent <= 0) continue;
    lineInkHeight = Math.max(lineInkHeight, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    inkTop = Math.min(inkTop, top + baselineOffset - metrics.actualBoundingBoxAscent);
    inkBottom = Math.max(inkBottom, top + baselineOffset + metrics.actualBoundingBoxDescent);
  }
  if (inkBottom > inkTop) {
    const leading = inkTop - text.getBoundingClientRect().top;
    // Retain the breathing room supplied by a button hint's minimum height, even after wrapping.
    const inset = Math.max(0, (minimumLineHeight - lineInkHeight) / 2);
    text.style.height = inkBottom - inkTop + inset * 2 + 'px';
    text.style.transform = `translateY(${inset - leading}px)`;
  }
  return width;
}

/**
 * One shared hint: 200ms hover/focus, above/below/right/left placement, menu avoidance.
 * After a shown pointer hint, another hover within 500ms of leaving skips the wait.
 * Explicit dismissal and owner disposal end the sequence; only hover handoff keeps it.
 * Immediate hints skip the hover/focus wait for menus that show details as the target changes.
 * Optional placement prefers that side, then its opposite, while keeping the hint visible.
 * Side alignment can match the anchor's top edge; other hints stay centered.
 * List full-text hints prefer right/left outside the list, aligned with the target row.
 * Pointer positioning defaults right; keyboard focus uses the element. Forwarded
 * input uses ownerDocument client coordinates in show / setPointerPosition.
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
  readonly sideAlign?: 'start' | 'center';
  readonly positioning?: TooltipPositioning;
  readonly liveUpdate?: boolean;
  readonly immediate?: boolean;
  /** The owner drives selection and dismissal; pointer/focus listeners are not installed. */
  readonly manual?: boolean;
}) {
  const doc = anchor.ownerDocument, view = doc.defaultView!;
  let focusTarget = options.focusTarget ?? anchor;
  const tooltip = doc.createElement('span');
  tooltip.id = options.id ?? 'meo-tooltip-' + ++nextTooltipId;
  tooltip.className = 'meo-tooltip';
  tooltip.classList.toggle('meo-tooltip--window', !!anchor.closest('.mode-toolbar, .find-panel, .source-preview-toolbar, .preview-dropdown-panel, .preview-options-panel, .source-preview-more-panel, dialog'));
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
  const labelText = doc.createElement('span'); labelText.className = 'meo-tooltip-text'; label.append(labelText);
  const labelContent = doc.createTextNode('');
  // Keep the probe in place; measuring must not mutate the observed DOM.
  const probe = doc.createElement('span'); probe.className = 'meo-tooltip-baseline';
  labelText.append(labelContent, probe);
  const details = doc.createElement('div'); details.className = 'meo-tooltip-details'; details.hidden = true;
  const errorDetails = doc.createElement('div'); errorDetails.className = 'meo-tooltip-error'; errorDetails.hidden = true;
  tooltip.append(label, shortcut, details, errorDetails);
  // Portal outside scrolling content, while staying inside native modal / fullscreen ownership.
  const portal = anchor.closest<HTMLElement>(modalSelector) ?? doc.fullscreenElement ?? doc.body;
  portal.append(tooltip);
  anchor.removeAttribute('title'); focusTarget.removeAttribute('title');
  const descriptions = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  focusTarget.setAttribute('aria-describedby', [...descriptions, tooltip.id].join(' '));
  ownedAnchors.set(anchor, options.manual ? 'manual' : 'automatic');
  const events = new view.AbortController();
  let content = options.content;
  let hovering = anchor.matches(':hover'), visible = false, disposed = false;
  let engaged = false;
  let pointerSession = false;
  let revealAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let positionFrame: number | undefined;
  let pointerFrame: number | undefined;
  let pointer: Point | undefined;
  let reportedConflict = '';
  const handle = { hide, reposition: position, pointerDown };

  function pointerPositioning() {
    return (options.positioning ?? anchor.dataset.tooltipPositioning) === 'pointer';
  }

  function setPointerPosition(point?: Point) {
    pointer = point;
    if (!visible || !pointerPositioning() || pointerFrame !== undefined) return;
    pointerFrame = view.requestAnimationFrame(() => {
      pointerFrame = undefined;
      position();
    });
  }

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
    tooltip.classList.toggle('meo-tooltip--window', !!anchor.closest('.mode-toolbar, .find-panel, .source-preview-toolbar, .preview-dropdown-panel, .preview-options-panel, .source-preview-more-panel, dialog'));
    const container = modal?.getBoundingClientRect();
    const margin = 4, gap = 6;
    const area: Bounds = { left: Math.max(viewport.left, container?.left ?? viewport.left) + margin, top: Math.max(viewport.top, container?.top ?? viewport.top) + margin,
      right: Math.min(viewport.right, container?.right ?? viewport.right) - margin, bottom: Math.min(viewport.bottom, container?.bottom ?? viewport.bottom) - margin };
    const bounds = visibleBounds(anchor, area);
    if (!bounds) { hide(); return; }
    const point = pointerPositioning() ? pointer : undefined;
    // Scrolling can move a large hit surface away from a stationary pointer.
    if (point && (point.x < viewport.left || point.x > viewport.right || point.y < viewport.top || point.y > viewport.bottom
      || !anchor.contains(doc.elementFromPoint(point.x, point.y)))) { hide(); return; }
    tooltip.style.width = '';
    tooltip.style.maxWidth = '';
    tooltip.classList.toggle('meo-tooltip--wrap', content.kind === 'fulltext' || content.kind === 'description' || content.kind === 'link');
    tooltip.classList.toggle('meo-tooltip--link', content.kind === 'link');
    if (content.shortcut && ((content.kind && content.kind !== 'hint') || /[\r\n]/.test(content.text))) { reportConflict(); return; }
    let hint = tooltip.getBoundingClientRect();
    if (hint.width > area.right - area.left) {
      if (content.shortcut) { reportConflict(); return; }
      tooltip.classList.add('meo-tooltip--wrap');
      tooltip.style.maxWidth = Math.max(0, area.right - area.left) + 'px';
      hint = tooltip.getBoundingClientRect();
    }
    if (tooltip.classList.contains('meo-tooltip--wrap')) {
      // Only wrapping hints need glyph measurement; ordinary button / shortcut layout stays unchanged.
      const style = view.getComputedStyle(tooltip);
      const minimumLineHeight = Math.max(0, (Number.parseFloat(style.minHeight) || 0)
        - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom));
      const contentWidth = fitTooltipText(labelText, minimumLineHeight);
      hint = tooltip.getBoundingClientRect();
      if (!tooltip.classList.contains('meo-tooltip--details')) {
        const fittedWidth = Math.ceil(contentWidth + hint.width - label.getBoundingClientRect().width);
        if (fittedWidth < hint.width) {
          tooltip.style.width = fittedWidth + 'px';
          fitTooltipText(labelText, minimumLineHeight);
          hint = tooltip.getBoundingClientRect();
        }
      }
    }
    const menus = [...doc.querySelectorAll<HTMLElement>(menuSelector)].filter(element => painted(element));
    const requested = options.placement ?? anchor.dataset.tooltipPlacement;
    const placement = requested === 'top' || requested === 'bottom' || requested === 'left' || requested === 'right' ? requested : undefined;
    const list = !placement && !point && content.kind === 'fulltext'
      ? anchor.closest('.outline-sidebar, .meo-input-suggestions')?.getBoundingClientRect() : undefined;
    // Explicit menu-item hints belong to the small control, not its containing menu.
    const obstacles: Bounds[] = menus.filter(menu => (!placement && !point) || !menu.contains(anchor)).map(menu => menu.getBoundingClientRect());
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
    const y = Math.max(area.top, Math.min(options.sideAlign === 'start' ? bounds.top : (bounds.top + bounds.bottom - hint.height) / 2, area.bottom - hint.height));
    const enclosing = placement && anchor.getAttribute('role') !== 'option' ? [] : menus.filter(menu => menu.contains(anchor)).map(menu => menu.getBoundingClientRect());
    const outer = { left: Math.min(bounds.left, list?.left ?? bounds.left, ...enclosing.map(rect => rect.left)), right: Math.max(bounds.right, list?.right ?? bounds.right, ...enclosing.map(rect => rect.right)),
      top: Math.min(bounds.top, ...enclosing.map(rect => rect.top)), bottom: Math.max(bounds.bottom, ...enclosing.map(rect => rect.bottom)) };
    const pointerX = point ? Math.max(area.left, Math.min(point.x + 12, area.right - hint.width)) : x;
    const pointerY = point ? Math.max(area.top, Math.min(point.y + 8, area.bottom - hint.height)) : y;
    const candidates: Record<TooltipPlacement, { left: number; top: number }> = point ? {
      right: { left: point.x + 12, top: pointerY },
      left: { left: point.x - hint.width - 12, top: pointerY },
      top: { left: pointerX, top: point.y - hint.height - 12 },
      bottom: { left: pointerX, top: point.y + 12 }
    } : {
      top: { left: x, top: outer.top - hint.height - gap },
      bottom: { left: x, top: outer.bottom + gap },
      right: { left: outer.right + gap, top: y },
      left: { left: outer.left - hint.width - gap, top: y }
    };
    const sides: readonly TooltipPlacement[] = ['top', 'bottom', 'right', 'left'];
    const opposite: Record<TooltipPlacement, TooltipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const preferred = placement ?? (point || list ? 'right' : undefined);
    const ordered: readonly TooltipPlacement[] = preferred ? [preferred, opposite[preferred], ...sides.filter(side => side !== preferred && side !== opposite[preferred])] : sides;
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
    clearPositionFrame();
    visible = true;
    position();
    if (!visible) return;
    tooltip.classList.remove('is-pending');
    tooltip.classList.add('is-visible');
    view.addEventListener('resize', position);
    view.addEventListener('scroll', position, { capture: true, passive: true });
  }

  function show(point?: Point) {
    setPointerPosition(point);
    if (disposed || timer !== undefined || visible) return;
    engaged = true;
    pointerSession = point !== undefined;
    if (!pointerSession) hoverReadyUntil = 0;
    if (activeTooltip !== handle) { activeTooltip?.hide(pointerSession ? 'leave' : 'dismiss'); activeTooltip = handle; }
    const started = view.performance.now();
    if (options.immediate || (pointerSession && performance.now() < hoverReadyUntil)) {
      revealAt = started;
      reveal();
      return;
    }
    revealAt = started + 200;
    // Prepare after hover styles settle. The compositor can finish the wait
    // even while a diagram's synchronous rendering blocks JavaScript.
    positionFrame = view.requestAnimationFrame(() => {
      positionFrame = undefined;
      if (disposed || !engaged) return;
      visible = true;
      position();
      if (!visible) return;
      tooltip.classList.add('is-pending');
      // Keep the deadline tied to input even if style/animation setup runs late.
      const animation = tooltip.getAnimations()[0];
      if (animation) animation.startTime = started;
      view.addEventListener('resize', position);
      view.addEventListener('scroll', position, { capture: true, passive: true });
    });
    timer = setTimeout(reveal, 200);
  }

  function clearPositionFrame() {
    if (positionFrame !== undefined) view.cancelAnimationFrame(positionFrame);
    positionFrame = undefined;
  }

  function pointerDown(event: PointerEvent) {
    // A disabled control has no action to dismiss its explanation.
    if (event.button === 0 && event.target instanceof view.Element && anchor.contains(event.target)
      && (anchor.matches(':disabled, [aria-disabled="true"]')
        || event.target.closest(':disabled, [aria-disabled="true"]'))) return;
    hoverReadyUntil = 0; pointerSession = false;
    const live = options.liveUpdate ?? anchor.dataset.tooltipLiveUpdate === 'true';
    if (live && event.button === 0 && event.target instanceof view.Node && focusTarget.contains(event.target)) {
      // Keep an existing hint stable; a pending hint waits for the committed state.
      clearTimeout(timer); timer = undefined;
      clearPositionFrame();
      if (tooltip.classList.contains('is-pending')) {
        // Animated computed styles can lag the compositor; our deadline owns phase.
        const shown = view.performance.now() >= revealAt;
        tooltip.classList.remove('is-pending');
        if (shown) tooltip.classList.add('is-visible');
        else {
          visible = false;
          view.removeEventListener('resize', position);
          view.removeEventListener('scroll', position, true);
        }
      }
    } else hide();
  }

  function hide(reason: Dismissal = 'dismiss') {
    if (reason === 'leave') {
      // Prepared DOM is still hidden until the compositor's reveal deadline.
      if (pointerSession && visible && painted(anchor) && (tooltip.classList.contains('is-visible')
        || (tooltip.classList.contains('is-pending') && view.performance.now() >= revealAt))) hoverReadyUntil = performance.now() + 500;
    } else hoverReadyUntil = 0;
    pointerSession = false;
    clearTimeout(timer); timer = undefined; visible = false; engaged = false; revealAt = 0;
    clearPositionFrame();
    if (pointerFrame !== undefined) view.cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined; pointer = undefined;
    tooltip.classList.remove('is-pending', 'is-visible');
    view.removeEventListener('resize', position); view.removeEventListener('scroll', position, true);
    if (activeTooltip === handle) activeTooltip = undefined;
  }

  function setContent(next: TooltipContent) {
    if (disposed) return;
    const previousDetails = content.kind === 'description' ? [content.rows, content.error] : [];
    const nextDetails = next.kind === 'description' ? [next.rows, next.error] : [];
    const detailsChanged = JSON.stringify(previousDetails) !== JSON.stringify(nextDetails);
    const changed = content.text !== next.text || content.shortcut !== next.shortcut || content.kind !== next.kind || detailsChanged;
    content = next;
    // Preview document language can differ from the tooltip UI language.
    const language = doc.documentElement.dataset.meoTooltipLanguage ?? doc.documentElement.lang;
    if (tooltip.lang !== language) tooltip.lang = language;
    if (labelContent.data !== content.text) labelContent.data = content.text;
    if (shortcut.textContent !== (content.shortcut ?? '')) shortcut.textContent = content.shortcut ?? '';
    if (shortcut.hidden !== !content.shortcut) shortcut.hidden = !content.shortcut;
    tooltip.classList.toggle('meo-tooltip--shortcut', !!content.shortcut);
    const rows = content.kind === 'description' ? content.rows ?? [] : [];
    const error = content.kind === 'description' ? content.error : undefined;
    tooltip.classList.toggle('meo-tooltip--details', rows.length > 0 || !!error);
    if (details.hidden !== (rows.length === 0)) details.hidden = rows.length === 0;
    if (errorDetails.hidden !== !error) errorDetails.hidden = !error;
    if (detailsChanged) {
      details.replaceChildren();
      if (rows.length) {
        const list = doc.createElement('dl');
        for (const row of rows) {
          const name = doc.createElement('dt'); name.textContent = row.label;
          const value = doc.createElement('dd'); value.textContent = row.value;
          list.append(name, value);
        }
        details.append(doc.createElement('hr'), list);
      }
      errorDetails.replaceChildren();
      if (error) {
        const title = doc.createElement('strong'); title.textContent = error.title;
        title.prepend(createIconElement(Info, { width: 14, height: 14, class: 'meo-tooltip-error-icon', 'aria-hidden': 'true' }));
        const text = doc.createElement('span'); text.textContent = error.text;
        errorDetails.append(doc.createElement('hr'), title, text);
      }
    }
    const live = options.liveUpdate ?? anchor.dataset.tooltipLiveUpdate === 'true';
    if (live && changed && engaged) {
      // Reparenting a mode toolbar can temporarily clear :hover before the
      // browser reconciles its pointer target; the hover session remains valid.
      if (hovering || focusTarget.matches(keyboardFocusSelector)) reveal();
      else hide();
    } else if (changed || !pointerPositioning()) position();
  }

  if (!options.manual) {
    anchor.addEventListener('mouseenter', event => { hovering = true; show({ x: event.clientX, y: event.clientY }); }, { signal: events.signal });
    anchor.addEventListener('pointermove', event => {
      if (event.pointerType !== 'touch') setPointerPosition({ x: event.clientX, y: event.clientY });
    }, { signal: events.signal });
    anchor.addEventListener('mouseleave', () => { hovering = false; if (!focusTarget.matches(keyboardFocusSelector)) hide('leave'); else setPointerPosition(); }, { signal: events.signal });
    focusTarget.addEventListener('focus', () => { if (focusTarget.matches(keyboardFocusSelector)) show(); }, { signal: events.signal });
    focusTarget.addEventListener('blur', () => { if (!hovering) hide(); }, { signal: events.signal });
    focusTarget.addEventListener('pointerdown', pointerDown, { signal: events.signal });
    focusTarget.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Tab') hide(); }, { signal: events.signal });
  }
  view.addEventListener('blur', () => hide(), { signal: events.signal });
  setContent(content);
  return {
    show, hide, setContent, setPointerPosition,
    /** Moving a manually owned tooltip retains its content surface and reveal state. */
    setAnchor(next: HTMLElement) {
      if (!options.manual || disposed || next === anchor) return;
      const remaining = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (remaining.length) focusTarget.setAttribute('aria-describedby', remaining.join(' ')); else focusTarget.removeAttribute('aria-describedby');
      ownedAnchors.delete(anchor); anchor = next; ownedAnchors.set(anchor, 'manual');
      focusTarget = options.focusTarget ?? anchor;
      const ids = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      focusTarget.setAttribute('aria-describedby', [...ids, tooltip.id].join(' '));
    },
    isHovered: () => hovering,
    dispose(reason: Dismissal = 'dismiss') {
      if (disposed) return;
      disposed = true; hide(reason); events.abort(); tooltip.remove(); ownedAnchors.delete(anchor);
      const remaining = (focusTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (remaining.length) focusTarget.setAttribute('aria-describedby', remaining.join(' '));
      else focusTarget.removeAttribute('aria-describedby');
    }
  };
}

/**
 * Bootstrap-owned binding for data-tooltip, optional data-tooltip-command / data-tooltip-shortcut and
 * data-tooltip-kind="fulltext|description", data-tooltip-placement="top|bottom|left|right",
 * data-tooltip-positioning="element|pointer" (element by default),
 * and data-tooltip-live-update="true" for stateful controls.
 * Explicit placement uses the control's own anchor. Full-text reveals only clipped text.
 * Generated controls supply metadata; links show their destination and any authored title.
 * Bootstrap supplies editableLinkHrefAtPoint for editor-owned text and cell drafts;
 * it resolves only pointer/key/input interactions, without committing an edit.
 * Command controls resolve their first effective binding through shortcutForCommand.
 * Call refreshShortcuts after preferences change; newly mounted controls resolve on scan.
 */
export function bindTooltips(root: HTMLElement, options: {
  readonly editableLinkHrefAtPoint?: (point: { x: number; y: number }) => string;
  readonly shortcutForCommand?: (command: string) => string | undefined;
} = {}) {
  const doc = root.ownerDocument, view = doc.defaultView!;
  const events = new view.AbortController();
  let current: { anchor: HTMLElement; hint: ReturnType<typeof createTooltip>; editableHref?: string } | undefined;
  const ariaOwned = new WeakSet<HTMLElement>();
  const frames = new Map<HTMLIFrameElement, { doc: Document | null; dispose?: () => void }>();
  const conflicts = new WeakSet<HTMLElement>();
  let pointer: { x: number; y: number } | undefined;
  let linkModifier = false;
  const ignored = '.find-clear-button, .find-close-button, .outline-close-button, .editor-notice-close, .meo-hex-color-adjustment-close';

  function prepare(element: HTMLElement) {
    // Normalize authored titles before hover: a title on an outer wrapper can
    // otherwise produce a second native bubble over an inner tooltip owner.
    // Iframe titles name their browsing context for assistive technology.
    if (element.tagName !== 'IFRAME' && element.hasAttribute('title')) {
      element.dataset.tooltip = element.getAttribute('title') ?? '';
      element.dataset.tooltipKind = 'description';
      element.removeAttribute('title');
    }
    if (element.dataset.tooltipCommand && options.shortcutForCommand) {
      const key = options.shortcutForCommand(element.dataset.tooltipCommand);
      if (key) {
        if (element.dataset.tooltipShortcut !== key) element.dataset.tooltipShortcut = key;
      } else if (element.hasAttribute('data-tooltip-shortcut')) element.removeAttribute('data-tooltip-shortcut');
    }
    if (element.dataset.tooltip && element.matches('button, [role="button"]') && (!element.hasAttribute('aria-label') || ariaOwned.has(element))) {
      if (!element.textContent?.trim()) { element.setAttribute('aria-label', element.dataset.tooltip); ariaOwned.add(element); }
    }
  }

  function contentFor(element: HTMLElement, editableHref?: string): TooltipContent | null {
    if (element.matches(ignored) || element.closest('[inert]')) return null;
    const live = element.closest('.cm-editor.meo-mode-live');
    const linkButton = element.hasAttribute('data-tooltip-link-href');
    // An authored title on an image or formatted label must retain its owning
    // link's destination. Independent controls keep their own action hints.
    const parentLink = !element.closest('button, [role="button"], input, textarea, select')
      ? element.parentElement?.closest<HTMLElement>('[data-meo-link-href], [data-meo-preview-href], a[href]') : null;
    const href = (element.getAttribute('data-tooltip-link-href') ?? element.getAttribute('data-meo-link-href') ?? element.getAttribute('data-meo-preview-href')
      ?? (element.tagName === 'A' ? element.getAttribute('href') : null)
      ?? parentLink?.getAttribute('data-meo-link-href') ?? parentLink?.getAttribute('data-meo-preview-href')
      ?? parentLink?.getAttribute('href') ?? editableHref)?.trim();
    if (href && !linkButton && element.closest('.cm-editor.meo-mode-source')) return null;
    if (live && href && !linkButton && !element.closest('.meo-md-image-linked') && !linkModifier) return null;
    const description = element.dataset.tooltip?.trim();
    const parentDescription = (parentLink?.getAttribute('title') ?? parentLink?.dataset.tooltip)?.trim();
    const language = doc.documentElement.dataset.meoTooltipLanguage ?? doc.documentElement.lang;
    const displayHref = href ? formatLinkDestination(href) : '';
    const destination = displayHref ? getUiStrings(language === 'zh-CN' ? 'zh-CN' : 'en').linkDestination(displayHref) : '';
    const descriptions = [...new Set([parentDescription, description].filter(value => value && value !== href))];
    const text = href ? [destination, ...descriptions].join('\n') : description;
    if (!text) return null;
    const kind = href ? 'link' : element.dataset.tooltipKind;
    prepare(element);
    const key = element.dataset.tooltipShortcut;
    if (kind === 'fulltext' && element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) return null;
    if (key && (kind === 'fulltext' || kind === 'description' || kind === 'link' || /[\r\n]/.test(text))) {
      if (!conflicts.has(element)) { conflicts.add(element); console.warn('[MEO tooltip] Full-text / multiline content with a shortcut needs review.', { text, shortcut: key, element }); }
      return null;
    }
    if (kind === 'fulltext' || kind === 'description' || kind === 'link') return { text, kind };
    if (!key && element.textContent?.trim().replace(/\s+/g, ' ') === text.replace(/\s+/g, ' ')) return null;
    return { text, shortcut: key || undefined };
  }

  function refreshCurrent() {
    if (!current) return;
    const content = contentFor(current.anchor, current.editableHref);
    if (!content || !painted(current.anchor)) { current.hint.dispose(); current = undefined; }
    else current.hint.setContent(content);
  }

  function fromTarget(target: EventTarget | null, editableHref?: string): HTMLElement | null {
    if (!(target instanceof view.Element)) return null;
    if (target.closest('.meo-md-link-marker, .meo-md-link-marker-active, .meo-md-link-label-bracket, .meo-md-link-label-bracket-active')) return null;
    if (target.closest('.meo-md-html-table-sticky-header .meo-md-html-table-column-resize-handle')) return null;
    let element = target.closest<HTMLElement>('[data-tooltip], [title], [data-meo-link-href], [data-meo-preview-href], a[href]');
    for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
      if (ownedAnchors.get(parent) === 'manual') return null;
    }
    if (!element && editableHref && target.closest('.cm-editor.meo-mode-live')) {
      element = target.closest<HTMLElement>('textarea, .cm-line');
    }
    if (!element || !root.contains(element) || element.tagName === 'IFRAME' || (ownedAnchors.has(element) && current?.anchor !== element)) return null;
    prepare(element);
    return element;
  }

  function enter(event: Event) {
    if (event instanceof view.PointerEvent) {
      pointer = { x: event.clientX, y: event.clientY };
      linkModifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    }
    // Character measurement can create temporary DOM. Resolve only for input events,
    // never from the mutation observer that watches the resulting tooltip DOM.
    const editableHref = linkModifier && pointer && event.target instanceof view.Element
      && event.target.closest('.cm-editor.meo-mode-live') && !event.target.closest('[data-tooltip-link-href]')
      ? options.editableLinkHrefAtPoint?.(pointer) : undefined;
    const anchor = fromTarget(event.target, editableHref);
    const dismissal = event.type === 'focusin' ? 'dismiss' : 'leave';
    // A pointer-driven mode switch may focus its source editor while the same
    // live-update button remains under the pointer. Keep that hint's ownership.
    if (event.type === 'focusin' && current?.anchor.dataset.tooltipLiveUpdate === 'true'
      && current.hint.isHovered() && (!anchor || !anchor.matches(keyboardFocusSelector))) return;
    if (!anchor) { current?.hint.dispose(dismissal); current = undefined; return; }
    const content = contentFor(anchor, editableHref);
    if (!content) { current?.hint.dispose(dismissal); current = undefined; return; }
    if (current?.anchor === anchor) {
      if (event instanceof view.PointerEvent || event.type === 'focusin') {
        current.hint.setPointerPosition(event instanceof view.PointerEvent && event.pointerType !== 'touch' ? pointer : undefined);
      }
      current.editableHref = editableHref; current.hint.setContent(content); return;
    }
    current?.hint.dispose(dismissal); prepare(anchor);
    // CodeMirror resets attributes on editable marks; describe its stable root instead.
    const focusTarget = anchor.isContentEditable ? anchor.closest<HTMLElement>('.cm-editor') ?? anchor : anchor;
    current = { anchor, hint: createTooltip(anchor, { content, focusTarget }), editableHref };
    if (event.type !== 'focusin' || anchor.matches(keyboardFocusSelector)) current.hint.show(event instanceof view.PointerEvent && event.pointerType !== 'touch' ? pointer : undefined);
  }

  function sharedStyles(source: Document): string {
    const visit = (rules: CSSRuleList): string[] => [...rules].flatMap(rule => {
      if (rule instanceof view.CSSKeyframesRule && rule.name === 'meo-tooltip-reveal') return [rule.cssText];
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
    child.documentElement.dataset.meoTooltipLanguage = doc.documentElement.dataset.meoTooltipLanguage ?? doc.documentElement.lang;
    const binding = bindTooltips(child.body);
    state.dispose = () => { binding.dispose(); styles.remove(); };
  }

  function scan(node: Node) {
    if (!(node instanceof view.HTMLElement)) return;
    if (node.matches('[data-tooltip], [title]')) prepare(node);
    for (const element of node.querySelectorAll<HTMLElement>('[data-tooltip], [title]')) prepare(element);
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
    refreshCurrent();
    activeTooltip?.reposition();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'data-tooltip', 'data-tooltip-link-href', 'data-tooltip-command', 'data-tooltip-shortcut', 'data-tooltip-kind', 'data-tooltip-placement', 'data-tooltip-positioning', 'data-tooltip-live-update', 'data-meo-link-href', 'data-meo-preview-href', 'href', 'hidden', 'open'] });
  const appearance = new view.MutationObserver(() => {
    for (const state of frames.values()) if (state.doc) {
      state.doc.documentElement.dataset.meoTooltipAppearance = doc.documentElement.dataset.meoTooltipAppearance ?? doc.documentElement.dataset.editorAppearance ?? 'light';
      state.doc.documentElement.dataset.meoTooltipLanguage = doc.documentElement.dataset.meoTooltipLanguage ?? doc.documentElement.lang;
    }
    if (current) {
      const content = contentFor(current.anchor, current.editableHref);
      if (content) current.hint.setContent(content);
    }
  });
  appearance.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-editor-appearance', 'data-meo-tooltip-appearance', 'lang', 'data-meo-tooltip-language'] });
  root.addEventListener('pointerover', enter, { signal: events.signal });
  root.addEventListener('pointermove', enter, { signal: events.signal });
  root.addEventListener('input', event => { if (pointer && linkModifier) enter(event); }, { signal: events.signal });
  const modifierChanged = (event: KeyboardEvent) => {
    if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    linkModifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (pointer) enter({ target: doc.elementFromPoint(pointer.x, pointer.y), type: 'modifier' } as Event);
  };
  view.addEventListener('keydown', modifierChanged, { capture: true, signal: events.signal });
  view.addEventListener('keyup', modifierChanged, { capture: true, signal: events.signal });
  root.addEventListener('focusin', enter, { signal: events.signal });
  root.addEventListener('pointerdown', event => { hoverReadyUntil = 0; activeTooltip?.pointerDown(event); }, { capture: true, signal: events.signal });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Tab') { hoverReadyUntil = 0; activeTooltip?.hide(); } }, { capture: true, signal: events.signal });
  view.addEventListener('blur', () => { pointer = undefined; linkModifier = false; hoverReadyUntil = 0; activeTooltip?.hide(); }, { signal: events.signal });
  view.addEventListener('scroll', () => activeTooltip?.reposition(), { capture: true, passive: true, signal: events.signal });
  view.addEventListener('resize', () => activeTooltip?.reposition(), { signal: events.signal });
  scan(root);
  return {
    refreshShortcuts() {
      prepare(root);
      for (const element of root.querySelectorAll<HTMLElement>('[data-tooltip-command]')) prepare(element);
      refreshCurrent();
    },
    dispose() {
      hoverReadyUntil = 0;
      events.abort(); observer.disconnect(); appearance.disconnect(); current?.hint.dispose();
      for (const state of frames.values()) state.dispose?.(); frames.clear();
    }
  };
}
