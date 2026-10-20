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

V41 (`ac6307b0`, archive SHA-256
`9e969463670cbf3c2891a182dff2591a58f4990a42feeeada1454d996c6bf068`)
improves the traversed comprehensive sample: Source/Live typing P95 about
63/84 ms, Live save 474 ms, first Live/Preview 3.46/3.20 s. Live sampled clicks
range 96–247 ms. These input samples follow viewport traversal and are not cold
input guarantees. A separate no-traversal diagnostic still observed a 620 ms
Live input peak, and a repeat traversal missed one clicked-text witness.
Native acceptance remains incomplete.

The first full run and a separate diagnostic failed after a native Preview drag:
`Preview renderer queue is full`. A Preview-only run completed navigation/copy
correctly but had a 1.11 s first-drag frame gap. The viewport was submitting every
intermediate window while previous responses were pending. A deterministic slow
backend regression reproduced 29 overlapping block batches for 30 window changes.

Each reading viewport now owns one block batch in flight. Waiting consumers
recheck current visible/pinned demand after completion and discard obsolete
intermediate windows; requests remain bounded to 128 blocks. Navigation retains
its own cancellation check, and document rebinding retains the old flight until
it retires, without adopting its stale results. The same regression requires one
in-flight batch, at most three total batches and a mounted final reading window.
Complete Preview navigation, formatted copy, hidden surface, geometry, source
index and scrollbar boundary regressions pass. The host queue limit is unchanged.
New native validation is required before claiming this fixes the observed drag.

V42 (`7c204bc3`, archive SHA-256
`3f108d5e664e901250e3ab7edf5f50a1c245ba3bfe319d07a55031787b8e5a37`)
completed the full native functional run: actual clicked-text witnesses, exact
source/undo/save/mode round trips, four Preview drags and formatted whole-document
copy. No queue-full error recurred. Comprehensive drag frame gaps were
132/129/198/310 ms, with correct boundaries and visible content. Performance
remains a failure: a Live click reached 806 ms, typing P95 296 ms and frame gap
557 ms; first Live/Preview took 4.89/5.85 s. This run was broadly slower than V41,
so cross-run percentages would be misleading.

A separate exact-package V42 CPU diagnostic identified remaining foreground
global math scanning (175 ms), details extraction (122 ms), literal discovery
(78 ms) and code descriptors (62 ms). First Live also spends substantial time in
table width/layout and Mermaid. The 48 mapped webview bundles were checked byte
for byte against shipped code before attribution. Instrumented timings are not
acceptance measurements.

The rich worker context now includes full formula ranges, literal exclusions and
details source blocks. Receivers seed the existing bounded/weak caches before
refresh. Worker computations share one complete outer syntax snapshot, including
footnote-contained TeX fences. Details discovery ignores embedded language mounts;
literal `<details>` inside a Markdown code fence cannot become an editable fold.
Source does not initialize Live-only details records. A pending Live selection
keeps its mapped last-valid formula results until the corresponding context is
ready. Long-code descriptors use canonical outer identity across inner-language
publication and mode-only reconfiguration, preserving interaction reduction.

The actual-worker regression observes zero foreground global formula, literal,
details, footnote and rich-block discovery across preparation, input, caret,
reference changes and undo. Distant code coloring adds no descriptor scan. DTO
parity covers tab sizes 2/4/8, HTML editing, literal details and footnote-contained
math; settled undo also checks the visible footnote number. Formula fences/editing,
Live layout, long-code and production three-mode regressions pass. The broader
cursor-navigation test still reproduces a stale table-reveal/layout-compensation
oscillation identically on unchanged V42; it is recorded as an open check.

The Webview now loads Mermaid through its official module API and split diagram
loaders. A fence hint issues modulepreload for core resources without executing
the 5,575,485-byte classic bundle before the editor mounts. Pending loads belong
to an inert document marker, retaining the stateless resource-helper contract;
Live/Preview share one promise and runtime. Standalone/classic hosts and exported
documents retain their nonce/script API. Module failures keep Mermaid's existing
transient-error classification.

The real CSP regression prefetches 679,339 core bytes, verifies Source does not
initialize the runtime, compares nine module/classic graph geometries including
ELK and math, and exercises concurrent loading and failure recovery to a valid URL.
Classic lifecycle, shared-consumer retirement and HTML/PDF/Word light/dark layout
checks pass. A preliminary host browser comparison measured library load at
216 ms classic versus 46 ms split; that probe is directional, not native acceptance.
Mode-loading diagnostics now use the production module path, distinguish resource
prefetch from execution and hash nested runtime assets.

