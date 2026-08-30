import { createElement, Code2, Columns2, Eye } from 'lucide';
import type { RenderedBlockModeShellDecision } from '../editor/renderedBlockModeShell';

export function renderRenderedBlockModeButton(
  button: HTMLButtonElement,
  decision: RenderedBlockModeShellDecision
): void {
  const icon = decision.modeButton.action === 'edit'
    ? Columns2
    : decision.modeButton.action === 'source'
      ? Code2
      : Eye;
  button.replaceChildren(createElement(icon, { width: 15, height: 15 }));
  button.setAttribute('aria-label', decision.modeButton.label);
  button.title = decision.modeButton.label;
}

export function retainRenderedBlockModePointerFocus(button: HTMLButtonElement): void {
  button.addEventListener('pointerdown', (event) => {
    if (event.button === 0) {
      // Keep the embedded source editor alive until the click handler has
      // committed the mode transition. A pointer-driven blur can otherwise
      // project pending input and replace the toolbar before `click` fires.
      event.preventDefault();
    }
  });
}
