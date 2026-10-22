/** Viewing zoom is relative to the fitted content; retain the existing minimum. */
export function stepVisualZoom(
  zoom: number,
  direction: 1 | -1,
  input: 'button' | 'wheel' = 'button'
): number {
  const factor = input === 'button' ? 1.25 : 1.1;
  // A numerical guard, rather than a normal viewing limit.
  return Math.max(0.25, Math.min(1024, zoom * factor ** direction));
}
