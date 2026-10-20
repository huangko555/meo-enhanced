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

Structural descriptor readers now pin the syntax tree they started traversing.
Nested code-indent/footnote readers cannot repeatedly advance embedded parsers
or change the tree mid-collection. The regression fixture originally made 160
ensure calls for 80 code blocks; the same production collection now makes zero,
and complete table discovery resolves at most one syntax snapshot.

Source code-row presentation now belongs to a viewport ViewPlugin instead of a
whole-document StateField. Input in a 9,000-row code fixture originally performed
9,004 line lookups; it now performs 58, while distant rows receive the same
background styling when mounted. The existing long-code interaction and Live
scan-budget suites still pass. Hidden or inactive Preview source markers retain
source intent without reading their iframe document/layout during editor input.

Outer Markdown comparisons now skip a shared immutable Lezer subtree after
checking its type and mapped bounds. A subtree spanning another edit must still
be traversed, including compensating insert/delete edits with unchanged outer
endpoints. The shared 6,000-line rich-paragraph regression originally took
144,012 cursor steps across two comparisons and now takes fewer than 200.

Editing work budgets are independent from the default Source opening and
lightweight Source syntax policies. A quarter of the shared pressure budget,
or at least 48 named code fences, activates bounded editor work. This covers
the short rich-document native failure without changing its initial mode or
Source palette. Sessions already using a work budget continue assessing growth
into the larger Source policy. Regression coverage includes full Source tokens,
composition deferral, exact text/undo, reading position and mode transitions.

Global table geometry no longer constructs detailed cell models. Its reader
retains the content model's header, delimiter and body bounds while skipping
cell splitting and inline parsing. The regression fixture previously constructed
107 detailed models for a position query; it now constructs none and preserves
all source ranges, including list/quote/footnote containers. An additional
diagnostic found exact geometry parity for all 361 tables in the comprehensive
fixture. This work-count reduction is not a native latency claim.

