import { mountSvgDocumentBlock } from './helpers/svgDocumentBlock';
import { mountGraphCanvasPointer } from './helpers/graphCanvasPointer';
import type { DocumentBlockContext, DocumentViewInstance, DocumentViewModule } from '../../src/documentViews';
import type { DocumentViewDescriptor } from '../../src/protocol/documentViews';
import type { DocumentBlockInput, DocumentBlocksPort } from './editor/documentBlocks';
import { createLoadingPresentation, loadingPresentationStyles } from './adapters/loadingPresentation';
import { documentContentStyles } from './documentContentStyles';
import { applyDocumentViewPalette } from './helpers/uiTheme';
import { registerGraphImageRoot } from './helpers/renderedBlockImage';
import { createGraphBlockControls } from './helpers/graphBlockControls';
import { openGraphFullscreen } from './helpers/graphFullscreen';
import { mountMermaidPreviewControls } from './helpers/renderedBlockModeControls';
import { focusRenderedBlockAction } from './helpers/renderedBlockActionFocus';
import { registerPreviewGraphActions, addPreviewCodeCopyControls } from './helpers/previewBlockActions';
import { previewCodeSource } from './helpers/previewCodeSource';
import { getUiStrings, type UiLanguage } from './application/uiLanguage';

const styles = `
:host{display:block;position:relative;color:var(--meo-view-foreground)}
*{box-sizing:border-box} .meo-contributed-canvas{position:relative;height:360px;overflow:hidden;color:var(--meo-view-foreground)}
.meo-contributed-content{position:absolute;inset:0} .meo-contributed-content[data-static]{pointer-events:none}
${loadingPresentationStyles}
.surface-loading{color:var(--meo-view-foreground);background:var(--meo-view-background);font-family:system-ui;--meo-ui-focus:var(--meo-view-focus)}
[hidden]{display:none!important}
.failure{padding:50px 16px;font:13px system-ui;white-space:pre-wrap;overflow:auto;height:100%}.meo-preview-action-status{font:12px system-ui}
`;

type Host = {
  renderContent(text: string): Promise<{ html: string }>;
  getLanguage(): UiLanguage;
  getState(): unknown;
  saveState(state: unknown): void;
};