V43 (`4e805057`, archive SHA-256
`5c1de3dce4e59825455dcd10a311327f56f01f6429b7adb7e187ad5c995b1b57`)
completed native functional acceptance and the existing 500 ms severe-stall gate.
The same 1 MiB rich fixture has Source/Live typing P95 113/185 ms, with a 256 ms
Live input maximum and a 410 ms frame gap. Live clicked-text witnesses range
152–450 ms. Preview's four native thumb drags have frame gaps 104/99/120/128 ms,
correct boundaries and visible content. First Live/Preview remain 3.57/5.26 s;
cached Live/Source/Preview switches take 1.79/0.92/0.76 s. Whole formatted copy
takes 9.80 s. Ordinary Source/Live typing P95 is 164/114 ms. These measurements
follow viewport traversal; they do not establish cold-input or 100 ms P95 goals.
The production module is fetched for rich Live; the classic bundle is never
loaded. The final Preview boundary screenshot was visually checked. Full
smoothness acceptance remains open despite passing the old severe-stall gate.

The remaining full code-fence discovery now also runs in the Markdown worker's
primary stage, since both Source and Live need source bounds. A separate pure
source-index helper owns the weak Text/outer-tree/tab-size cache and cloneable
geometry; private long-code folding effects, UI records and thresholds stay in
their existing owner. The receiver adopts the index before syntax publication.
Mixed-language publications reuse canonical outer identity. Reconfiguration
still rebuilds presentation from cached facts so locale-sensitive widgets cannot
retain old labels. No folding UI internals cross the worker boundary.

The actual-worker work-budget regression first failed with seven foreground
code-fence discoveries. It now requires zero across entry, input, undo and mode
preparation. Transfer parity covers nested tasks, quotes, lists, footnotes, tab
sizes 2/4/8, empty/unclosed fences and Mermaid; Source/Live interaction checks and
production three-mode source/history preservation remain required. Native
acceptance for this additional index change has not yet run.

V44 (`35291a0d`, archive SHA-256
`4f37207db996278e533e4e0a53f8da5e052c5b7b114c646f5f253c2791285e5c`)
passed the ordinary native case and comprehensive Source editing. Its full run
stopped at a late Live clicked-text witness, despite a painted caret. The
original result and screenshot are retained; this is not a full functional pass.
A separate fresh-window diagnostic enters Live directly, without prior Source
editing or viewport traversal. Its click takes 195 ms, typing P95/maximum is
529/589 ms, Enter 235 ms and save 397 ms; exact source/undo and monotonic clock
checks hold. Warm traversal results clearly cannot substitute for this path.

An exact-bundle cold-input CPU diagnostic identifies table position projection
spending 135 ms in equivalent-data adoption, including 101 ms in per-cell DOM
coordinate assignments. The table already owns row/column identities and exposes
`tableCellSourceRangeForInput`, which resolves the committed row. Search/selection,
history focus and cell commits now use that same interface. Cell DOM no longer
duplicates absolute source bounds, and row-line attributes update only when the
source line changes. Folding, cell identity, pending native edits and relative
inline caret mappings retain their existing owners.

The embedded-editor regression first observed 300 cell-coordinate attribute
writes for edits before a six-cell table; it now requires zero while retaining
the same table/input nodes and committing to the exact current row. Production
cell editing, table history, detached-focus history shortcuts, transient save
(including IME/math/Mermaid), and rendered-block scroll/layout checks pass.
Native latency acceptance for the table coordinate change remains required.

V45 (`5822f06a`, archive SHA-256
`bf28d271cca69228b3b15599dc70fda6d82499b27fdd834f8be8e3cfb394350a`)
fresh-window, no-traversal diagnostics retain exact source, undo and clock checks.
Source typing P95/maximum is 73/89 ms; Live is 450/520 ms with a 456 ms frame gap.
Cold sampled clicks are Source 178 ms and Live 157 ms. First Live takes 1.32 s,
and Live save 209 ms. These are narrow diagnostic samples, not full acceptance;
cross-run percentages would confound code and runtime variation.

The strict full V45 run again stops at a Live clicked-text witness. Additional
capture proves a real pre-click target change: the expected portrait-caption
line has moved, while pointerdown and source selection both reach an empty
line. The original result and screenshot are retained. The V44 diagnostic
repeat did not reproduce the mismatch, and was explicitly marked diagnostic-only.

A deterministic delayed-image test exposes a second geometry change even after
the resource has loaded: `cloneNode` retains its URL but not its decoded intrinsic
box. The display clone can briefly collapse, then grow after insertion outside
the image presentation's controlled mutation. Resource projection now carries
decoded dimensions, and ImageWidget reserves the same constrained aspect ratio
before decode. Authored Wiki dimensions still take precedence. The held-clone
test requires an undecoded image, unchanged image bounds and an unmoved following
editable line across decode. Existing image/Wiki/resource lifecycle checks pass.
Unknown-size first arrival can still legitimately change geometry; the new test
does not establish that every native target-instability case is fixed.

An exact V44 Preview-worker diagnostic measures module initialization at 550 ms,
first preparation 1.71 s, warm preparation 1.22 s, and complete formatted copy
6.48 s (4,938,176 HTML code units). It runs the packaged worker in guest Node
24.21 with a diagnostic parent port; it is not a native viewport measurement.
Safe HTML filtering remains enabled. Those preparation costs and Live's cold
input tail remain open optimization targets.

