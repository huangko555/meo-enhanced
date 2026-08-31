import { createEditor, refreshMermaidTheme } from './test-editor-factory';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { setShikiTheme, type RawVscodeTheme } from '../webview/src/helpers/shikiHighlighter';

function applyCodeTheme(appearance: 'light' | 'dark'): void {
  setShikiTheme((appearance === 'light' ? lightPlus : darkPlus) as RawVscodeTheme);
}

(globalThis as typeof globalThis & {
  MermaidEditingHarness?: {
    createEditor: typeof createEditor;
    refreshMermaidTheme: typeof refreshMermaidTheme;
    applyCodeTheme: typeof applyCodeTheme;
  };
}).MermaidEditingHarness = { createEditor, refreshMermaidTheme, applyCodeTheme };
