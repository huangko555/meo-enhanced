/** The browser keeps its parser state across writes, including partial tags,
 * entities, tables and MathML. Bounded tasks let input and paint run between
 * chunks without an application-side HTML parser or a second document model. */
export function writePreviewFrame(
  frame: HTMLIFrameElement,
  header: string,
  html: string,
  footer: string,
  isCurrent: () => boolean,
  onReady: () => void
): (() => void) | null {
  const document = frame.contentDocument;
  if (!document) return null;
  let timer: number | null = null;
  let firstFrame: number | null = null;
  let cancelled = false, written = false, ready = false, offset = 0;
  const finish = () => {
    if (!written || ready || cancelled || !isCurrent() || document.readyState !== 'complete') return;
    ready = true;
    document.removeEventListener('readystatechange', finish);
    onReady();
  };
  document.open();
  document.addEventListener('readystatechange', finish);
  document.write(header);
  const pump = () => {
    timer = null;
    if (cancelled || !isCurrent() || frame.contentDocument !== document) return;
    const started = performance.now();
    do {
      let end = Math.min(html.length, offset + 32_768);
      const last = html.charCodeAt(end - 1), next = html.charCodeAt(end);
      if (end < html.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      document.write(html.slice(offset, end));
      offset = end;
    } while (offset < html.length && performance.now() - started < 8);
    if (offset < html.length) timer = window.setTimeout(pump, 0);
    else {
      document.write(footer);
      written = true;
      document.close();
      finish();
    }
  };
  // Give the loading surface one observable frame before parsing begins. A
  // fast document can otherwise finish all timer slices before the next paint.
  firstFrame = window.requestAnimationFrame(() => { firstFrame = null; pump(); });
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== null) window.clearTimeout(timer);
    if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
    document.removeEventListener('readystatechange', finish);
    if (!written && frame.contentDocument === document) document.close();
  };
}
