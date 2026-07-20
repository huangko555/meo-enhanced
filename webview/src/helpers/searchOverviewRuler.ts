import type { EditorView } from '@codemirror/view';
import { getLineGeometry, getLiveTableRowGeometry, getTrackMetrics } from './gitDiffOverviewRuler';

type SearchOverviewMatch = {
  from: number;
  active: boolean;
};

type SearchOverviewRulerOptions = {
  view: EditorView;
  getMatches: () => SearchOverviewMatch[];
};

type SearchOverviewRulerController = {
  refresh(options?: { positionsChanged?: boolean }): void;
  destroy(): void;
};

const minimumMarkerHeight = 2;
const activeMarkerHeight = 3;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createSearchOverviewRulerController({
  view,
  getMatches
}: SearchOverviewRulerOptions): SearchOverviewRulerController {
  let host: HTMLElement | null = null;
  let destroyed = false;
  let frame = 0;
  let lastRenderKey = '';
  let resizeObserver: ResizeObserver | null = null;

  const invalidatePositions = () => {
    lastRenderKey = '';
  };

  const ensureHost = (): HTMLElement => {
    if (host) {
      return host;
    }
    host = document.createElement('div');
    host.className = 'meo-search-overview-ruler';
    host.hidden = true;
    view.dom.appendChild(host);
    return host;
  };

  const render = () => {
    if (destroyed) {
      return;
    }
    const root = ensureHost();
    const matches = getMatches();
    const trackHeight = Math.floor(root.clientHeight || view.dom.clientHeight || 0);
    if (!matches.length || trackHeight <= 0) {
      root.hidden = true;
      root.textContent = '';
      lastRenderKey = `hidden:${matches.length}:${trackHeight}`;
      return;
    }

    const trackMetrics = getTrackMetrics(view, trackHeight);
    const tableRows = getLiveTableRowGeometry(view);
    const totalLines = Math.max(1, view.state.doc.lines);
    const activeByTop = new Map<number, boolean>();
    for (const match of matches) {
      const lineNumber = view.state.doc.lineAt(match.from).number;
      const geometry = getLineGeometry(view, lineNumber, tableRows);
      const blockTop = geometry?.top
        ?? ((lineNumber - 1) / totalLines) * trackMetrics.contentBottom;
      const top = clamp(
        Math.round((blockTop / trackMetrics.scrollHeight) * trackHeight),
        0,
        Math.max(0, trackHeight - activeMarkerHeight)
      );
      activeByTop.set(top, activeByTop.get(top) === true || match.active);
    }
    const markers = [...activeByTop.entries()]
      .map(([top, active]) => ({ top, active }))
      .sort((left, right) => left.top - right.top);
    const renderKey = `${trackHeight}|${trackMetrics.scrollHeight}|${markers.map((marker) => `${marker.top}:${marker.active ? 1 : 0}`).join(',')}`;
    if (renderKey === lastRenderKey) {
      return;
    }
    lastRenderKey = renderKey;

    root.textContent = '';
    for (const marker of markers) {
      const element = document.createElement('div');
      element.className = 'meo-search-overview-ruler-marker';
      if (marker.active) {
        element.classList.add('is-active');
      }
      element.style.top = `${marker.top}px`;
      element.style.height = `${marker.active ? activeMarkerHeight : minimumMarkerHeight}px`;
      root.appendChild(element);
    }
    root.hidden = false;
  };

  const refresh = ({ positionsChanged = false }: { positionsChanged?: boolean } = {}) => {
    if (positionsChanged) invalidatePositions();
    if (destroyed || frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      invalidatePositions();
      refresh();
    });
    resizeObserver.observe(view.dom);
    resizeObserver.observe(view.scrollDOM);
    resizeObserver.observe(view.contentDOM);
  }

  refresh();

  return {
    refresh,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      host?.remove();
      host = null;
    }
  };
}
