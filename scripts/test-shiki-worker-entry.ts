import { activateShikiCodeHighlighting, setShikiTheme, requestShikiTokens, getShikiTokens, subscribeShikiRefresh } from '../webview/src/helpers/shikiHighlighter';
import type { RawVscodeTheme, ShikiSurface } from '../webview/src/helpers/shikiHighlighter';

(window as any).shikiWorkerHarness = {
  activateShikiCodeHighlighting, setShikiTheme, getShikiTokens, requestShikiTokens,
  async request(lang: string, code: string, surface: ShikiSurface) {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { release(); reject(new Error('No worker tokens: ' + lang)); }, 25_000);
      const read = () => {
        const tokens = getShikiTokens(lang, code, surface);
        if (tokens) { release(); clearTimeout(deadline); resolve(tokens); }
      };
      const release = subscribeShikiRefresh(read, surface);
      requestShikiTokens(lang, code, surface); read();
    });
  },
  start(theme: RawVscodeTheme, surface: ShikiSurface) {
    setShikiTheme(theme, surface);
    const release = activateShikiCodeHighlighting(surface);
    ((window as any).shikiReleases ??= []).push(release);
  },
  stop() { for (const release of (window as any).shikiReleases.splice(0)) release(); }
};
