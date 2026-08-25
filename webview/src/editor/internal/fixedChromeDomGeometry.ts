import {
  fixedChromeAffineMappingFromSamples,
  type FixedChromeAffineMapping
} from '../fixedChromeGeometry';

const sampleDistance = 100;

/** Samples the complete local-to-viewport mapping for an element's fixed containing block. */
export function measureFixedContainingBlockMapping(
  element: HTMLElement
): FixedChromeAffineMapping | null {
  const parent = element.parentElement;
  if (!parent) return null;
  const probe = (left: number, top: number): HTMLSpanElement => {
    const sample = parent.ownerDocument.createElement('span');
    sample.setAttribute('aria-hidden', 'true');
    sample.style.cssText = `position:fixed;inset:auto;left:${left}px;top:${top}px;` +
      'display:block;width:0;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;';
    return sample;
  };
  const origin = probe(0, 0);
  const horizontal = probe(sampleDistance, 0);
  const vertical = probe(0, sampleDistance);
  try {
    parent.append(origin, horizontal, vertical);
    const originRect = origin.getBoundingClientRect();
    const horizontalRect = horizontal.getBoundingClientRect();
    const verticalRect = vertical.getBoundingClientRect();
    return fixedChromeAffineMappingFromSamples(
      { x: originRect.left, y: originRect.top },
      { x: horizontalRect.left, y: horizontalRect.top },
      { x: verticalRect.left, y: verticalRect.top },
      sampleDistance
    );
  } catch {
    return null;
  } finally {
    origin.remove();
    horizontal.remove();
    vertical.remove();
  }
}
