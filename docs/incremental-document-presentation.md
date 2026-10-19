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

## Shared projections and Live invalidation

Full-string readers in synchronization, editor/search, viewport mapping, Git,
Source highlighting and math share one immutable Text projection. Its cache has
an 8 MiB byte budget (one oversized current projection is allowed). Historical
snapshots do not individually retain complete strings. Tests require one read
per current revision across consumers, and eviction of old projections.

Live caret/word selection and manual math/Mermaid/HTML presentation changes
invalidate their affected source roots. Search-reveal removal also invalidates
its previous range. Changing a manual block mode does not disable local caret
updates elsewhere. Long text selections and unknown effects keep an authoritative
fallback. Tests compare these local results with a complete build under the same
presentation state. Unchanged math/diagram mode fields preserve their values
without validating every manual anchor on unrelated transactions.

Large Live builds now retain a structural geometry plan for offscreen rich
roots, while constructing marks and widgets for the reading window. Source-root,
HTML/details and replacement boundaries close that window; window changes also
retire old ordinary marks. Source snapshots and preview/source mode decisions
certify reused geometry. Gutters follow the same window. Small documents retain
their complete presentation path. A window-local authoritative rebuild remains
the fallback for unknown presentation changes.

The formula last-valid-result owner follows the same band and caret. It no
longer formats every unseen formula on entry or Ctrl+A. Visited results have a
2 MiB HTML budget; shared formula discovery has a 4 MiB/four-snapshot budget.
Merge conflict analysis is immutable per source snapshot across Source/Live.
Parser preparation yields browser tasks rather than waiting two display frames
per slice, retaining cancellation and the previous visible mode. See the
[task scheduling specification](https://wicg.github.io/scheduling-apis/#dom-scheduler-posttask).

On the comprehensive fixture, the local browser diagnostic changed Live build
time from approximately 832 ms to 229 ms, and mount-to-two-frames from 1,357 ms to
635 ms. These are diagnostic samples, not native P95 acceptance. The remaining
global parse/context work is still visible under CPU throttling. Four warm
top-of-document mouse clicks measured 12–20 ms to two frames with no complete
build; this does not establish behavior across the whole document. Native
scrollbar/caret and memory acceptance remains required.

## Preview reading window

The full renderer now separates global parsing/context from HTML generation.
`prepareMarkdownPresentation` exposes balanced presentation blocks and headings;
`renderBlock` formats only the requested block, while `renderAll` retains the
complete export semantics. Raw HTML containers spanning Markdown roots remain
in one block. Reference links, footnotes and duplicate heading slugs retain the
same global context. Repeated block rendering must be idempotent, including
deferred images in the GitHub preset.

The extension owns one Preview worker with a bounded request queue, idle shutdown
and document/cache budgets. Expensive complete Preview requests already run off
the extension event loop. The prepared-document path supports requested blocks,
rendered-text search, source/fragment location and selection copying; each panel
has a Host-assigned owner, and cannot access another panel's parsed context.
The worker asset is included in build, installed-Node and VSIX checks.

The comprehensive fixture diagnostic measured about 403 ms preparation, 5 ms
for the first twelve blocks (19,256 HTML characters), and a further 688 ms for
complete HTML generation (4,898,427 characters). This is a local producer
diagnostic, not a native end-to-end comparison.

Large Preview requests now use a logical block-height index and a bounded DOM
window. The complete parse retains global reference/footnote/heading semantics;
only nearby block HTML is generated and mounted. The full renderer remains the
export and accessibility route. Explicit source and fragment navigation loads
its target before revealing it, with a current-interaction guard. Native scroll
boundary intent survives corrections to estimated gap heights.

Search counts, offscreen headings, fragment location and copying use the prepared
document, independently of mounted DOM. Only visible search matches get browser
marks. Cross-window partial copying captures hydrated DOM endpoints and requests
unmounted interior blocks; Ctrl+A/C includes the full document. Clipboard writes
are still subject to native Webview acceptance, not established by a test writer.
Hidden windows stop mounting/resource work. Appearance-only refreshes can reuse
the current DOM and geometry with a new parser context. Image/math/table/diagram
owners are refreshed when blocks enter and retire from the reading window.

Browser verification covers 5,000 paragraphs, distant search/navigation,
bounded DOM, complete and partial formatted copying, and runtime accessibility
changes. The built production page covers Source input/undo, hidden Preview,
distant resource mounting, immediate edited Source/Live-to-Preview round trips
and reading-position restoration. Installed Node verifies the packaged worker,
CPU isolation, requested blocks, offscreen search, owner isolation and release.
Very large individual roots and end-to-end native latency remain open work.

Endnotes also have individual reading blocks. Their Markdown is parsed in the
original global preparation order, preserving reference and heading identities;
code/HTML formatting is delayed until that definition is requested. The complete
HTML/export route still emits the original single endnote section. A differential
check on the comprehensive fixture found identical complete HTML/styles/metadata
for both built-in presets (4,898,427 / 4,262,898 HTML characters). Its 150 endnotes
no longer mount as one giant footer. Source lookup accounts for all endnote
definitions, whose visual order can differ from authored order.

Keyboard navigation has current-intent guards, ref-counted target leases and
retirement of obsolete failures. A late Ctrl+End cannot override a later Ctrl+Home;
cancelling a fragment lookup during replacement cannot fail the new surface.
Tests cover these with deliberately delayed/rejected requests, along with
cross-screen endnote source/fragment navigation. A 1,000-definition producer test
requires one requested definition to return one small block.

Accessibility detection must use VS Code's documented `vscode-using-screen-reader`
body class, including a change during a session. Until continuous virtual reading
is independently supported, that route retains complete accessible DOM while
benefiting from background computation. See the official
[Webview accessibility guidance](https://code.visualstudio.com/api/extension-guides/webview#accessibility).
Virtual selection copying can start a ClipboardItem with promised HTML/text data
at the user's copy event; this preserves activation while content is prepared.
See [ClipboardItem data](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/ClipboardItem).

Native V36 acceptance at `fe5e773e` passed functional checks, including complete
formatted Windows clipboard copying. Performance remained below target: the
1 MiB comprehensive fixture entered Live/Preview in 5.2/5.8 seconds, Live caret
samples reached 592 ms, and Source/Live input peaks reached 585/593 ms. Preview
native scrollbar samples reached 191 ms. These are not completion criteria.
The guest used four CPUs, 6 GiB RAM and a 1 GiB memory balloon, so timings are not
an unqualified comparison with previous guest runs. A separate profiling run is
diagnostic only; instrumentation changes latency.

That native CPU profile found 414 ms of synchronous Shiki grammar compilation
and tokenization overlapping a Live click. Production Shiki now owns a classic
blob Worker per active coloring surface. The packaged 737 KB script includes
the engine and WASM; language registrations are loaded lazily and cloned into
the worker, so the sandboxed worker needs no imports or remote access. The
foreground retains the existing presentation/cache interface. Each engine has
one running request and a bounded pending queue; superseded text cannot publish,
and theme replacement or last-consumer release terminates the engine. Failure
does not route CPU work back to the editor thread. Test harnesses without the
packaged worker URI retain the original route for differential verification.

`test-shiki-worker.ts` compares 60 actual Worker outputs with the original
browser route across Live/Preview/Source, injected languages, empty lines,
Unicode and CRLF. It also checks engine disposal, cancellation on theme change,
and that a cold grammar plus 6,000 code lines lets the foreground event loop
continue. This establishes the coloring boundary, not final native latency.
