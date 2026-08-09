import { createImagePresentationApplication } from '../webview/src/application/imagePresentation';
import { createImagePresentationRuntime } from '../webview/src/adapters/imagePresentationRuntime';
import {
  createCodeMirrorDomImagePresentationAdapter,
  createImagePresentationResourcePool,
  loadBrowserImage
} from '../webview/src/editor/imagePresentationAdapter';

type CandidateInstance = {
  present(sourceKey: string, rawSrc: string): void;
  externalDocumentPresented(): void;
  whenCurrentPresentationSettles(): Promise<void>;
  state(): ReturnType<ReturnType<typeof createImagePresentationApplication>['getState']>;
  dispose(): void;
};

type CandidateEnvironment = {
  create(root: HTMLElement, contextKey: string, altText: string): CandidateInstance;
  counts(): {
    applications: number;
    runtimes: number;
    adapters: number;
    resourcePools: number;
    resolveCalls: number;
    loadCalls: number;
    preservedReplacements: number;
    legacyWidgets: number;
  };
  dispose(): void;
};

type CandidateHarness = {
  createEnvironment(
    resolveSource: (contextKey: string, rawSrc: string) => Promise<string | null>
  ): CandidateEnvironment;
};

(globalThis as typeof globalThis & { ImagePresentationCandidate?: CandidateHarness })
  .ImagePresentationCandidate = {
    createEnvironment(resolveSource) {
      let applications = 0;
      let runtimes = 0;
      let adapters = 0;
      let resolveCalls = 0;
      let loadCalls = 0;
      let preservedReplacements = 0;
      const instances = new Set<CandidateInstance>();
      const resources = createImagePresentationResourcePool({
        async resolveSource(contextKey, rawSrc) {
          resolveCalls += 1;
          return resolveSource(contextKey, rawSrc);
        },
        async loadImage(resolvedSrc) {
          loadCalls += 1;
          return loadBrowserImage(resolvedSrc);
        }
      });

      return {
        create(root, contextKey, altText) {
          applications += 1;
          adapters += 1;
          runtimes += 1;
          const application = createImagePresentationApplication();
          const adapter = createCodeMirrorDomImagePresentationAdapter({
            resources,
            resourceContextKey: contextKey,
            view: {
              showFallback(sourceKey) {
                const fallback = root.ownerDocument.createElement('code');
                fallback.className = 'meo-md-image-fallback-text';
                fallback.textContent = sourceKey;
                root.classList.add('meo-md-image-fallback');
                root.replaceChildren(fallback);
              },
              showImage(loaded) {
                const image = loaded.cloneNode(false) as HTMLImageElement;
                image.className = 'meo-md-image-img';
                image.alt = altText;
                root.classList.remove('meo-md-image-fallback');
                root.replaceChildren(image);
              },
              preserveLayoutChange(apply) {
                preservedReplacements += 1;
                const active = root.ownerDocument.activeElement;
                const selection = root.ownerDocument.getSelection()?.toString() ?? '';
                const scrollTop = root.ownerDocument.scrollingElement?.scrollTop ?? 0;
                apply();
                if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
                if (root.ownerDocument.scrollingElement) {
                  root.ownerDocument.scrollingElement.scrollTop = scrollTop;
                }
                if (selection && root.ownerDocument.getSelection()?.toString() !== selection) {
                  throw new Error('image replacement changed the document selection');
                }
              }
            }
          });
          const runtime = createImagePresentationRuntime({ application, executor: adapter });
          let disposed = false;
          const instance: CandidateInstance = {
            present(sourceKey, rawSrc) {
              runtime.dispatch({ type: 'present', sourceKey, rawSrc });
            },
            externalDocumentPresented() {
              runtime.dispatch({ type: 'externalDocumentPresented' });
            },
            whenCurrentPresentationSettles: () => runtime.whenCurrentPresentationSettles(),
            state: () => application.getState(),
            dispose() {
              if (disposed) return;
              disposed = true;
              runtime.dispose();
              instances.delete(instance);
            }
          };
          instances.add(instance);
          return instance;
        },
        counts: () => ({
          applications,
          runtimes,
          adapters,
          resourcePools: 1,
          resolveCalls,
          loadCalls,
          preservedReplacements,
          legacyWidgets: 0
        }),
        dispose() {
          for (const instance of [...instances]) instance.dispose();
          resources.dispose();
        }
      };
    }
  };
