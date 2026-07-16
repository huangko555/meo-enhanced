import type { EditorView } from '@codemirror/view';
import { getDeletedGapRangesPreview } from './gitDiffGutter';

type DeletionHoverController = {
  hide(): void;
  destroy(): void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createGitDeletionHoverController(view: EditorView): DeletionHoverController {
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

  let destroyed = false;
  let activeKey = '';

  const hide = () => {
    activeKey = '';
    root.hidden = true;
  };

  const position = (marker: Element) => {
    const markerRect = marker.getBoundingClientRect();
    const tooltipRect = root.getBoundingClientRect();
    let left = markerRect.right + 10;
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = markerRect.left - tooltipRect.width - 10;
    }
    root.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - tooltipRect.width - 8))}px`;
    root.style.top = `${clamp(markerRect.top, 8, Math.max(8, window.innerHeight - tooltipRect.height - 8))}px`;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (destroyed) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const marker = target?.closest('.meo-git-gutter-marker.is-deleted');
    if (!marker || !view.dom.contains(marker)) {
      hide();
      return;
    }

    const markerElement = marker as HTMLElement;
    const baselineFromLine = Number.parseInt(markerElement.dataset.meoBaselineFromLine ?? '', 10);
    const baselineToLine = Number.parseInt(markerElement.dataset.meoBaselineToLine ?? '', 10);
    let ranges: Array<[number, number]> = [];
    try {
      const parsed = JSON.parse(markerElement.dataset.meoDeletionRanges ?? '[]');
      if (Array.isArray(parsed)) {
        ranges = parsed.filter((range): range is [number, number] => (
          Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1])
        ));
      }
    } catch {
      ranges = [];
    }
    if (!ranges.length && Number.isInteger(baselineFromLine) && Number.isInteger(baselineToLine)) {
      ranges = [[baselineFromLine, baselineToLine]];
    }
    if (!ranges.length) {
      hide();
      return;
    }
    const key = JSON.stringify(ranges);
    if (key === activeKey && !root.hidden) {
      position(marker);
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
    root.hidden = false;
    position(marker);
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
      view.dom.removeEventListener('mousemove', onMouseMove);
      view.dom.removeEventListener('mouseleave', onMouseLeave);
      view.scrollDOM.removeEventListener('scroll', hide);
      root.remove();
    }
  };
}
