import type { EditorView } from '@codemirror/view';
import { getBaselineRangesPreview, getDeletedGapRangesPreview } from './gitDiffGutter';

type DiffContentHoverController = {
  hide(): void;
  destroy(): void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DELETION_HIT_LEFT_PADDING_PX = 7;
const DELETION_TRIANGLE_MAX_GUTTER_OVERFLOW_PX = 4;
const DELETION_HIT_VERTICAL_PADDING_PX = 7;
const deletionMarkerHitCache = new WeakMap<MouseEvent, { view: EditorView; marker: HTMLElement | null }>();

function parseLineRanges(raw: string | undefined): Array<[number, number]> {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((range): range is [number, number] => (
          Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1])
        ))
      : [];
  } catch {
    return [];
  }
}

export function findDeletionMarkerForMouseEvent(
  view: EditorView,
  event: MouseEvent
): HTMLElement | null {
  const cached = deletionMarkerHitCache.get(event);
  if (cached?.view === view) {
    return cached.marker;
  }
  const { clientX, clientY } = event;
  const gutter = view.dom.querySelector<HTMLElement>('.cm-gutter.meo-git-gutter');
  if (!gutter) {
    deletionMarkerHitCache.set(event, { view, marker: null });
    return null;
  }
  const gutterRect = gutter.getBoundingClientRect();
  if (
    clientX < gutterRect.left - DELETION_HIT_LEFT_PADDING_PX ||
    clientX > gutterRect.right + DELETION_TRIANGLE_MAX_GUTTER_OVERFLOW_PX
  ) {
    deletionMarkerHitCache.set(event, { view, marker: null });
    return null;
  }

  let nearestMarker: HTMLElement | null = null;
  let nearestVerticalDistance = Number.POSITIVE_INFINITY;
  for (const marker of gutter.querySelectorAll<HTMLElement>('.meo-git-gutter-marker.is-deleted')) {
    const rect = marker.getBoundingClientRect();
    const triangleStyle = window.getComputedStyle(marker, '::after');
    const triangleLeft = rect.left + (Number.parseFloat(triangleStyle.left) || 0);
    const triangleRight = triangleLeft + (Number.parseFloat(triangleStyle.borderLeftWidth) || 0);
    const triangleY = marker.classList.contains('is-deleted-at-end') ? rect.bottom : rect.top;
    if (
      clientX >= triangleLeft - DELETION_HIT_LEFT_PADDING_PX &&
      clientX <= triangleRight &&
      clientY >= triangleY - DELETION_HIT_VERTICAL_PADDING_PX &&
      clientY <= triangleY + DELETION_HIT_VERTICAL_PADDING_PX
    ) {
      const verticalDistance = Math.abs(clientY - triangleY);
      if (verticalDistance < nearestVerticalDistance) {
        nearestMarker = marker;
        nearestVerticalDistance = verticalDistance;
      }
    }
  }
  deletionMarkerHitCache.set(event, { view, marker: nearestMarker });
  return nearestMarker;
}

export function findModifiedMarkerForMouseEvent(
  view: EditorView,
  event: MouseEvent
): HTMLElement | null {
  const target = event.target instanceof Element ? event.target : null;
  const marker = target?.closest<HTMLElement>('.meo-git-gutter-marker.is-modified') ?? null;
  return marker && view.dom.contains(marker) ? marker : null;
}

