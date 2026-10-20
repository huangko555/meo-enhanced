let source: { uri: string; promise: Promise<string> } | undefined;

/** Load a packaged classic worker under the webview CSP. The caller owns its
 * request/revision policy; this adapter owns browser resources and wire events. */
export async function createClassicWorkerTransport<Request, Response>(uri: string,
  receive: (response: Response) => void, fail: (error: Error) => void
): Promise<{ send(request: Request): void; dispose(): void }> {
  if (source?.uri !== uri) {
    const promise = fetch(uri, { signal: AbortSignal.timeout(5_000) }).then(response => {
      if (!response.ok) throw new Error('Could not load parser worker');
      return response.text();
    });
    source = { uri, promise };
    void promise.catch(() => { if (source?.promise === promise) source = undefined; });
  }
  const script = await source.promise;
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
  worker.onmessage = ({ data }: MessageEvent<Response>) => receive(data);
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Parser worker failed')); };
  worker.onmessageerror = () => fail(new Error('Parser worker response could not be read'));
  return { send: request => worker.postMessage(request), dispose: () => worker.terminate() };
}
