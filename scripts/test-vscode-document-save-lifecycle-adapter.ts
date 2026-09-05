import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type FakeDocument = {
  readonly uri: { toString(): string };
  text: string;
  version: number;
  getText(): string;
};

type FakeWillSaveEvent = {
  readonly document: FakeDocument;
  readonly reason: number;
  waitUntil(thenable: PromiseLike<unknown>): void;
};

let willSaveListener: ((event: FakeWillSaveEvent) => void) | null = null;
let subscriptionDisposed = false;

mock.module('vscode', () => ({
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  workspace: {
    onWillSaveTextDocument(listener: (event: FakeWillSaveEvent) => void) {
      willSaveListener = listener;
      return { dispose: () => { subscriptionDisposed = true; } };
    }
  }
}));

const { createVscodeDocumentSaveLifecycleAdapter } = await import(
  '../src/host/vscodeDocumentSaveLifecycleAdapter'
);

type Scheduled = { callback: () => void; canceled: boolean };

const createFixture = () => {
  subscriptionDisposed = false;
  const target: FakeDocument = {
    uri: { toString: () => 'file:///target.md' },
    text: 'accepted',
    version: 1,
    getText() { return this.text; }
  };
  const other: FakeDocument = {
    uri: { toString: () => 'file:///other.md' },
    text: 'other',
    version: 1,
    getText() { return this.text; }
  };
  const posted: Array<{ type: 'flushDocumentEdits'; requestId: string }> = [];
  const failures: string[] = [];
  const scheduled: Scheduled[] = [];
  let postResult = true;
  let postError: Error | null = null;
  const adapter = createVscodeDocumentSaveLifecycleAdapter({
    document: target as never,
    postMessage: async (message) => {
      posted.push(message);
      if (postError) throw postError;
      return postResult;
    },
    showFailure: (message) => { failures.push(message); }
  }, {
    timeoutMs: 25,
    scheduleTimeout: (callback) => {
      const timeout = { callback, canceled: false };
      scheduled.push(timeout);
      return timeout;
    },
    cancelTimeout: (timeout) => { (timeout as Scheduled).canceled = true; }
  });

  const fire = (document: FakeDocument, reason = 1) => {
    const waiters: Promise<unknown>[] = [];
    willSaveListener?.({
      document,
      reason,
      waitUntil(thenable) { waiters.push(Promise.resolve(thenable)); }
    });
    return waiters;
  };

  return {
    adapter,
    target,
    other,
    posted,
    failures,
    scheduled,
    fire,
    setPostResult(value: boolean) { postResult = value; },
    setPostError(error: Error | null) { postError = error; }
  };
};

{
  const fixture = createFixture();
  assert.equal(fixture.fire(fixture.other).length, 0, 'non-target documents must not enter the handshake');
  assert.equal(fixture.posted.length, 0);

  const firstWaiters = fixture.fire(fixture.target);
  const duplicateWaiters = fixture.fire(fixture.target);
  assert.equal(firstWaiters.length, 1);
  assert.equal(duplicateWaiters.length, 1);
  assert.equal(fixture.posted.length, 1, 'duplicate will-save events share the bounded in-flight request');
  const request = fixture.posted[0];
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: 'stale',
    result: { ok: true, value: { text: fixture.target.text } }
  }), false);
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), true);
  await Promise.all([...firstWaiters, ...duplicateWaiters]);
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), false, 'duplicate response must have no side effect');

  const postedBeforePreparedSave = fixture.posted.length;
  let preparedWaiters = -1;
  let independentWaiters = -1;
  await fixture.adapter.runPreparedSave(async () => {
    preparedWaiters = fixture.fire(fixture.target).length;
    const waiters = fixture.fire(fixture.target);
    independentWaiters = waiters.length;
    const independentRequest = fixture.posted.at(-1);
    assert.ok(independentRequest);
    assert.equal(fixture.adapter.accept({
      type: 'flushDocumentEditsResult',
      requestId: independentRequest.requestId,
      result: { ok: true, value: { text: fixture.target.text } }
    }), true);
    await Promise.all(waiters);
    return true;
  });
  assert.equal(preparedWaiters, 0);
  assert.equal(independentWaiters, 1, 'the one-shot correlation must not bypass a second will-save event');
  assert.equal(
    fixture.posted.length,
    postedBeforePreparedSave + 1,
    'only the concrete Document Session save event may bypass the Webview handshake'
  );
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  await fixture.adapter.runPreparedSave(async () => {
    const autoSaveWaiters = fixture.fire(fixture.target, 2);
    assert.equal(autoSaveWaiters.length, 1, 'an independent auto-save must not consume manual correlation');
    const autoSaveRequest = fixture.posted.at(-1);
    assert.ok(autoSaveRequest);
    fixture.adapter.accept({
      type: 'flushDocumentEditsResult',
      requestId: autoSaveRequest.requestId,
      result: { ok: true, value: { text: fixture.target.text } }
    });
    await Promise.all(autoSaveWaiters);
    assert.equal(fixture.fire(fixture.target, 1).length, 0, 'the concrete manual event consumes the correlation');
    return true;
  });
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  fixture.target.text = 'a\r\nb';
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: 'a\r\nb' } }
  }), true);
  await Promise.all(waiters);
  assert.deepEqual(fixture.failures, [], 'raw CRLF text must match the same raw CRLF response');
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  fixture.target.text = 'a\r\nb';
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: 'a\nb' } }
  }), true);
  await Promise.all(waiters);
  assert.deepEqual(fixture.failures, [], 'CRLF and LF-equivalent text must match');
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  fixture.target.text = 'a\r\nb';
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: 'a\ndifferent' } }
  }), true);
  await Promise.all(waiters);
  assert.match(fixture.failures[0] ?? '', /did not reach the editor Revision/);
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  fixture.target.text = 'different TextDocument Revision';
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: 'accepted' } }
  }), true);
  await Promise.all(waiters);
  assert.match(fixture.failures[0] ?? '', /did not reach the editor Revision/);
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  fixture.scheduled[0].callback();
  await Promise.all(waiters);
  assert.match(fixture.failures[0] ?? '', /Timed out/);
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), false, 'late response after timeout must have no side effect');
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  fixture.setPostResult(false);
  const waiters = fixture.fire(fixture.target);
  await Promise.all(waiters);
  assert.match(fixture.failures[0] ?? '', /Webview was unavailable/);
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  fixture.setPostError(new Error('post failed'));
  const waiters = fixture.fire(fixture.target);
  await Promise.all(waiters);
  assert.match(fixture.failures[0] ?? '', /post failed/);
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  const waiters = fixture.fire(fixture.target);
  const request = fixture.posted[0];
  fixture.adapter.dispose();
  await Promise.all(waiters);
  assert.equal(subscriptionDisposed, true);
  assert.match(fixture.failures[0] ?? '', /editor closed/);
  assert.equal(fixture.fire(fixture.target).length, 0);
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult',
    requestId: request.requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), false, 'disposed lifecycle must reject a late response');
}

