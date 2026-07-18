import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { getGitDiffOverviewSegments } from './gitDiffGutter';
import { getLiveRenderedBlockAtLine } from './liveRenderedBlocks';

const minMarkerHeightPx = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface TrackMetrics {
  scrollHeight: number;
  contentBottom: number;
  fileEndY: number;
  showFileEndLine: boolean;
}

function getTrackMetrics(view: EditorView, trackHeight: number): TrackMetrics {
  const scrollEl = view?.scrollDOM;
  if (!scrollEl || trackHeight <= 0) {
    return {
      scrollHeight: Math.max(1, trackHeight),
      contentBottom: Math.max(1, trackHeight),
      fileEndY: trackHeight,
      showFileEndLine: false
    };
  }

  const totalScrollHeight = Math.max(trackHeight, scrollEl.scrollHeight || 0);
  if (totalScrollHeight <= 0) {
    return {
      scrollHeight: Math.max(1, trackHeight),
      contentBottom: Math.max(1, trackHeight),
      fileEndY: trackHeight,
      showFileEndLine: false
    };
  }

  let contentBottom = 0;
  try {
    const lastLine = view.state.doc.line(view.state.doc.lines);
    const lastBlock = view.lineBlockAt(lastLine.from);
    contentBottom = Number.isFinite(lastBlock?.bottom) ? lastBlock.bottom : 0;
  } catch {
    contentBottom = 0;
  }

  if (!(contentBottom > 0) && Number.isFinite(view.contentHeight)) {
    contentBottom = view.contentHeight;
  }

  contentBottom = clamp(Math.ceil(contentBottom), 0, totalScrollHeight);
  if (contentBottom <= 0) {
    contentBottom = totalScrollHeight;
  }

  const fileEndRatio = clamp(contentBottom / totalScrollHeight, 0, 1);
  const fileEndY = clamp(Math.round(trackHeight * fileEndRatio), 0, trackHeight);
  return {
    scrollHeight: totalScrollHeight,
    contentBottom: Math.max(1, contentBottom),
    fileEndY,
    showFileEndLine: fileEndY > 0 && fileEndY < trackHeight
  };
}

interface LineGeometry {
  top: number;
  bottom: number;
}

function getLiveTableRowGeometry(view: EditorView): Map<number, LineGeometry> {
  const rows = new Map<number, LineGeometry>();
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const scrollTop = view.scrollDOM.scrollTop;
  for (const row of view.dom.querySelectorAll<HTMLElement>(
    '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number]'
  )) {
    const lineNumber = Number.parseInt(row.dataset.sourceLineNumber ?? '', 10);
    if (!Number.isInteger(lineNumber) || lineNumber < 1) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    const top = scrollTop + rowRect.top - scrollRect.top;
    const bottom = top + rowRect.height;
    if (Number.isFinite(top) && Number.isFinite(bottom) && bottom > top) {
      rows.set(lineNumber, { top, bottom });
    }
  }
  return rows;
}

function getLineGeometry(
  view: EditorView,
  lineNumber: number,
  tableRows: Map<number, LineGeometry>
): LineGeometry | null {
  const tableRow = tableRows.get(lineNumber);
  if (tableRow) {
    return tableRow;
  }
  try {
    const line = view.state.doc.line(lineNumber);
    const block = view.lineBlockAt(line.from);
    if (Number.isFinite(block?.top) && Number.isFinite(block?.bottom) && block.bottom > block.top) {
      return { top: block.top, bottom: block.bottom };
    }
  } catch {
    // Keep the line-based fallback if CodeMirror cannot measure this range yet.
  }
  return null;
}

interface PixelSegment {
  top: number;
  height: number;
  added: boolean;
  modified: boolean;
  deleted: boolean;
}

interface GitDiffOverviewRulerController {
  refresh(): void;
  destroy(): void;
}

interface GitDiffOverviewRulerOptions {
  view: EditorView;
  getMode: () => string;
  isGitChangesVisible: () => boolean;
}

