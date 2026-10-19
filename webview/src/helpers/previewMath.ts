import { renderLatexMathToHtml } from './math';

/** Called only from the existing visible-formula attachment. No second observer
 * or document lifecycle: preserved roots retain their already generated HTML. */
export function renderDeferredPreviewMath(element: HTMLElement): boolean {
  const source = element.getAttribute('data-meo-deferred-math');
  if (source === null || !element.classList.contains('meo-export-math-display')) return false;
  try {
    const binary = window.atob(source);
    const content = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    const html = renderLatexMathToHtml(content, 'display');
    if (html !== null) element.innerHTML = html;
  } catch {
    // A malformed authored attribute retains the escaped, readable fallback.
  }
  element.removeAttribute('data-meo-deferred-math');
  return true;
}
