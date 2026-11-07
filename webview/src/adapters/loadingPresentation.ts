import { loadingPresentationStyles } from '../../../src/foundation/loadingPresentationStyles';
export { loadingPresentationStyles };

/** Callers choose immediate feedback for empty regions and own readiness and cancellation. */
export function createLoadingPresentation(className: string) {
  if (!document.getElementById('meo-loading-presentation-style')) {
    const style = document.createElement('style'); style.id = 'meo-loading-presentation-style';
    style.textContent = loadingPresentationStyles; document.head.append(style);
  }
  const element = document.createElement('div');
  element.className = `surface-loading ${className}`;
  element.hidden = true;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  const spinner = document.createElement('span');
  spinner.className = `surface-loading-spinner ${className}-spinner`;
  spinner.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  element.append(spinner, label);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    element,
    get pending() { return pending; },
    setLabel(text: string) { label.textContent = text; },
    begin(canShow: () => boolean, onVisible: () => void, { immediate = false }: { readonly immediate?: boolean } = {}) {
      if (pending && (!immediate || !element.hidden)) return;
      pending = true;
      const show = () => {
        timer = undefined;
        if (!pending || !canShow()) return;
        element.hidden = false;
        onVisible();
      };
      if (immediate) {
        clearTimeout(timer);
        show();
      } else timer = setTimeout(show, 200);
    },
    finish(retainCover = false) {
      clearTimeout(timer); timer = undefined; pending = false;
      if (!retainCover) element.hidden = true;
    }
  };
}
