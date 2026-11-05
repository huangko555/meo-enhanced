import {
  MAX_SIDEBAR_OUTLINE_HEADINGS,
  MAX_SIDEBAR_OUTLINE_TEXT_LENGTH,
  type SidebarOutlineHeading,
  type SidebarOutlineMessage
} from '../../../src/protocol/sidebarOutline';
import { findOutlineHeadingIndex, outlineHeadingKeys } from '../../../src/foundation/outline';
import { createRequestPrefix } from './requestIdentity';

/** The same surface the in-editor outline reads: the Live/Source editor or the Preview adapter. */
export interface SidebarOutlineSource {
  getHeadings(): readonly { text: string; level: number; from: number; line: number }[];
  isOutlinePending?(): boolean;
  getViewportAnchorOffset(ratio?: number): number;
  getVisibleDocumentRange(): { fromLine: number; toLine: number } | null;
  getScrollElement(): EventTarget;
  scrollToLine(line: number, position: string): void;
}

type Timers = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  requestFrame(callback: () => void): unknown;
  cancelFrame(handle: unknown): void;
};

/** Matches the in-editor outline: the heading above 20% of the viewport is current. */
export const SIDEBAR_OUTLINE_ACTIVE_VIEWPORT_RATIO = 0.2;
const PUBLISH_DELAY_MS = 120;
const PENDING_RETRY_MS = 50;
const NAVIGATION_INPUT_EVENTS = ['wheel', 'pointerdown', 'keydown', 'beforeinput'] as const;

function projectHeadings(headings: ReturnType<SidebarOutlineSource['getHeadings']>): SidebarOutlineHeading[] {
  return headings.slice(0, MAX_SIDEBAR_OUTLINE_HEADINGS).map(heading => ({
    level: Math.min(6, Math.max(1, Math.trunc(heading.level))),
    text: heading.text.trim().slice(0, MAX_SIDEBAR_OUTLINE_TEXT_LENGTH),
    line: Math.max(1, Math.trunc(heading.line))
  }));
}

const browserTimers: Timers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: handle => window.clearTimeout(handle as number),
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: handle => window.cancelAnimationFrame(handle as number)
};

/**
 * Publishes headings for the Explorer outline view. Work runs only while the host
 * reports that view as visible, so hidden sidebars cost nothing per keystroke or scroll.
 */