export function createGitDiffContentHoverController(view: EditorView): DiffContentHoverController {
  const root = document.createElement('div');
  root.className = 'meo-deletion-tooltip';
  root.hidden = true;

  const title = document.createElement('div');
  title.className = 'meo-deletion-tooltip-title';
  const content = document.createElement('pre');
  content.className = 'meo-deletion-tooltip-content';
  const more = document.createElement('div');
  more.className = 'meo-deletion-tooltip-more';
  root.append(title, content, more);
  document.body.appendChild(root);

  const modifiedRoot = document.createElement('div');
  modifiedRoot.className = 'meo-modified-tooltip';
  modifiedRoot.hidden = true;
  const modifiedTitle = document.createElement('div');
  modifiedTitle.className = 'meo-modified-tooltip-title';
  modifiedTitle.textContent = 'Before change';
  const modifiedContent = document.createElement('pre');
  modifiedContent.className = 'meo-modified-tooltip-content';
  const modifiedMore = document.createElement('div');
  modifiedMore.className = 'meo-modified-tooltip-more';
  modifiedRoot.append(modifiedTitle, modifiedContent, modifiedMore);
  document.body.appendChild(modifiedRoot);

  let destroyed = false;
  let activeKey = '';
  let activeDeletionMarker: HTMLElement | null = null;

  const setActiveDeletionMarker = (marker: HTMLElement | null) => {
    if (activeDeletionMarker === marker) {
      return;
    }
    activeDeletionMarker?.classList.remove('is-hit-hover');
    activeDeletionMarker = marker;
    activeDeletionMarker?.classList.add('is-hit-hover');
  };

  const hide = () => {
    activeKey = '';
    setActiveDeletionMarker(null);
    root.hidden = true;
    modifiedRoot.hidden = true;
  };

  const position = (tooltipRoot: HTMLElement, marker: Element) => {
    const markerRect = marker.getBoundingClientRect();
    const tooltipRect = tooltipRoot.getBoundingClientRect();
    let left = markerRect.right + 10;
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = markerRect.left - tooltipRect.width - 10;
    }
    tooltipRoot.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - tooltipRect.width - 8))}px`;
    tooltipRoot.style.top = `${clamp(markerRect.top, 8, Math.max(8, window.innerHeight - tooltipRect.height - 8))}px`;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (destroyed) {
      return;
    }
    const marker = findDeletionMarkerForMouseEvent(view, event);
    if (marker) {
      setActiveDeletionMarker(marker);
      const baselineFromLine = Number.parseInt(marker.dataset.meoBaselineFromLine ?? '', 10);
      const baselineToLine = Number.parseInt(marker.dataset.meoBaselineToLine ?? '', 10);
      const ranges = parseLineRanges(marker.dataset.meoDeletionRanges);
      if (!ranges.length && Number.isInteger(baselineFromLine) && Number.isInteger(baselineToLine)) {
        ranges.push([baselineFromLine, baselineToLine]);
      }
      if (!ranges.length) {
        hide();
        return;
      }
      const key = `deleted:${JSON.stringify(ranges)}`;
      if (key === activeKey && !root.hidden) {
        position(root, marker);
        return;
      }

      const preview = getDeletedGapRangesPreview(view.state, ranges);
      if (!preview) {
        hide();
        return;
      }
      activeKey = key;
      title.textContent = `Deleted ${preview.totalLines} ${preview.totalLines === 1 ? 'line' : 'lines'}`;
      content.textContent = preview.text;
      more.textContent = preview.truncated ? 'More deleted content is not shown.' : '';
      modifiedRoot.hidden = true;
      root.hidden = false;
      position(root, marker);
      return;
    }

    const modifiedMarker = findModifiedMarkerForMouseEvent(view, event);
    setActiveDeletionMarker(null);
    const rawRanges = modifiedMarker?.dataset.meoModifiedRanges;
    if (!modifiedMarker || !rawRanges) {
      hide();
      return;
    }
    const key = `modified:${rawRanges}`;
    if (key === activeKey && !modifiedRoot.hidden) {
      position(modifiedRoot, modifiedMarker);
      return;
    }
    const modifiedRanges = parseLineRanges(rawRanges);
    const preview = getBaselineRangesPreview(view.state, modifiedRanges);
    if (!preview) {
      hide();
      return;
    }
    activeKey = key;
    modifiedContent.textContent = preview.text;
    modifiedMore.textContent = preview.truncated ? 'More original content is not shown.' : '';
    root.hidden = true;
    modifiedRoot.hidden = false;
    position(modifiedRoot, modifiedMarker);
  };

  const onMouseLeave = () => hide();
  view.dom.addEventListener('mousemove', onMouseMove);
  view.dom.addEventListener('mouseleave', onMouseLeave);
  view.scrollDOM.addEventListener('scroll', hide, { passive: true });

  return {
    hide,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      setActiveDeletionMarker(null);
      view.dom.removeEventListener('mousemove', onMouseMove);
      view.dom.removeEventListener('mouseleave', onMouseLeave);
      view.scrollDOM.removeEventListener('scroll', hide);
      root.remove();
      modifiedRoot.remove();
    }
  };
}
