import { loadingPresentationStyles } from '../foundation/loadingPresentationStyles';

/** Keep viewport and feedback stable before external styles and modules load. */
export function getWebviewPreloadShellCss(): string {
  return `
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
      body { background: var(--meo-background, var(--vscode-editor-background)); }
      #app {
        position: fixed; inset: 0; height: 100%; min-height: 0; min-width: 0;
        display: flex; flex-direction: column; overflow: clip;
      }
      #app > .mode-toolbar.meo-preload-toolbar {
        position: absolute; inset: 0 0 auto; height: 40px; min-height: 40px;
        box-sizing: border-box; background: var(--vscode-sideBar-background);
      }
      #app > .editor-wrapper.meo-preload-editor-shell {
        position: absolute; inset: 40px 0 0; min-height: 0; display: flex;
      }
      #app > .editor-wrapper.meo-preload-editor-shell > .editor-host {
        flex: 1; min-width: 0; min-height: 0;
        background: var(--meo-background, var(--vscode-editor-background));
      }
      ${loadingPresentationStyles}
      .meo-startup-loading {
        inset: 40px 0 0; font-family: var(--vscode-font-family, system-ui);
        --meo-ui-focus: var(--vscode-focusBorder, currentColor);
      }
    `;
}

export function getWebviewPreloadShellMarkup(language: 'en' | 'zh-CN' = 'en'): string {
  return `
          <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
          <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
            <div class="editor-host"></div>
          </div>
          <div class="surface-loading meo-startup-loading" role="status" aria-live="polite">
            <span class="surface-loading-spinner" aria-hidden="true"></span>
            <span>${language === 'zh-CN' ? '正在加载…' : 'Loading…'}</span>
          </div>
        `;
}