The Markdown worker now retains the last completed source context. Previously,
even an ordinary word edit discovered global footnotes, code fences and rich
block facts again. It now projects their coordinates when all changes remain in
one bounded paragraph and the completed outer trees prove unchanged structure
outside that paragraph. Local literal discovery must also match. Newlines,
syntax characters, definitions, math, HTML-sensitive paragraphs and inconclusive
proofs retain full discovery. Source-only work does not eagerly discover rich
presentation; a later Live request can reuse its primary facts.

The actual CSP worker regression first observed two global preparations for
initial entry plus ordinary input. It now requires one, including formatted
prose and undo, while retaining the existing one-flight/revision contract and
zero foreground global scans. Pure projection tests compare every accepted
result with independent complete discovery, across nested lists/quotes,
definitions, literals, tabs 2/4/8, coalesced changes, inverse undo and physical
CRLF offsets. Paragraph-edge footnote container coordinates are explicitly
preserved when the surface certifies an enclosing list/quote after insertion.

Type checks, architecture checks, actual-worker/CSP lifecycle, Live scan budgets,
input scheduling, production inline input, layout stability and production
three-mode text/history/reading-position checks pass. The separate no-Worker
cold-history test still reports its previously reproduced two presentation
rebuilds instead of zero; this remains an open baseline failure. Worker facts
are still sent in full, so this change does not establish reduced wire size or
native cold-input latency; those require separate measurements.

V46 (`90374149`, archive SHA-256
`72e2607e6a43f7db79d4cc123c969bbaff82353f931788c9a58c4e5520c90cba`)
fresh-window Live diagnostic has input median/P95/maximum 78/186/262 ms across
23 characters, a 392 ms frame gap through asynchronous diff publication, and
exact source/undo/save results. This is a narrow sample. A separate Source cold
sample has a 41 ms median but 289/376 ms P95/maximum, concentrated in initial
keys; neither the warmed numbers nor Live's improvement establish smoothness.
The strict full run still stops at a Live clicked-text mismatch. In a diagnostic
repeat that continues mismatches, four native Preview drags finish and the old
severe-stall gate passes, but first Preview takes 5.85 s (render response 4.39 s).
That repeat is explicitly not a complete functional pass.

A separate deterministic image-click reproduction finds a real interaction
ordering bug in both ordinary and large documents. Live's `pointerdown` hides
the previously active source before CodeMirror's subsequent `mousedown` hit
test; the intended glyph moves 18 px and the caret reaches a blank line. The
pointer state now retains the existing active-line/range presentation until the
initial selection transaction resolves the hit, then enters the existing drag
phase. Release/cancellation still retire that state through the existing owner.
The regression checks glyph geometry at `mousedown`, real browser click/input,
and exact undo for ordinary and budgeted documents. Image layout/clone decode,
toolbar activation/focus, Live scan budgets and production three-mode checks
pass. The previously reproduced nested-marker IME caret and overlapping table
reveal failures remain open; this change does not claim to repair them.

Native V46 diagnostics also show image growth can move a target before the OS
pointer event arrives. The click-order repair addresses the reproducible
in-handler movement, not this separate first-arrival case. Unknown intrinsic
image geometry and final native interaction acceptance remain open.

The V46 cold Live CPU diagnostic attributes 146 ms aggregate to Markdown worker
message delivery, including 112 ms self time, over a 7.78 s instrumented input
interval. Those are aggregate samples, not one-key latency. Its source maps are
checked against the exact archive's executable text, normalizing only fixed-width
Bun chunk-digest metadata so generated line/column positions remain identical.
The remaining full context replies are now replaced by a base-revision receipt
when the worker certifies an unchanged context. The receiver owns one previous
context and maps it through the exact composed ChangeSet it sent. Initial or
structurally changed contexts still transfer complete facts. Syntax and rich
receipts preserve the existing separate readiness stages, including Source-only
revisions followed by a later Live request.

The actual-worker test requires no full fact arrays/formula strings on ordinary
prose and formatted-word replies, including undo and coalesced input. Both syntax
and rich receipt bases are checked; deliberately mismatched bases reject the
operation while retaining exact Source text and never start a foreground full
parse. Disposal clears the retained context. Independent full-discovery parity
continues to validate the shared coordinate mapper. Native acceptance of receipt
delivery and the pointer-order repair remains required.

An independent V46 Preview-only native run passes source preservation, visible
boundary witnesses and four real scrollbar drags. First Preview takes 4.18 s
(render response 3.56 s); maximum frame gaps are 285/434/174/254 ms. Passing the
old 500 ms severe-stall gate still does not establish 16–33 ms scrolling or a
one-second first viewport. These cold Preview observations supersede any claim
that warmed 100 ms-range drag samples describe the entire experience.