/** Owns renderer loading, static blocks and the one fullscreen viewer across both reading surfaces. */
export function createDocumentBlocks(host: Host) {
  let views: readonly DocumentViewDescriptor[] = [];
  const modules = new Map<string, Promise<DocumentViewModule>>();
  const mounted = new Set<() => void>();
  const appearanceObserver = new MutationObserver(() => { for (const refresh of mounted) refresh(); });
  appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang', 'data-meo-ui-contrast'] });
  const memories = new Map<string, unknown>();
  const restored = host.getState();
  if (Array.isArray(restored)) for (const entry of restored.slice(-100)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string') memories.set(entry[0], entry[1]);
  }
  let closeFullscreen: (() => void) | undefined;
  let previewDocument: Document | undefined, previewObserver: MutationObserver | undefined;
  const previewBlocks = new Map<HTMLElement, { source: string; element: HTMLElement; dispose(): void }>();
  const descriptor = (language: string) => views.find(view => view.codeBlockLanguages?.includes(language));
  // Only identical authored blocks share viewing memory. Editing the source always wins.
  function memoryKey(input: DocumentBlockInput, id: string) {
    const text = input.language + '\n' + input.text.replace(/\n$/, '');
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
    return `${id}:${input.line}:${text.length}:${a >>> 0}:${b >>> 0}`;
  }
  function save(key: string, state: unknown) {
    try {
      const json = JSON.stringify(state);
      if (!json || json.length > 32768) return;
      memories.delete(key); memories.set(key, JSON.parse(json));
      while (memories.size > 100) memories.delete(memories.keys().next().value!);
      host.saveState([...memories]);
    } catch { /* Viewing memory is optional; malformed extension state cannot break the editor. */ }
  }
  function appearance(surface: HTMLElement, owner: HTMLElement) {
    const doc = owner.ownerDocument, win = doc.defaultView!;
    const reading = doc.querySelector<HTMLElement>('.meo-export-doc') ?? document.body;
    const style = win.getComputedStyle(reading);
    let background = owner.matches('.meo-graph-block,.meo-export-graph')
      ? win.getComputedStyle(owner).backgroundColor : win.getComputedStyle(doc.body).backgroundColor;
    if (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') background = win.getComputedStyle(doc.body).backgroundColor;
    applyDocumentViewPalette(surface, { background, foreground: style.color });
    // Typography is always the ordinary document's, including in preset iframes.
    const root = getComputedStyle(document.documentElement);
    for (const role of ['surface', 'text', 'surface-hover', 'focus']) surface.style.setProperty('--meo-ui-' + role, root.getPropertyValue('--meo-ui-' + role));
    for (const [role, value] of Object.entries({
      'font-family': root.getPropertyValue('--meo-font-live') || root.getPropertyValue('--vscode-editor-font-family') || 'monospace',
      'font-size': root.getPropertyValue('--meo-user-editor-font-size') || root.getPropertyValue('--meo-font-live-size') || '16px',
      'font-weight': root.getPropertyValue('--meo-font-live-weight') || '400',
      'code-font-family': root.getPropertyValue('--meo-font-source') || 'monospace'
    })) surface.style.setProperty('--meo-view-' + role, value);
  }
  function mount(container: HTMLElement, initial: DocumentBlockInput, mode: 'live' | 'preview' | 'fullscreen' = 'live',
    paletteOwner = container) {
    const view = descriptor(initial.language);
    if (!view) return { update(_input: DocumentBlockInput) {}, image: () => null, run(_id: string) {}, dispose() {} };
    const doc = container.ownerDocument, interactive = mode !== 'preview';
    let input = initial, key = memoryKey(input, view.id), revision = 0;
    const element = doc.createElement('div'); element.className = 'meo-contributed-block';
    const shadow = element.attachShadow({ mode: 'open' });
    const sheet = doc.createElement('style'); sheet.textContent = styles + documentContentStyles;
    const canvas = doc.createElement('div'); canvas.className = 'meo-contributed-canvas';
    const content = doc.createElement('div'); content.className = 'meo-contributed-content';
    if (mode === 'fullscreen') { element.style.cssText = 'height:100%;width:100%'; canvas.style.height = '100%'; }
    if (!interactive) { content.dataset.static = ''; content.inert = true; }
    const loading = createLoadingPresentation('document-block-loading');
    canvas.append(content, loading.element); shadow.append(sheet, canvas); container.append(element);
    const pointer = mountGraphCanvasPointer(canvas, { interactive });
    appearance(element, paletteOwner);
    let disposed = false, instance: DocumentViewInstance | undefined, ready = false, failure: HTMLElement | undefined;
    let svgBlock: ReturnType<typeof mountSvgDocumentBlock> | undefined;
    let failureDetail = '';
    let intrinsic: { width: number; height: number } | undefined;
    const canvasInsets = () => {
      if (mode === 'fullscreen') return { top: 16, bottom: 64 };
      // The shared Live shell already reserves toolbar space. Only add what
      // that shell has not provided; Preview has no surrounding canvas padding.
      const style = doc.defaultView!.getComputedStyle(container);
      return { top: Math.max(0, 16 - (parseFloat(style.paddingTop) || 0)),
        bottom: Math.max(0, 32 - (parseFloat(style.paddingBottom) || 0)) };
    };
    const sizeCanvas = () => {
      if (!intrinsic || disposed || mode === 'fullscreen') return;
      const insets = canvasInsets();
      const scale = Math.min(1, Math.max(1, canvas.clientWidth - 32) / intrinsic.width);
      const height = Math.ceil(Math.max(1, Math.min(480, intrinsic.height * scale + insets.top + insets.bottom)));
      if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
    };
    const resize = new ResizeObserver(sizeCanvas); resize.observe(canvas);
    const image = () => ready ? canvas : null;
    const unregisterImage = registerGraphImageRoot(container, image);
    const run = (id: string) => { if (ready) void Promise.resolve(instance?.actions?.find(action => action.id === id)?.run()).catch(console.error); };
    const controls = mode === 'live' ? createGraphBlockControls(doc, host.getLanguage(), {
      zoomIn: () => run('zoom-in'), zoomOut: () => run('zoom-out'), fit: () => run('fit'),
      fullscreen: pointer => openFullscreen(input, controls!.buttons.get('fullscreen')!, paletteOwner, pointer)
    }) : undefined;
    if (controls) container.append(controls.element);
    const detachControls = controls ? mountMermaidPreviewControls(container, controls.element) : () => {};
    const availability = () => {
      container.dataset.meoMermaidRendering = String(!ready);
      for (const button of controls?.buttons.values() ?? []) button.disabled = !ready;
      if (mode === 'preview') addPreviewCodeCopyControls(paletteOwner, host.getLanguage());
    };
    const failed = (error: unknown) => {
      if (disposed) return;
      console.error('Contributed block failed', error); ready = false; loading.finish(); element.removeAttribute('aria-busy');
      failure = doc.createElement('pre'); failure.className = 'failure';
      pointer.reset(); instance?.dispose(); instance = undefined; svgBlock = undefined;
      failureDetail = error instanceof Error ? error.message.slice(0, 1500) + '\n\n' : '';
      failure.textContent = (host.getLanguage() === 'zh-CN' ? '渲染失败，源码保留如下：\n\n' : 'Rendering failed. Original source:\n\n') + failureDetail + input.text;
      content.replaceChildren(failure); availability();
    };
    const present = async () => {
      if (!instance || disposed) return;
      const current = ++revision; ready = false; failure = undefined; availability();
      loading.begin(() => !disposed && revision === current && element.isConnected, () => element.setAttribute('aria-busy', 'true'));
      try {
        await instance.update({ text: input.text, revision: current });
        if (disposed || current !== revision) return;
        if (svgBlock?.appearanceChanged()) { void present(); return; }
        ready = true; loading.finish(); element.removeAttribute('aria-busy'); availability();
      } catch (error) { if (current === revision) failed(error); }
    };
    availability();
    loading.begin(() => !disposed && element.isConnected, () => element.setAttribute('aria-busy', 'true'));
    let initializing: Promise<void> | undefined;
    const initialize = () => initializing ??= (async () => {
      let promise = modules.get(view.entryUri);
      if (!promise) { promise = import(view.entryUri); modules.set(view.entryUri, promise); }
      const module = await promise;
      if (disposed) return;
      if (module.apiVersion !== 1 || (!module.mountBlock && !module.createSvgRenderer)) throw new Error('The extension does not support code blocks');
      // Widgets are built before CodeMirror attaches them. Inherited code-surface
      // colors are authoritative only after mounting, before the first graph paint.
      appearance(element, paletteOwner);
      content.replaceChildren(); failure = undefined;
      const context: DocumentBlockContext = {
        language: host.getLanguage(), contentClass: 'meo-document-content', interactive,
        presentation: mode === 'fullscreen' ? 'fullscreen' : 'inline',
        reportContentSize(size) {
          if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return;
          intrinsic = size; sizeCanvas();
        },
        camera: mode === 'live' ? initial.camera : undefined,
        viewState: mode === 'fullscreen' ? memories.get(key) : undefined,
        saveViewState: state => { if (mode === 'fullscreen' && !disposed) save(key, state); },
        renderContent: snapshot => host.renderContent(snapshot.text), revealLine() {},
        getAvailableViewport() {
          const insets = canvasInsets();
          return { x: 16, y: insets.top, width: Math.max(0, content.clientWidth - 32), height: Math.max(0, content.clientHeight - insets.top - insets.bottom) };
        }
      };
      if (module.createSvgRenderer) {
        pointer.dispose();
        svgBlock = mountSvgDocumentBlock(content, context, module.createSvgRenderer()); instance = svgBlock.instance;
      } else instance = module.mountBlock!(content, context);
      await present();
    })().catch(error => { modules.delete(view.entryUri); failed(error); }).finally(() => { initializing = undefined; });
    void initialize();
    const refresh = () => {
      appearance(element, paletteOwner); instance?.setLanguage?.(host.getLanguage()); controls?.refresh(host.getLanguage());
      loading.setLabel(host.getLanguage() === 'zh-CN' ? '正在加载…' : 'Loading…');
      if (svgBlock?.appearanceChanged() && ready) void present();
      if (failure) failure.textContent = (host.getLanguage() === 'zh-CN' ? '渲染失败，源码保留如下：\n\n' : 'Rendering failed. Original source:\n\n') + failureDetail + input.text;
      if (mode === 'preview') addPreviewCodeCopyControls(paletteOwner, host.getLanguage());
    };
    refresh(); mounted.add(refresh);
    return { image, run,
      update(next: DocumentBlockInput) {
        const changed = next.text !== input.text; input = next; key = memoryKey(input, view.id);
        if (changed) void (instance ? present() : initialize());
      },
      dispose() {
        if (disposed) return;
        pointer.dispose(); instance?.dispose(); disposed = true; resize.disconnect(); loading.finish(); mounted.delete(refresh);
        detachControls(); unregisterImage(); element.remove(); delete container.dataset.meoMermaidRendering;
      }
    };
  }
  function openFullscreen(input: DocumentBlockInput, trigger: HTMLElement, paletteOwner: HTMLElement, pointerDriven: boolean) {
    const viewer = openGraphFullscreen({
      language: host.getLanguage(), pointerDriven,
      mount(canvas) {
        const rendered = mount(canvas, input, 'fullscreen', paletteOwner);
        return { zoomIn: () => rendered.run('zoom-in'), zoomOut: () => rendered.run('zoom-out'), fit: () => rendered.run('fit'), dispose: rendered.dispose };
      },
      onClose(cause, pointer) {
        mounted.delete(refresh); closeFullscreen = undefined;
        if ((cause === 'escape' || cause === 'user-close') && trigger.isConnected) focusRenderedBlockAction(trigger, pointer);
      }
    });
    const refresh = () => viewer.refresh(host.getLanguage()); mounted.add(refresh);
    closeFullscreen = () => viewer.close('external');
  }
  function refreshPreview(doc: Document) {
    if (previewDocument !== doc) {
      previewObserver?.disconnect(); for (const block of previewBlocks.values()) block.dispose(); previewBlocks.clear();
      previewDocument = doc; previewObserver = undefined;
    }
    for (const [block, record] of previewBlocks) if (!block.isConnected || !record.element.isConnected) { record.dispose(); previewBlocks.delete(block); }
    // Optional renderers must be idle when absent or disabled. Keep the current
    // document so a later catalog can mount its existing code blocks on demand.
    if (!views.some(view => view.codeBlockLanguages?.length) || doc.documentElement.dataset.meoPreviewRenderer === 'github-readme') {
      previewObserver?.disconnect(); previewObserver = undefined;
      return;
    }
    if (!previewObserver) {
      let queued = false;
      previewObserver = new MutationObserver(() => {
        if (queued) return; queued = true;
        queueMicrotask(() => { queued = false; if (previewDocument === doc) refreshPreview(doc); });
      });
      previewObserver.observe(doc.body, { childList: true, subtree: true });
    }
    for (const code of doc.querySelectorAll<HTMLElement>('pre > code')) {
      const source = previewCodeSource(code);
      const language = source?.language ?? [...code.classList].find(name => name.startsWith('language-'))?.slice(9) ?? '';
      if (!descriptor(language)) continue;
      const block = code.closest<HTMLElement>('.meo-export-code-block-wrap'); if (!block) continue;
      const lines = code.querySelectorAll('.meo-export-code-line-source');
      const text = source?.source ?? (lines.length ? [...lines].map(line => line.textContent ?? '').join('\n') : code.textContent ?? '');
      const previous = previewBlocks.get(block); if (previous?.source === text) continue;
      previous?.dispose(); previewBlocks.delete(block);
      const rect = block.getBoundingClientRect(); if (rect.bottom < -800 || rect.top > (doc.defaultView?.innerHeight ?? 1000) + 800) continue;
      const holder = doc.createElement('div'); block.append(holder);
      block.classList.add('meo-export-graph');
      const originals = Array.from(block.children).filter(child => child.tagName === 'PRE') as HTMLElement[];
      const displays = originals.map(child => child.style.display); originals.forEach(child => { child.style.display = 'none'; });
      const input = { language, text, line: Number(block.dataset.sourceLine) || 1 };
      const rendered = mount(holder, input, 'preview', block);
      const unregister = registerPreviewGraphActions(block, { image: rendered.image,
        open: (trigger, pointer) => openFullscreen(input, trigger, block, pointer) });
      addPreviewCodeCopyControls(block, host.getLanguage());
      previewBlocks.set(block, { source: text, element: holder, dispose() { unregister(); rendered.dispose(); holder.remove(); block.classList.remove('meo-export-graph'); originals.forEach((child, i) => { child.style.display = displays[i]; }); } });
    }
  }
  const port: DocumentBlocksPort = { get revision() { return views; }, supports: language => !!descriptor(language), mount };
  return {
    port, refreshPreview,
    getDescriptors: () => views.filter(view => view.codeBlockLanguages?.length),
    setViews(next: readonly DocumentViewDescriptor[]) {
      closeFullscreen?.(); views = next;
      for (const block of previewBlocks.values()) block.dispose(); previewBlocks.clear();
      if (previewDocument) refreshPreview(previewDocument);
    },
    refreshAppearance() { for (const refresh of mounted) refresh(); },
    closeFullscreen() { closeFullscreen?.(); },
    dispose() { closeFullscreen?.(); appearanceObserver.disconnect(); previewObserver?.disconnect(); previewDocument = undefined; for (const record of previewBlocks.values()) record.dispose(); previewBlocks.clear(); modules.clear(); }
  };
}