export function createGitDiffOverviewRulerController({
  view,
  getMode,
  isGitChangesVisible
}: GitDiffOverviewRulerOptions): GitDiffOverviewRulerController {
  let destroyed = false;
  let host: HTMLElement | null = null;
  let lastRenderKey = '';
  let resizeObserver: ResizeObserver | null = null;
  let rafId = 0;
  let onWindowResize: (() => void) | null = null;

  const ensureHost = (): HTMLElement => {
    if (host) {
      return host;
    }
    host = document.createElement('div');
    host.className = 'meo-git-overview-ruler';
    host.hidden = true;
    view.dom.appendChild(host);
    return host;
  };

  const cancelScheduledRender = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const hide = () => {
    const root = ensureHost();
    root.hidden = true;
    if (root.childElementCount) {
      root.textContent = '';
    }
  };

  const renderNow = () => {
    if (destroyed || !view) {
      return;
    }

    const mode = typeof getMode === 'function' ? getMode() : 'source';
    const visible = typeof isGitChangesVisible === 'function' ? isGitChangesVisible() : true;
    const root = ensureHost();
    const trackHeight = Math.floor(root.clientHeight || view.dom.clientHeight || 0);
    if (trackHeight <= 0) {
      lastRenderKey = `hidden:${mode}:no-height`;
      hide();
      return;
    }
    const trackMetrics = getTrackMetrics(view, trackHeight);

    if (!visible) {
      const renderKey = `track-only:${mode}:${trackHeight}:${trackMetrics.fileEndY}:${trackMetrics.showFileEndLine ? 1 : 0}`;
      if (renderKey === lastRenderKey) {
        return;
      }
      lastRenderKey = renderKey;
      root.textContent = '';
      if (trackMetrics.showFileEndLine) {
        const boundary = document.createElement('div');
        boundary.className = 'meo-git-overview-ruler-file-end';
        boundary.style.top = `${clamp(trackMetrics.fileEndY - 1, 0, trackHeight - 1)}px`;
        root.appendChild(boundary);
      }
      root.hidden = false;
      return;
    }

    const totalLines = Math.max(1, view.state.doc.lines);
    const segments = getGitDiffOverviewSegments(view.state);
    const tableRows = getLiveTableRowGeometry(view);
    if (!segments.length) {
      const renderKey = `track-only:${mode}:no-segments:${totalLines}:${trackHeight}:${trackMetrics.fileEndY}:${trackMetrics.showFileEndLine ? 1 : 0}`;
      if (renderKey === lastRenderKey) {
        return;
      }
      lastRenderKey = renderKey;
      root.textContent = '';
      if (trackMetrics.showFileEndLine) {
        const boundary = document.createElement('div');
        boundary.className = 'meo-git-overview-ruler-file-end';
        boundary.style.top = `${clamp(trackMetrics.fileEndY - 1, 0, trackHeight - 1)}px`;
        root.appendChild(boundary);
      }
      root.hidden = false;
      return;
    }

    const pixelSegments: PixelSegment[] = [];
    for (const segment of segments) {
      let topRatio = (segment.fromLine - 1) / totalLines;
      let bottomRatio = segment.toLine / totalLines;
      const fromGeometry = getLineGeometry(view, segment.fromLine, tableRows);
      const toGeometry = getLineGeometry(view, segment.toLine, tableRows);
      const isTableSegment = mode === 'live' && (
        getLiveRenderedBlockAtLine(view.state, segment.fromLine)?.kind === 'table' ||
        getLiveRenderedBlockAtLine(view.state, segment.toLine)?.kind === 'table'
      );
      const hasTableRowGeometry = tableRows.has(segment.fromLine) && tableRows.has(segment.toLine);
      if (fromGeometry && toGeometry && (!isTableSegment || hasTableRowGeometry)) {
        topRatio = fromGeometry.top / trackMetrics.scrollHeight;
        bottomRatio = toGeometry.bottom / trackMetrics.scrollHeight;
      } else {
        topRatio = (topRatio * trackMetrics.contentBottom) / trackMetrics.scrollHeight;
        bottomRatio = (bottomRatio * trackMetrics.contentBottom) / trackMetrics.scrollHeight;
      }
      let top = Math.floor(topRatio * trackHeight);
      let bottom = Math.ceil(bottomRatio * trackHeight);
      let height = Math.max(minMarkerHeightPx, bottom - top);

      top = clamp(top, 0, Math.max(0, trackHeight - 1));
      if (top + height > trackHeight) {
        if (height >= trackHeight) {
          top = 0;
          height = trackHeight;
        } else {
          top = Math.max(0, trackHeight - height);
        }
      }
      bottom = top + height;
      if (bottom > trackHeight) {
        bottom = trackHeight;
      }
      if (bottom <= top) {
        continue;
      }

      pixelSegments.push({
        top,
        height: bottom - top,
        added: segment.added,
        modified: segment.modified,
        deleted: segment.deleted
      });
    }

    const renderKey = [
      mode,
      visible ? 1 : 0,
      totalLines,
      trackHeight,
      trackMetrics.fileEndY,
      trackMetrics.showFileEndLine ? 1 : 0,
      pixelSegments.map((segment) => (
        `${segment.top}:${segment.height}:${segment.added ? 1 : 0}:${segment.modified ? 1 : 0}:${segment.deleted ? 1 : 0}`
      )).join(',')
    ].join('|');

    if (renderKey === lastRenderKey) {
      return;
    }
    lastRenderKey = renderKey;

    root.textContent = '';
    for (const segment of pixelSegments) {
      const marker = document.createElement('div');
      marker.className = 'meo-git-overview-ruler-marker';
      if (segment.added) {
        marker.classList.add('is-added');
      }
      if (segment.modified) {
        marker.classList.add('is-modified');
      }
      if (segment.deleted) {
        marker.classList.add('is-deleted');
      }
      marker.style.top = `${segment.top}px`;
      marker.style.height = `${segment.height}px`;
      root.appendChild(marker);
    }
    if (trackMetrics.showFileEndLine) {
      const boundary = document.createElement('div');
      boundary.className = 'meo-git-overview-ruler-file-end';
      boundary.style.top = `${clamp(trackMetrics.fileEndY - 1, 0, trackHeight - 1)}px`;
      root.appendChild(boundary);
    }
    root.hidden = false;
  };

  const scheduleRender = () => {
    if (destroyed || rafId) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderNow();
    });
  };

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      lastRenderKey = '';
      scheduleRender();
    });
    resizeObserver.observe(view.dom);
    resizeObserver.observe(view.scrollDOM);
    resizeObserver.observe(view.contentDOM);
  } else {
    onWindowResize = () => {
      lastRenderKey = '';
      scheduleRender();
    };
    window.addEventListener('resize', onWindowResize);
  }

  scheduleRender();

  return {
    refresh() {
      scheduleRender();
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelScheduledRender();
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (onWindowResize) {
        window.removeEventListener('resize', onWindowResize);
        onWindowResize = null;
      }
      if (host) {
        host.remove();
        host = null;
      }
    }
  };
}
