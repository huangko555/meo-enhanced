import type { EditorView } from '@codemirror/view';

/** Native widget input owns its painted position until the next user intent.
 * Background parsing can finish after any fixed animation-frame retry window.
 * This record schedules no work itself. */
export class NativeInputViewport {
  private anchor: { input: HTMLTextAreaElement; top: number } | null = null;
  private fractionalOffset = 0;
  private scrollQuantum: number | null = null;

  constructor(private readonly view: EditorView) {}

  /** Pointer activation may supply the same input's pre-focus geometry. */
  capture(target: EventTarget | null, top?: number): boolean {
    const window = this.view.dom.ownerDocument?.defaultView;
    if (!window || !(target instanceof window.HTMLTextAreaElement)
      || !this.view.contentDOM.contains(target)
      || !target.closest('[data-meo-rendered-block-start-line]')
      || this.view.dom.ownerDocument.activeElement !== target) return false;
    const bounds = target.getBoundingClientRect(), viewport = this.view.scrollDOM.getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return false;
    this.anchor = { input: target, top: top ?? bounds.top };
    return true;
  }

  hasOwner(): boolean {
    if (!this.anchor) return false;
    if (this.anchor.input.isConnected && this.view.dom.ownerDocument.activeElement === this.anchor.input) return true;
    this.release();
    return false;
  }

  scrollTop(): number | null {
    if (!this.hasOwner()) return null;
    const scroll = this.view.scrollDOM;
    const scale = scroll.offsetHeight ? scroll.getBoundingClientRect().height / scroll.offsetHeight : 1;
    return scroll.scrollTop + (this.anchor!.input.getBoundingClientRect().top - this.anchor!.top) / scale;
  }

  /** Keep native scroll rounding out of unchanged glyphs. The primary scroller
   * owns a bounded padding remainder, shared by its content and gutters. */
  absorbScrollRounding(top: number): boolean {
    if (!this.hasOwner()) return false;
    const scroll = this.view.scrollDOM;
    const error = scroll.scrollTop - top;
    if (!Number.isFinite(error) || Math.abs(error) > 1 || top <= 1
      || top >= scroll.scrollHeight - scroll.clientHeight - 1
      || Math.abs(error) <= 1 / 64) return false;
    if (this.scrollQuantum === null) {
      // DPR alone does not determine scrollTop quantization. Observe an
      // accepted step and restore it synchronously, before anything paints.
      const start = scroll.scrollTop, direction = start > (scroll.scrollHeight - scroll.clientHeight) / 2 ? -1 : 1;
      for (const distance of [1, 2, 4]) {
        scroll.scrollTop = start + direction * distance;
        const accepted = Math.abs(scroll.scrollTop - start);
        if (accepted > 0) { this.scrollQuantum = accepted; break; }
      }
      scroll.scrollTop = start;
    }
    const quantum = this.scrollQuantum;
    if (!quantum) return false;
    const total = this.fractionalOffset + error, whole = Math.floor(total / quantum) * quantum;
    this.fractionalOffset = total - whole;
    scroll.style.setProperty('--meo-native-input-scroll-offset', `${this.fractionalOffset}px`);
    if (whole) scroll.scrollTop -= whole;
    return true;
  }

  release(): void { this.anchor = null; this.scrollQuantum = null; }
}
