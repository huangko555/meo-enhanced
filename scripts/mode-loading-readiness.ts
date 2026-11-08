export type ModeLoadingReadiness = Readonly<{
  content: boolean;
  interactive: boolean;
}>;

type BenchmarkWindow = Window & typeof globalThis & {
  __modeLoadingReadiness?: (mode: string, marker: string) => ModeLoadingReadiness;
};

/** Keeps the historical first-content predicate available beside a stricter TTI predicate. */
export function installModeLoadingReadiness(): void {
  const scope = window as BenchmarkWindow;
  const isVisible = (element: HTMLElement | null | undefined): element is HTMLElement => {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.width > 0 && rect.height > 0;
  };
  scope.__modeLoadingReadiness = (mode, marker) => {
    const root = document.getElementById('app');
    const host = document.querySelector<HTMLElement>('.editor-host');
    if (root?.dataset.mode !== mode || document.querySelector(`button[data-mode="${mode}"]`)?.getAttribute('aria-selected') !== 'true') {
      return { content: false, interactive: false };
    }
    const content = mode === 'preview'
      ? !host?.hasAttribute('data-preview-cover')
        && document.querySelector<HTMLElement>('.preview-host')?.hidden === false
        && document.querySelector<HTMLElement>('.preview-status')?.hidden === true
        && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc')?.textContent?.includes(marker)
      : host?.hidden === false && !!host.querySelector('.cm-content')?.textContent?.includes(marker);
    if (!content) return { content: false, interactive: false };

    // These are the same bootstrap covers that native admission treats as a
    // blocked Webview. They are document-wide, unlike a pending side Preview.
    if (document.querySelector('.meo-preload-toolbar, .meo-preload-editor-shell')
      || isVisible(document.querySelector<HTMLElement>('.meo-startup-loading'))) {
      return { content: true, interactive: false };
    }

    if (mode === 'preview') {
      const previewHost = document.querySelector<HTMLElement>('.preview-host');
      const previewFrame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      const previewDocument = previewFrame?.contentDocument;
      const previewLoading = document.querySelector<HTMLElement>('.preview-loading');
      const preparation = document.querySelector<HTMLElement>('.editor-surface');
      const interactive = isVisible(previewHost)
        && previewHost?.inert === false
        && !previewHost.closest('[inert]')
        && previewHost.getAttribute('aria-busy') !== 'true'
        && (previewLoading === null || previewLoading.hidden === true)
        && previewDocument?.documentElement.inert === false
        && !preparation?.hasAttribute('data-source-preview-preparing')
        && !preparation?.hasAttribute('data-preview-preparing');
      return { content: true, interactive };
    }

    const editorLoading = document.querySelector<HTMLElement>('.editor-loading');
    return {
      content: true,
      interactive: isVisible(host)
        && host?.inert === false
        && !host.closest('[inert]')
        && host.getAttribute('aria-busy') !== 'true'
        && !host.hasAttribute('data-preview-cover')
        // Older builds did not publish a loading surface; absent is accepted,
        // but a present visible cover cannot be interactive.
        && (editorLoading === null || editorLoading.hidden === true)
    };
  };
}