CodeMirror's documented parser scheduler and immutable tree sharing remain the
syntax owner. Its maintainers explain why moving the complete state/tree through
worker boundaries introduces significant coordination and serialization costs:
[parser scheduling discussion](https://discuss.codemirror.net/t/some-thoughts-and-requests-about-how-cm6-schedules-parsing/3045).
The [public ParseContext API](https://codemirror.net/docs/ref/#language.ParseContext)
provides skipping and asynchronous nested-language loading; it does not itself
provide asynchronous document-state editing. Shiki's independent output is a
better fit for CPU isolation than duplicating the authoritative editing state.

Each coloring surface now has an 8 MiB estimated retained-token budget, including
source keys, token text and scope metadata. The existing entry limits remain
(300 for fenced coloring, two for complete Source coloring); recent reads refresh
LRU order. One oversized current result is allowed and evicted when a different
result arrives. Lifecycle regression tests drive multi-megabyte source revisions
through the public facade, require old results to retire, and retain the current
result without reinitializing its engine.

The V37 archive at `ea790c7a` passed archive/asset/privacy checks, but was not run
because Guest Control failed after resume. Restarting the guest VBoxService
restored that channel without changing credentials, network or clipboard policy.
Native V38 at `d4150677` then completed with the same OS 10.0.26200, Code 1.140.0,
four CPUs, 6 GiB RAM and 1 GiB balloon as V36. Functional checks and the existing
500 ms severe-input gate passed. This is not the smooth-experience target:
comprehensive Live click samples still peaked at 321 ms, Source/Live input P95
at 221/352 ms, and first Live/Preview at 5.04/5.52 seconds. Preview thumb-drag
frame gaps reached 129 ms. These small native samples are not population P95.

The first V38 attempt exposed a test witness bug: concatenating DOM textContent
joined the code language label `js` and `console.log` into an unauthored word.
The corrected witness joins bounded visible text nodes with separators, excludes
controls/hidden text, and retains all timing, exact-source and native-input checks.
Both attempts and the driver hash are retained under the ignored V38 evidence
directory. The complete corrected acceptance is `native-final.json`.

A separate V38 CPU profile (instrumented, not an acceptance timing comparison)
found 60 ms in CodeMirror's syntax highlighter during a late Live click and
23 ms reading source lines for Git gutter markers. That diagnostic failed its
clicked-target witness when late image geometry changed; it supplies CPU evidence
only and does not replace the complete native acceptance. The highlighter's
range arguments do not avoid traversing preceding transparent balancing groups.
Budgeted Live and large Source now pass a pruned, temporary syntax tree to the
public Lezer highlighter. Absolute offsets, semantic ancestors, root properties,
mounted language parsers and overlay coordinates are preserved. The authoritative
parser tree is never modified. Only actual visible ranges get decorations; small
documents retain CodeMirror's stock extension. Differential checks cover 128
mixed-language ranges and distant rows in a 9,000-line code fence. The latter
requires at most 1,000 sibling advances rather than visiting all preceding code.
Git gutter rendering now resolves a source line only when a marker needs it.
Production caret regression with a ready baseline reads 109 rows across two
selections in a 24,001-line document, instead of enumerating every row per click.

Outer Markdown readiness is now an explicit per-tree certificate written by a
public parser wrapper before the mixed-language pass. It requires complete input
coverage, EOF and an unstopped outer pass. A same-length unknown tree, stopped
prefix or suspended embedded grammar cannot invent this proof. Live completeness
checks use that certificate while retaining their existing outside-edit and
same-structure comparisons. A document/grammar-owned preparation receipt is reset whenever
another outer pass starts, and only requests publication of the actual parser
tree; it never certifies a lagging tree.

Budgeted mixed parsing uses the documented ParseContext viewport and
skipUntilInView APIs to defer offscreen code/HTML before packed-node
materialization or inner-job allocation. The
original grammar, mounts and language data are retained, and normal documents
still parse every embedded language. During explicit whole-Markdown preparation,
an override preserves the real editing viewport because ensureSyntaxTree otherwise
temporarily expands it to EOF. Publication requests the editing viewport, so it
does not invalidate all the skipped ranges again. Preparation publishes once
after structure is complete, rather than causing Source observers to repaint on
every slice. Structural readers then reuse the certified tree without extending
all its embedded parsers. Switching to Live or refreshing layout no longer issues
another synchronous 500 ms whole-document parse after that work is ready.

The browser demand regression requires complete Markdown with intentionally
unparsed distant JavaScript before Live, the original syntax palette after
scrolling there and exact source across mode changes. Suspended-language and
partial-tree rejection cases are separate deterministic checks. Initial Live
profiling still shows substantial outer parsing and presentation work; these
changes do not establish the final first-viewport or native input targets.

The outer parser now has an editor-owned classic Worker. Text, changes,
selection, history and persistence remain in CodeMirror/DocumentSession. The
worker receives one initial snapshot, then composed ChangeSets; only one request
is in flight and intervening requests coalesce. It owns incremental Lezer
fragments and returns newly allocated Tree/TreeBuffer branches. Both endpoints
retain the current graph with reference counts, dropping retired branches when
exchanging roots. Node IDs are checked against the surface grammar before the
receiver accepts a complete-document certificate. No private CodeMirror state
effects or transported EditorState are involved.

The mixed pass remains in CodeMirror. An independent mapped fragment cache
preserves its inner-language reuse while the outer worker is pending; the
standard asynchronous placeholder would otherwise discard all those fragments.
Only committed View updates advance that cache. Wrapper order uses successive
public configure calls because an extension array composes wrappers outside-in.
Visible code/HTML retain the original parsers and language data, with complete
palette, coordinate and nested-path parity against 18 official-parser fixtures.
CodeMirror's Markdown support extensions still supply completion and folding.

Preparation waits for the worker without repeatedly starting placeholder parses
or chaining pending promises. Cancellation is checked every 16 ms. Source maps
its existing colors and code-row decorations until the next valid tree, rather
than flashing an uncolored document on each key. A CSP-constrained real-worker
editor regression covers input during the first request, Source/Live CJK input,
exact undo, distant code colors, disposal and failure without a blocking parse
fallback. Its 9,000-row code edit used 1,637 LR steps, below the 5,000-step reuse
guard. Forty graph revisions preserve exact authoritative syntax and retire old
nodes; 16,560 initial objects need at most 1,564 new objects per tested edit.

These worker checks establish ownership, correctness and foreground work bounds.
They do not replace native latency acceptance. A cold comprehensive browser
sample still spends about 0.65 seconds entering Live, with presentation and mixed
parsing remaining visible costs. Preview's first-response pipeline is separate
and still requires further measurement.

V39 (`68c2f8a7`, archive SHA-256
`fc32b88fa72e1d084ba67cedb89febafec6adbe0fb3b87ab28e4d5622b9a03d2`)
did not complete native acceptance: a late Live click failed its clicked-text
witness while layout changed, with a 538 ms long task. A separate diagnostic
captured Live input spending 1,825 ms inside a derived refresh, including repeated
global rich-block, math and HTML discovery; tag styling used another 198 ms.
Instrumented timings are diagnostic only. All 48 relevant mapped bundles were
verified against exact packaged code before attributing the CPU samples.

Derived refresh now waits for the current outer Markdown revision to be published,
using a producer readiness facet rather than teaching the scheduler about its
worker. A delayed real-worker response test holds publication beyond the old
refresh deadline, verifies exact paced keyboard input, then requires complete
presentation and single-group undo. Certified roots also retain an immutable
outer identity through mixed-language publication. Rich-block discovery, math,
literals and structural comparison reuse that identity; tab-size changes still
invalidate indentation-sensitive discovery. Tag styling uses the Live presentation
band and avoids duplicate work when its field is first installed. The scan-budget
test checks fewer than 200 requested rows in a 9,000-row document. These changes
still need a new complete native acceptance, including the previously failed
location and first Preview entry.

The same diagnostic found synchronous coordinate measurement in ordinary toolbar
hover. Outer source lines now supply their owning position through CodeMirror's
DOM mapping; nested editors and non-line surfaces retain coordinate lookup.
Hover checks require the original code toolbar ownership and zero geometry
lookups over plain/code source lines.

The publication gate's negative control fails when that gate is removed, while
the same delayed-response keyboard test passes with it enabled. Layout regression
also reproduced a fractional end-of-cell crop against unchanged V39 production
code. End-caret reveal now includes the textarea padding and a border pixel;
the original full table layout/row-shrink checks pass without relaxed tolerances.

V40 (`1e5d4a43`, archive SHA-256
`050265bca3392c44fb729defb054b8793c7ca40c73daec5ae802326b465d5f81`)
passed all sampled Source/Live click targets and exact typed/undo source checks.
It did not complete native acceptance: a save-flush timeout notification overlapped
Preview's return-to-top control, and its top-position check timed out. Live still had a 698 ms derived-refresh long
task. Rich Source clicks were 37–81 ms; valid Live clicks were 110–287 ms.
First Live took 5.93 s and first Preview 4.82 s (renderer response 3.86 s).
These are incomplete-run observations, not final P95 claims or a smoothness pass.

A separate guest Node 24.21.0 diagnostic used the exact packaged Preview worker:
module load 932 ms, cold open 3,690 ms, warm open 2,234 ms. Its CPU map was checked
against exact shipped code. Global footnote preprocessing and block/inline
preparation dominate, rather than visible chunk formatting or IPC alone.

Windowed Preview now separates global block/reference context from per-root inline
preparation using MarkdownIt's existing core rules. Headings and HTML-bearing
roots prepare early so global IDs and cross-root HTML containers retain their
semantics. Other roots run the original inline/postprocessing chain once when
requested. A token-to-root index avoids searching all preceding roots per request;
source attributes retain eager output order. Exports keep the eager path.
Endnote normalization/parsing is also deferred, conservatively keeping HTML-bearing
definitions in their original preparation order. Documents without footnote
markers bypass footnote preprocessing. Ordinary single-line table cells avoid a
redundant inline token walk.

The work-bound regression prepares zero of 2,000 offscreen prose roots, prepares
only requested roots once, and retains forward references. Exact eager/deferred
HTML parity covers 209 compatibility probes in both presets, out-of-order roots,
task state, heading stability, endnotes and the full comprehensive 1 MiB sample.
Host Node single-sample opens changed from 454/297 ms cold/warm to 365/245 ms
before the footnote-free fast path. These are directional probes only; native
Preview acceptance and the Live/save-flush stall remain open.

A separate V40 guest diagnostic captured Live save spending about 1.21 s in
CodeMirror language publication, including a 717 ms Live rebuild. Global block
discovery, math and footnotes dominate that rebuild. The save request arrived
while presentation was superseded; increasing the one-second flush timeout would
hide the foreground blockage rather than remove it.

The existing Markdown worker now also prepares cloneable global source facts.
It publishes syntax and footnotes first, then the richer table/math/Mermaid/HTML
index only for Live or explicit Live preparation. Source-only revisions avoid
that second stage. A read-only EditorState supplies existing algorithms with
text and tab size; it has no View, language field, DOM or history, and it never
crosses the wire. Context-only requests reuse the existing text and syntax with
an empty ChangeSet. The surface retains selection and HTML-editing filters.

Cache adoption happens before parser publication. Verified footnotes belong to
the exact Text, grammar and tab size, and survive embedded language publication.
Live preparation and derived refresh wait for the matching rich index. Large
undo/redo accepts text immediately and starts a new deferred generation instead
of synchronously rebuilding the new revision. Its boundary focus restoration
waits for presentation readiness; Source uses its native editor restoration.

The real CSP worker regression now covers a distant definition, inline/fenced
literal markers, a numbering-changing reference, syntax arriving before rich
context, native paced typing, exact undo, colors, disposal and failure. Across
entry/input/undo it observes zero foreground global footnote or rich-block scans
and one initial text snapshot. Small complex fixtures compare cloned worker
facts with fresh mixed-grammar parsing at tab sizes 2/4/8. Production three-mode
round trips, layout/row shrink, history interaction and save protocol checks pass.

Two broader checks remain open: the standalone no-worker Live history fixture
still rebuilds twice after cold preparation (also reproduced on unchanged HEAD),
and the IME fixture's nested closing-marker pointer boundary needs investigation
(the identical suffix mismatch also reproduces on unchanged HEAD).
The history test's injected completeness observer now checks certified outer
Markdown instead of an obsolete, unbound `syntaxTreeAvailable` reference; its
strict zero-rebuild assertion remains. Neither issue is counted as a pass.
Native latency acceptance for the new context pipeline is still required.