export function createSidebarOutlineReporter(
  getSource: () => SidebarOutlineSource | null,
  post: (message: SidebarOutlineMessage) => void,
  timers: Timers = browserTimers
) {
  let enabled = false;
  let disposed = false;
  let timer: unknown = null;
  let frame: unknown = null;
  let boundScrollElement: EventTarget | null = null;
  let publishedSource: SidebarOutlineSource | null = null;
  let publishedHeadings: readonly SidebarOutlineHeading[] | null = null;
  // Retain the last displayed identities across unsubscription so the first
  // click can reopen a hidden editor before its new publication arrives.
  let navigationSnapshot: { source: SidebarOutlineSource; headings: readonly SidebarOutlineHeading[]; id: string } | null = null;
  let pendingNavigation: { key: string; snapshot: string } | null = null;
  const sessionId = createRequestPrefix();
  let snapshotVersion = 0;
  let sentActive = -2;
  let headingStarts: number[] = [];
  const cancelPendingNavigation = () => { pendingNavigation = null; };

  const cancelTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const cancelFrame = () => {
    if (frame !== null) timers.cancelFrame(frame);
    frame = null;
  };
  const unbindScroll = () => {
    boundScrollElement?.removeEventListener('scroll', scheduleActive);
    for (const type of NAVIGATION_INPUT_EVENTS)
      boundScrollElement?.removeEventListener(type, cancelPendingNavigation, true);
    boundScrollElement = null;
  };
  const bindScroll = (source: SidebarOutlineSource) => {
    const element = source.getScrollElement();
    if (element === boundScrollElement) return;
    unbindScroll();
    boundScrollElement = element;
    element.addEventListener('scroll', scheduleActive, { passive: true } as AddEventListenerOptions);
    for (const type of NAVIGATION_INPUT_EVENTS)
      element.addEventListener(type, cancelPendingNavigation, { capture: true, passive: true });
  };

  const readActiveIndex = (source: SidebarOutlineSource) => source.getVisibleDocumentRange()
    ? findOutlineHeadingIndex(headingStarts, source.getViewportAnchorOffset(SIDEBAR_OUTLINE_ACTIVE_VIEWPORT_RATIO)) : -1;

  const publish = () => {
    timer = null;
    if (!enabled || disposed) return;
    const source = getSource();
    if (!source) return;
    bindScroll(source);
    // getHeadings advances parsing and refreshes the editor's pending flag.
    const all = source.getHeadings();
    if (source.isOutlinePending?.()) {
      timer = timers.setTimeout(publish, PENDING_RETRY_MS);
      return;
    }
    const navigation = pendingNavigation;
    pendingNavigation = null;
    if (navigation) reveal(navigation.key, navigation.snapshot);
    headingStarts = all.slice(0, MAX_SIDEBAR_OUTLINE_HEADINGS).map(heading => heading.from);
    const headings = projectHeadings(all);
    const changed = publishedHeadings === null || headings.length !== publishedHeadings.length
      || headings.some((heading, index) => {
        const previous = publishedHeadings![index];
        return heading.level !== previous.level || heading.text !== previous.text || heading.line !== previous.line;
      });
    publishedSource = source;
    publishedHeadings = headings;
    const snapshot = changed ? `${sessionId}:${++snapshotVersion}` : navigationSnapshot!.id;
    navigationSnapshot = { source, headings, id: snapshot };
    const activeIndex = readActiveIndex(source);
    if (changed || activeIndex !== sentActive) {
      sentActive = activeIndex;
      post({ type: 'sidebarOutline', snapshot, ...(changed ? { headings } : {}), activeIndex });
    }
  };

  const refreshActive = () => {
    frame = null;
    if (!enabled || disposed || publishedHeadings === null) return;
    const source = getSource();
    if (!source || source !== publishedSource) return;
    const activeIndex = readActiveIndex(source);
    if (activeIndex === sentActive) return;
    sentActive = activeIndex;
    post({ type: 'sidebarOutline', snapshot: navigationSnapshot!.id, activeIndex });
  };

  function scheduleActive() {
    // Height corrections also emit scroll events. Only a new input gesture
    // supersedes a click waiting for complete heading identities.
    if (!enabled || disposed || frame !== null) return;
    frame = timers.requestFrame(refreshActive);
  }

  const schedule = () => {
    pendingNavigation = null;
    if (!enabled || disposed) return;
    cancelTimer();
    timer = timers.setTimeout(publish, PUBLISH_DELAY_MS);
  };

  function reveal(key: string, snapshot: string) {
    if (snapshot !== navigationSnapshot?.id) return;
    pendingNavigation = null;
    const source = getSource();
    if (!source || disposed) return;
    if (enabled) bindScroll(source);
    const headings = projectHeadings(source.getHeadings());
    // A pending result retains mapped offsets but still has old identities.
    // Validate the latest click once parsing settles, before replacing its snapshot.
    if (source.isOutlinePending?.()) {
      pendingNavigation = { key, snapshot };
      cancelTimer();
      if (enabled) timer = timers.setTimeout(publish, PENDING_RETRY_MS);
      return;
    }
    const previous = navigationSnapshot;
    if (!previous || source !== previous.source || headings.length !== previous.headings.length
      || headings.some((heading, index) => heading.level !== previous.headings[index].level
        || heading.text !== previous.headings[index].text)) {
      cancelTimer();
      publish();
      return;
    }
    const index = outlineHeadingKeys(headings).indexOf(key);
    if (index >= 0) source.scrollToLine(headings[index].line, 'top');
  }

  return {
    /** Headings or the editing surface may have changed (edit, mode switch, Preview render). */
    schedule,
    /** Viewport moved without a scroll event (layout or Preview geometry change). */
    refreshViewport: scheduleActive,
    setEnabled(next: boolean) {
      if (disposed || next === enabled) return;
      enabled = next;
      cancelTimer();
      cancelFrame();
      if (!enabled) {
        pendingNavigation = null;
        unbindScroll();
        publishedSource = null;
        publishedHeadings = null;
        headingStarts = [];
        return;
      }
      // The document may have changed while hidden; always resend on enable.
      publishedHeadings = null;
      sentActive = -2;
      timer = timers.setTimeout(publish, 0);
    },
    reveal,
    isEnabled: () => enabled,
    dispose() {
      disposed = true;
      enabled = false;
      cancelTimer();
      cancelFrame();
      unbindScroll();
      navigationSnapshot = null;
      pendingNavigation = null;
    }
  };
}
