import type { EditorView } from '@codemirror/view';

/** Native widget input owns its painted position until the next user intent.
 * Background parsing can finish after any fixed animation-frame retry window.
 * This record schedules no work itself. */
export class NativeInputViewport {
  private anchor: { input: HTMLTextAreaElement; top: number } | null = null;

  constructor(private readonly view: EditorView) {}

  capture(target: EventTarget | null): boolean {
    const window = this.view.dom.ownerDocument?.defaultView;
    if (!window || !(target instanceof window.HTMLTextAreaElement)
      || !this.view.contentDOM.contains(target)
      || !target.closest('[data-meo-rendered-block-start-line]')
      || this.view.dom.ownerDocument.activeElement !== target) return false;
    const bounds = target.getBoundingClientRect(), viewport = this.view.scrollDOM.getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return false;
    this.anchor = { input: target, top: bounds.top };
    return true;
  }

  hasOwner(): boolean {
    if (!this.anchor) return false;
    if (this.anchor.input.isConnected && this.view.dom.ownerDocument.activeElement === this.anchor.input) return true;
    this.release();
    return false;
  }

  scrollTop(): number | null {
    return this.hasOwner()
      ? this.view.scrollDOM.scrollTop + this.anchor!.input.getBoundingClientRect().top - this.anchor!.top
      : null;
  }

  release(): void { this.anchor = null; }
}
