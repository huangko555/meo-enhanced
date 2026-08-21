import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type FakeDocument = {
  readonly uri: { toString(): string };
  text: string;
  getText(): string;
};

type FakeWillSaveEvent = {
  readonly document: FakeDocument;
  waitUntil(thenable: PromiseLike<unknown>): void;
};

let willSaveListener: ((event: FakeWillSaveEvent) => void) | null = null;
let subscriptionDisposed = false;

mock.module('vscode', () => ({
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
    getText() { return this.text; }
  };
  const other: FakeDocument = {
    uri: { toString: () => 'file:///other.md' },
    text: 'other',
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

  const fire = (document: FakeDocument) => {
    const waiters: Promise<unknown>[] = [];
    willSaveListener?.({
      document,
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
  await fixture.adapter.runPreparedSave(fixture.target.text, async () => {
    preparedWaiters = fixture.fire(fixture.target).length;
    return true;
  });
  assert.equal(preparedWaiters, 0);
  assert.equal(
    fixture.posted.length,
    postedBeforePreparedSave,
    'an exact Document Session prepared save must not re-enter the Webview handshake'
  );
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

console.log('VS Code document save lifecycle Adapter checks passed');