for (const outcome of ['success', 'mismatch', 'timeout', 'unavailable', 'dispose'] as const) {
  const fixture = createFixture();
  const waiters = fixture.fire(fixture.target, 2);
  const original = fixture.posted[0];
  fixture.target.text = 'newer accepted input';
  fixture.target.version += 1;
  if (outcome === 'unavailable') fixture.setPostResult(false);
  fixture.adapter.accept({
    type: 'flushDocumentEditsResult', requestId: original.requestId,
    result: { ok: true, value: { text: 'accepted' } }
  });
  assert.equal(fixture.posted.length, 2, 'a changed document must request a fresh snapshot before reporting mismatch');
  const retry = fixture.posted[1];
  assert.notEqual(retry.requestId, original.requestId, 'refresh must not replay the cached old snapshot');
  assert.equal(fixture.scheduled.length, 1, 'refresh must share the original save budget');
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult', requestId: original.requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), false, 'a late first response must not complete the refreshed request');
  if (outcome === 'timeout') fixture.scheduled[0].callback();
  else if (outcome === 'dispose') fixture.adapter.dispose();
  else if (outcome !== 'unavailable') {
    if (outcome === 'mismatch') fixture.target.version += 1;
    fixture.adapter.accept({
      type: 'flushDocumentEditsResult', requestId: retry.requestId,
      result: { ok: true, value: { text: outcome === 'success' ? fixture.target.text : 'unconfirmed draft' } }
    });
  }
  await Promise.all(waiters);
  assert.equal(fixture.posted.length, 2, 'continued changes must not create an unbounded refresh loop');
  if (outcome === 'success') assert.deepEqual(fixture.failures, []);
  else {
    assert.equal(fixture.failures.length, 1);
    assert.match(fixture.failures[0], /unconfirmed/);
  }
  fixture.adapter.dispose();
}

{
  const fixture = createFixture();
  const firstWaiters = fixture.fire(fixture.target, 2);
  fixture.adapter.accept({
    type: 'flushDocumentEditsResult', requestId: fixture.posted[0].requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  });
  await Promise.all(firstWaiters);
  const secondWaiters = fixture.fire(fixture.target, 3);
  fixture.scheduled[0].callback();
  assert.equal(fixture.adapter.accept({
    type: 'flushDocumentEditsResult', requestId: fixture.posted[1].requestId,
    result: { ok: true, value: { text: fixture.target.text } }
  }), true, 'a canceled timer from an older save must not settle a later preparation');
  await Promise.all(secondWaiters);
  assert.deepEqual(fixture.failures, []);
  fixture.adapter.dispose();
}

console.log('VS Code document save lifecycle Adapter checks passed');
