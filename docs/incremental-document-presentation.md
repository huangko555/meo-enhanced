# Incremental document processing and viewport presentation

This work extends the large-document branch beyond time slicing and transport
compression. Source, Live and Preview keep their existing editing/rendering
semantics. The shared facts are local document revisions, immutable source
snapshots, edit ranges, source anchors and resource identities. Lezer and
Markdown-it do not share an AST.

## Implementation order

1. Carry real editor transactions through Document Session and recovery; keep
   full strings at snapshot, save, export and external reconciliation seams.
2. Make derived results explicitly current for their document and configuration;
   prioritize input and the visible surface, cancel obsolete work and bound caches.
3. Make Live readiness and widget construction depend on the current viewport,
   including selection-only updates and very large individual blocks.
4. Separate Preview parsing, block generation and viewport DOM mounting. Search,
   copying, keyboard/accessibility navigation and source anchors must be migrated
   together before replacing the complete DOM presentation.
5. Coordinate mode transitions, resource leases, geometry invalidation and cache
   budgets, reusing the existing mode, image and Mermaid owners.
6. Remove superseded mechanisms and verify the complete behavior matrix.

Local drafts must update the interface before Host acknowledgement. Host ACKs
confirm the synchronization base; they do not gate the caret or local rendering.
Saving, recovery receipts, external conflict handling and undo retain their
existing owners. Worker mirrors and presentation caches are disposable derived
data, never additional writable document truth.

## Transaction slice

`DocumentTextSnapshot` and `DocumentTextEdit` are immutable, in-process values.
The CodeMirror adapter retains the existing persistent Text and ChangeSet;
transactions compose/invert edits without materializing the whole document.
Document Session retains these same snapshots for drafts and pending changes.
External reconciliation and string consumers continue to read exact snapshots.

The editor emits a composed transaction after IME confirmation. A candidate's
confirmed save text remains a Text handle until the save seam reads it. Source
and Live use the same callback. Preview and link/outline refreshes retain a
snapshot until their scheduled work actually runs.

Host changes use the actual edit ranges, including disjoint multi-cursor edits.
After an ACK, edits made ahead of the platform document are rebased by composing
the inverse pending edit with the latest draft edit. Recovery can transport a
batch of non-overlapping changes against one receipt checkpoint. A missing or
invalid checkpoint still requests a complete latest snapshot. Unicode boundaries
are expanded and overlapping expansions merged before transport.

The legacy string input remains available for external/standalone callers, and
uses the existing bounded replacement fallback. There is no production editor
callback that eagerly emits a complete string on every keystroke. Standalone
test fixtures adapt their existing string observation callbacks at the test seam.

## Verification and targets

The transaction budget test drives the real Webview Document Session adapter
with a roughly 1 MiB document, delayed ACKs, disjoint edits and a CJK replacement.
After the first recovery checkpoint it requires zero full snapshot reads, exact
Host text and bounded serialized payload. A second test compares transaction and
string semantics over 120 edits queued behind ACKs, then save and external input.
Recovery tests cover batch ordering, overlapping changes, malformed payloads,
checkpoint loss, stale receipts and complete-snapshot repair.

These work-count checks do not establish input-to-paint latency. Native Windows
IME candidate windows also require separate acceptance from browser composition
events. End-to-end targets on fixed hardware are P95 input/caret feedback near
100 ms, readable Preview viewport near one second, and scrolling frames near
16–33 ms, with worst cases reported. The existing 500 ms severe-stall threshold
is not a definition of a fluid editor. Small documents, the comprehensive 1 MiB
fixture, larger stress fixtures and giant single blocks must all be exercised.
