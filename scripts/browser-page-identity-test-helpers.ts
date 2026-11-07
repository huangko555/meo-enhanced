// Browser fixtures intentionally describe Host inputs before the production
// Webview has finished booting. Keep that ordering, but make the fixture Host
// mirror the identity emitted by this concrete page evaluation instead of
// inventing an ID (or relying on the removed identity-less protocol).
const originalAcquireVsCodeApi = window.acquireVsCodeApi.bind(window);
const originalDispatchEvent = window.dispatchEvent.bind(window);
let pageId: string | undefined;

function isPageBoundHostMessage(value: unknown): value is { type: 'init' | 'requestDraftRecoverySnapshot'; pageId?: unknown } {
  return typeof value === 'object' && value !== null
    && (((value as { type?: unknown }).type === 'init') || ((value as { type?: unknown }).type === 'requestDraftRecoverySnapshot'));
}

function reflectPageIdentity(message: unknown): Event {
  const data = message as { type: string; pageId?: unknown };
  if (!pageId) throw new Error('Fixture Host attempted to initialize before the Webview announced its page identity');
  return new MessageEvent('message', { data: { ...data, pageId } });
}

window.acquireVsCodeApi = () => {
  const api = originalAcquireVsCodeApi();
  return {
    ...api,
    postMessage(message: unknown) {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready') {
        const received = (message as { pageId?: unknown }).pageId;
        if (typeof received !== 'string') throw new Error('Fixture Webview ready message omitted pageId');
        pageId = received;
        api.postMessage(message);
        return;
      }
      api.postMessage(message);
    }
  };
};

window.dispatchEvent = (event: Event): boolean => {
  if (event.type !== 'message' || !isPageBoundHostMessage((event as MessageEvent).data)) return originalDispatchEvent(event);
  if (!pageId || (event as MessageEvent).data?.pageId !== undefined) return originalDispatchEvent(event);
  return originalDispatchEvent(reflectPageIdentity((event as MessageEvent).data));
};
