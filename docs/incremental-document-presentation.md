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

V48 (`cef7dd37`, archive SHA-256
`ea6e6279b11dbd6fe83570acb07cb4ae04c898e374795276e536a2524c3ec297`)
completes strict native functional acceptance on ordinary and 1 MiB rich files,
including source-exact typing, undo/save, multiple clicked-text witnesses, mode
round trips, four scrollbar drags, visible boundaries and whole formatted copy.
The Preview screenshot is visually checked. Warm Source/Live input P95 is
70/139 ms on the rich case; sampled Live clicks are 85–247 ms. First Live/Preview
take 2.66/3.14 s; drag frame gaps are 78/91/175/101 ms, and complete formatted
copy takes 6.31 s. Ordinary Source/Live typing P95 is 78/81 ms.

A separate no-traversal V48 diagnostic still has Live typing P95/maximum
562/574 ms and a 538 ms frame gap. Source cold P95/maximum is 74/111 ms. Both
retain exact source and undo. The full run passing the old 500 ms gate therefore
does not close cold Live acceptance. Image first-arrival instability also cannot
be ruled out by one successful full run.

The exact V46 cold Preview CPU/trace diagnostic identifies a 717 ms main-thread
ELK timer task. Mermaid 12.0.0 now uses ELK by default for several diagram types,
and its `new ELK()` uses an in-thread simulated worker. ELK's documented browser
worker support supplies a stronger execution boundary
([ELK worker API](https://github.com/kieler/elkjs#usage),
[Mermaid layout defaults](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/config/layouts.md)).
The reading module build now replaces that ELK constructor with a shared client
of the official, packaged `elk-worker.min.js`, loaded under the existing blob
worker CSP. Labels and SVG painting still use Mermaid's original renderer.
Standalone HTML/PDF/Word continue to use the unchanged classic distribution.

The worker receives plain layout data rather than renderer functions or DOM
handles. Returned coordinates merge into the original graph/arrays so Mermaid's
nodeDb aliases, labels and renderer-only sidecars remain valid. One worker serves
Live and Preview, with one layout in flight, bounded queued work, a 15 s deadline,
and 30 s idle retirement. Worker failure/timeout rejects work and allows a later
fresh worker; there is no synchronous layout fallback. The direct elkjs dependency
pins the same 0.9.3 version already used by Mermaid.

Actual CSP checks require one real shared worker and compare twelve graph
geometries/node structures with the stock classic runtime, including nested
groups, cycles, states and math labels. Queue/clone/alias, failure/retry, stale
reply, timeout and disposal checks pass. Native input/scroll acceptance of this
ELK boundary remains required. The trace also contains other layout costs; this
change is not a claim that all rendering is off the main thread.

V49 (`5f4ec037`, archive SHA-256
`9c99be46dafead897d4b1ed014ce44075ddb555580fa064f94585052f5b500bc`)
has a fresh-window Live input median/P95/maximum of 44/147/210 ms, a 185 ms
frame gap and a 152 ms cold click. Exact source, undo/save and clock checks pass.
The independent Source cold sample is 37/288/364 ms; cross-run variation remains
substantial, so these samples do not establish P95 acceptance. A strict full run
stops at a rich Live clicked-text mismatch near image captions. A separate
instrumented repeat has no mismatches, but is diagnostic-only by design; the
strict failure remains open.

The independent Preview-only V49 run passes native boundary, source, clock and
whole formatted-copy checks. First Preview takes 3.78 s (response 3.28 s), with
four drag frame gaps of 166/224/140/183 ms. Complete formatted copy takes 7.71 s
and preserves 5,538,400 HTML units, 567,075 text units and the complete end marker.
Passing the historical 500 ms gate still does not mean fluid scrolling.

V49's cold Source CPU diagnostic attributes 117 ms aggregate to mixed-language
advancement and 135 ms to worker-message delivery over 4.90 s. The maps are
checked against the packaged executable using the same fixed-width digest-only
normalization as V46. These totals are not one-event latency. Lezer's mixed
parser was still visiting distant Markdown nodes merely to reject their code
languages. Budgeted parsing now uses public TreeFragment reuse to skip outer
subtrees outside the viewport. A weak index reads packed immutable branches
once, reusing unchanged branches, and registers only actual code/HTML hosts for
later grammar demand. Ordinary Markdown must not be marked skipped.

Reuse boundaries include each intersecting code/HTML host in full, preserving
inner LR fragments for giant blocks. Published outer completeness and nested
language completeness remain separate proofs. A precompleted 2,000-block fixture
previously needed 39,154 cursor visits; the scoped test requires fewer than 2,000,
including distant/return demand. Real-worker checks preserve remote code colors,
18 revision jobs with one snapshot, exact CJK/undo, and 1,637 LR steps for a
9,000-line code edit. Live work budgets and production three-mode content,
history, parse reuse and reading positions pass. Native latency still needs
remeasurement after this change.

The standalone Source-force fixture also fails on unchanged V49 at its historical
requirement for exactly one synchronous force call (zero observed). The baseline
is reproduced by substituting unchanged committed sources; it is not counted
as passing. Existing IME, table-reveal and no-worker history failures remain open.

V50 (`4047e33c`, archive SHA-256
`c0799b190f6c4e7568610af8e095cc07b4f8f418b514d3167e4933ddab660e2b`)
cold Source input has median/P95/maximum 36/257/380 ms, with a 32 ms click;
cold Live has 73/313/417 ms, with a 117 ms click. Source and Live frame gaps are
376/355 ms; exact source, undo/save and clocks pass. Cursor traversal reduction
therefore does not by itself establish low end-to-end input latency. No full
functional acceptance is claimed for V50.

The same fixture's initial outer-tree message has 33,633 records, 2,815,360 JSON
metadata units and 3,934 transferable handles. An isolated host reproduction
measures 50.4 ms structured cloning plus 21.3 ms reception. The tree protocol now
packs new graph metadata into one Float64Array and packed nodes into one
Uint16Array. Only two buffers cross threads, while immutable branch IDs and
reference retirement retain their existing meaning. Doubles preserve safe IDs
beyond 32 bits and signed context hashes. The receiver validates packet lengths,
types, child positions and properties; malformed packets retire partial graphs.

Received packed branches copy their own small byte slices, so a surviving branch
cannot retain an obsolete document's whole transfer allocation. The initial
packed message is 2,587,712 bytes. In the same isolated reproduction, cloning is
0.24 ms and reception 26.3 ms; these are host component samples, not native input
measurements. Forty incremental edits, exact tree structure/positions, graph
identity and retirement, independent byte ownership, sparse IDs, signed hashes,
truncated/corrupt packets and real CSP-worker revision/undo checks pass. Native
remeasurement remains required.

V51 (`af022e1f`, archive SHA-256
`42d7572b934197b0b45742bb408b7c5e4844a3ea6cb6f75b9456b41c2fd4c97d`)
has cold Source input median/P95/maximum 40/108/170 ms, a 128 ms frame gap and
33 ms click. Cold Live remains 70/278/465 ms, with a 379 ms frame gap and 137 ms
click. Both retain exact source, undo/save and clock checks. The full run stops
at a Source caret-witness timeout; a strict rich-document repeat passes Source
click/input but stops at image-caption movement in Live. Neither is a full pass.

The native typing target is inside a nested footnote definition. Its ordinary
body text was explicitly excluded from context projection, rediscovering all
source facts after each edit. Definition facts contain source coordinates rather
than copied body text. The projection proof now admits one unchanged paragraph
inside a definition while protecting definition markers/labels and retaining
the same outside-tree, literal, formula, summary and line-structure guards.
Line/continuation coordinates and definition/reference aliases use the existing
shared mapper. Structural or uncertain edits still rediscover authoritative facts.

Fresh complete-discovery parity now covers definition heads and continuation
paragraphs, nested lists/quotes, tabs 2/4/8, CJK edits, undo and grammar boundaries.
The real-worker test covers both Source and Live, requires receipt-only body
edits/undo with unchanged global preparation count, and verifies numbering and
zero foreground global discovery across 31 jobs. The mode test follows the
product's explicit Live-preparation seam before activating that surface. Native
latency after the expanded footnote proof remains to be measured.

Preview's existing gesture gate covers newly scheduled enrichment, but a batch
already queued or awaiting a diagram can pass it. Large Preview Mermaid work now
rechecks that same activity owner before acquiring its exclusive lease, between
diagrams, after runtime loading and before projecting the final SVG batch. A
retired frame/mode cancels the wait through the existing generation predicate;
ordinary documents retain immediate enrichment. The reading window still
mounts text/HTML during native dragging. No new user setting is introduced.

The resource test verifies no lease is acquired while a large-document gesture
is active, resume after it ends, and cancellation before acquisition. A browser
test pauses the first in-flight diagram, starts a gesture and releases it: the
second diagram stays deferred. It repeats the gesture before the second result,
requiring zero SVG projections/notifications until release, then two diagrams
and one notification. Existing appearance switches, shared Live/Preview runtime,
late hidden-frame results and disposal checks pass. Native scroll remeasurement
is still required.

Final production Preview window/boundary, resource-budget and cross-mode
Mermaid/formula update/copy checks pass. One three-mode run during concurrent
verification duplicates a committed CJK composition at the Live tail; an isolated
repeat passes the exact-source assertion. The failure is retained and is not
explained away as a timing artifact. IME/mode-transition stability still needs
further diagnosis alongside native acceptance.

### Editor core and competing viewport owners (2026-10-20)

The pinned CodeMirror view/state pair is updated from 6.36.4/6.5.2 to
6.43.15/6.7.6. The upstream view changelog includes native caret coordinates,
widget hit testing, scroll clipping/scaling and composition corrections. The
project keeps its Markdown grammar and existing document/worker protocol.
The sticky-header widget follows the new previous-widget updateDOM argument;
the centralized synchronous measurement adapter retains its verified signature.
Production test drivers follow this pinned version's content tile reference.

Two local regressions need product fixes independent of that upgrade. A native
mouse hit just after hidden inline closing markers can be mapped before those
markers by CodeMirror; at an italic overhang even Chromium's first text endpoint
can be ambiguous. Live now keeps the bounded DOM text hit for an unmodified,
stationary mouse click and reconciles it after CodeMirror's document mouseup.
The alternative hit requires collapsed intervening markers and the following
text's leading caret within one CSS pixel. Selection drags, modifiers, document
changes, nested editors and widget-owned clicks do not adopt this correction.
The existing full IME regression now passes without weakening its assertions.

The production table/navigation regression also reproduced on the old core.
Scroll setter call stacks identify a still-active column-width element-retention
callback alternating with a newer document-anchor stabilizer: one restores the
old textarea screen Y, the other restores the requested document position.
Element retention now captures viewport ownership as well as its own lifetime;
a newer owner retires the old correction. Font-line/table observers use the same
ownership check as the existing visual-block observer. The unchanged regression
passes its synchronous-write trace and twelve passive frames, including its
negative cleanup control, focused textarea and exact selection checks.

The new core's default five-pixel cursor scroll margin also introduced an extra
Source scroll in the visible replacement case. Source uses the public cursor
margin facet with a one-pixel vertical margin so its existing viewport owner
remains authoritative. This is verified by the original navigation assertions.
These functional fixes do not by themselves establish native latency targets.

Type checks and the production build pass. Fourteen targeted regressions pass,
including viewport ownership, IME, image geometry, Mermaid block modes,
three-mode unsaved-source work budgets, parser reuse and window-focus return.
Font changes cover 70 steps with zero observed anomalies; line-number projection
covers 242 passive frames. Formula gutter checks cover nine typing scenarios,
1,186 passive input frames and 162 actual screencast pixel checks. The mode
preparation test now waits for the initial toolbar/editor preload shells to
release before testing cancellation; previously it clicked an aria-hidden shell.
Its real trusted-click and exact-source assertions remain intact. A separate
four-times-CPU-throttled diagnostic passes sixteen CDP compositions over eight
Source/Live cycles. This does not explain every earlier transient composition
failure and is not a Windows candidate-window measurement.

### Native V52 follow-up and structural reads (2026-10-20)

V52 (`63023c66`, archive SHA-256
`8019ac841c450e9da3e9715eb5f6655476bb95f5afd994f9ab91229164228f70`)
passes all sixteen distributed Source/Live clicks in its full rich-document run.
Warm Source input median/P95/maximum is 40/66/86 ms and Live is 62/207/265 ms.
The run stops after Preview has rendered, while waiting for Back to top to stay
at the document boundary. Preview entry is 4.41 s, including a 3.10 s render
response. No full acceptance is claimed. An independent instrumented Preview-only
run passes its four drags, which does not explain the preceding mode/edit sequence.

Independent cold input remains slow: Source median/P95/maximum is 34/234/330 ms,
with a 344 ms frame gap and 46 ms click; Live is 73/425/543 ms, with a 440 ms gap
and 153 ms click. Both retain exact source, undo/save and clock checks. CPU
profiling is a separate diagnostic, not another latency acceptance sample.
The matching source maps require executable byte/column equivalence against
the extracted V52 package, normalizing only fixed-width Bun chunk references.

A deterministic Preview round trip reproduces leading whitespace loss: at
scrollTop 0 or 8, a passive layout preservation moves to 48. Source mapping now
retains the leading reading margin just as it retains whitespace between mapped
blocks. The unchanged window/search/navigation suite passes the new assertion.
This is a confirmed boundary error; the entire native Back to top timeout still
requires a full-sequence recheck.

The cold Live profile also identifies repeated synchronous syntax advancement in
the HTML input guard. Markdown structure can already be complete while embedded
grammars remain pending; a new worker revision cannot arrive during a synchronous
parse call. Structural consumers now read the exact completed worker tree before
requesting foreground parser work, and retain the published projection while the
worker is pending. The HTML guard uses this shared seam with its original caret
endpoint on ordinary synchronous documents. It does not widen normal-document
input parsing to the document end.

The real CSP-worker regression now instruments synchronous parser requests while
holding replies during ten paced native characters. Before the fix it observes
multiple 50 ms requests; after the fix it requires none above the existing 8 ms
slice while preserving immediate text, queued presentation, exact grouped undo,
global facts and disposal/error handling. All 31 existing worker jobs pass.

Type checks, production build and eleven targeted suites pass, covering shared
structure, input scheduling/budgets, HTML, IME, cursor navigation, parser reuse,
three-mode unsaved source, reading-position persistence and Preview preset
position. The separate Preview viewport suite also passes its new leading-margin
assertions and existing scrolling/search/resource checks. Source-side Preview's
complex table transition still fails its absolute anchor assertion, at about
-91 px. An otherwise unchanged `63023c66` build reproduces that same assertion
with these structural-read and leading-margin changes removed. The regression
is retained as an open mode-coordination issue; no test assertion is relaxed.

That complex-transition failure is subsequently isolated to its setup. The
scenario gives Preview scroll ownership after aligning Source, but assumes the
same row/range must already be centered in the differently sized Preview table.
The captured pre-transition Preview offset is already about -90 px; the mode
switch preserves it within a pixel. The fixture now uses its real Preview wheel
gesture to align the measured rendered range and requires a <=2 px precondition
before switching. All original <=20 px absolute, semantic-range and <=1 px
paint-stability assertions remain. The full Source-side Preview suite then
passes, including repeated round trips, independent scrolling and LF/CRLF reload.
No product mode-switch change is needed for this failure.

V53 (`6fa4c775`, archive SHA-256
`9da6a0ec9a34df3db2a225a86b4d20514c41dd6deb1361cd0f2f99aaa90ef7d2`)
passes the full ordinary/rich native flow: sixteen distributed rich-document
clicks, typing, exact undo/save, composition, four Preview drags, whole formatted
copy and mode round trips. Rich warm Source input median/P95/maximum is
39/112/161 ms and Live is 84/197/260 ms. Preview entry is 5.18 s (3.76 s response),
cached Preview 717 ms; drag frame gaps are 80/204/96/98 ms. Full formatted copy
is 8.26 s, with 5,538,400 HTML and 567,075 text units, bold and the end marker.
The final Preview screenshot is visually checked at the frontmatter boundary.
This passes the historical 500 ms gate, not the tighter responsiveness goals.

Cold Source still records a 535 ms maximum and 561 ms frame gap, and cold Live
a 371 ms maximum and 333 ms gap; these retained failures take precedence over
the warmer full run. A separate Source profile has a faster input sample, so it
cannot explain away the cold tail. It does identify roughly 99 ms main-thread
mixed-language preparation, including a global host index, plus an unparented
173 ms browser layout. The latter is not attributed to a product function without
evidence. Moving global host discovery into the existing worker is the next
bounded architectural change; native remeasurement remains necessary.

### Worker-owned embedded-language host index

The incremental parser worker now sends a packed index of code, HTML and comment
host ranges with each completed outer tree. The same immutable-branch cache is
retained for incremental edits, but global discovery runs in the worker. The
two existing tree buffers retain their format; one additional small Float64
buffer carries host pairs. The receiver validates type, pair count, safe source
coordinates, bounds and ordering before accepting it. Main-thread mixed parsing
uses this index only for the matching outer-tree identity and revision. Ordinary
synchronous documents retain their original local index path.

Fresh syntax-iteration parity covers fenced/indented code, inline HTML, blocks,
comments and nested containers. The real CSP-worker suite requires zero global
host-index scans on the foreground thread, retains distant/return language demand
and 1,637-step incremental code reuse, and rejects a corrupted index while Source
remains editable with exact text. A deliberate fallback control records 33 global
main-thread scans and fails that same assertion. No native latency improvement
is claimed before the new installation package is measured.

V54 (`5707bd62`, archive SHA-256
`a98374bbd2a4eabb8ccb6afe070150c98e03df0cbda2066b3d3ac0ae140ebb1a`)
records cold Source input median/P95/maximum 38/96/125 ms, click 34 ms and
270 ms maximum frame gap. Cold Live is 70/213/252 ms, click 136 ms and 222 ms
maximum gap. These samples still miss the tighter Live and scrolling goals.
The full native flow fails a strict image-caption click: the selected portrait
caption is followed by a caret in the AVIF caption. Its sixteen-click diagnostic
repeat passes, so that repeat is not functional or latency acceptance. Passive
frames retain approximately 20 px text fallbacks while their real images need
larger boxes. This establishes an avoidable layout risk, not proof that every
intermittent caption mismatch has the same cause.

### Reserve known image geometry before first decoding

The extension reuses its initial local-image resource traversal to start a
bounded header catalog while webview assets load. At most 512 source aliases,
four concurrent local reads and 64 KiB per header are admitted. No pixels or
remote resources are decoded in the host, and Init does not wait for the catalog.
Available dimensions travel with Init; one document-correlated completion batch
can seed later hints. Disposal retires queued work and late publications.
Unsupported, missing, oversized and incomplete headers keep ordinary loading.
This initial catalog covers direct local Markdown image destinations; remote,
Wiki-only, HTML-only and later-inserted resources still use the existing loading
path unless their dimensions are already known from decoding.

The editor pool retains bounded raw-source hints across mode round trips, with
decoded browser dimensions taking priority and explicit resource invalidation
retiring hints. Late metadata reprojects loading placeholders without restarting
resolution or decoding. Live placeholders and real image clones share one sizing
function, including Wiki authored width/height and the existing 240 px constraint.
Preview reserves the known natural ratio while its transparent 1px source is
visible, preserves authored attributes/styles, and hands sizing back to decoded
natural dimensions when ready.

The first-arrival regression is red before this change (16 px placeholder versus
240 px required height), then verifies <=1 px image/following-text movement across
decoding. Additional cases cover late metadata, one shared in-flight resolution,
Wiki width and width/height, and actual Preview iframe decoding with authored
HTML dimensions. Header bounds/disposal, protocol validation, pool invalidation,
presentation correlation, Source image lifecycle and Source-side Preview round
trips pass. The broader image-presentation production suite still fails its
pending-table-image setup on both the modified build and otherwise unchanged
`5707bd62` control; its assertion is retained, with no legacy-baseline exception.
Native remeasurement remains required before declaring the caption issue fixed.

V55 (`5e525915`, archive SHA-256
`5f8f63ceffbf8aa52315d44ff1547f42df833f8344839bf40f9e6f60990afbf2`)
passes the complete ordinary/rich native flow, including all sixteen distributed
rich-document clicks and the previously failing image region. This is one full
pass, not proof that the intermittent symptom can never recur. Rich warm Source
input median/P95/maximum is 45/71/177 ms; Live is 67/231/311 ms. Seven generic Live
caret paint witnesses are 154–199 ms; the additional footnote witness keeps its
separate strict target check. First Preview is 3.87 s (3.09 s response), cached
Preview 648 ms, drag frame gaps 71/128/155/89 ms and whole formatted copy 6.28 s.
Exact source, undo/save, protocol composition and timing clocks pass; the final
Preview screenshot is visually checked. Cold Source is 34/81/245 ms with 360 ms
gap and 30 ms click. Cold Live is 69/178/285 ms with 243 ms gap and 107 ms click.
The cold runs are deliberately partial diagnostics, not full-flow acceptance.
These results still miss the tighter Live/scrolling/first-Preview targets.

### Reuse proven code scopes across footnote rewriting

Preview preprocessing previously performed three whole-document structural
scans: extraction, reference rewriting and later table/list normalization. The
rewriting pass now retains its code-line index only when each actual generated
reference is proven to stay in inline paragraph/heading content or a parsed
table row. Container prefixes and link definitions are not treated as inline
content. Table cell tokens have no source map, so their enclosing parsed row
supplies the range. A pipe in a replaced label or generated tag, a line boundary,
or an unproven position retains fresh parsing. This also protects a malformed
table header that could become a table after a label's pipe disappears.
Lines without a footnote opener bypass the per-character reference scanner.

The real preparation work-count regression is red at three global scans and
green at two, including table references. Fresh code-mask parity covers 504
container/HTML/code combinations plus table/escaped-pipe cases. An independent
unchanged-HEAD control compares 517 inputs under both default/GitHub presets and
both eager/windowed rendering: all 2,068 HTML, heading and block-manifest
comparisons match, including the complete 1 MiB fixture. Type checking and HTML
export contracts pass. Alternating warm Node v24.15.0 measurements of preparation
plus the first twelve blocks have median 290 ms before versus 255 ms after
(six measured runs per version, about 12% less). This is a host diagnostic with
explicit GC between runs, not a native first-Preview latency claim.

### Share the initial persistent document across session and editor

The Source profile's first-input task also contains about 28 ms comparing
independently built, equal initial text trees. The Document Session now exposes
its immutable current text through its existing ordered adapter. Initial Editor
mount waits for queued session inputs, then consumes that native persistent Text
directly. Identical current/saved Init text is constructed once. String-based
Editor callers remain supported by the same single text input; no global text
interning cache is introduced. The producer seeds the existing 8 MiB projection
cache with its already-known normalized string, avoiding another flattening.

An actual Bootstrap regression observes the real snapshot producer: before the
change the session and Editor own different initial Text objects, afterwards
they share one tree, including equal saved text. A first edit still emits exactly
one inserted character, undo restores the complete large source, and Source
startup issues no hidden Preview request. Domain/application/protocol, ordered
adapter, bounded replacement (LF/CRLF/Unicode/stale revisions), actions and
Source-side Preview round trips pass. The broader candidate cutover browser test
still reports line 51 versus 54 after its equal-text Mermaid replacement on both
the modified build and an otherwise unchanged `1b5f5c21` control. That retained
viewport assertion needs separate diagnosis; no assertion or legacy baseline is
weakened. No new native latency number is attributed to snapshot sharing yet.

### Retained table ownership and consecutive presentation anchors

The unchanged V56 control reproduces the image-production failure: after
multiple same-shaped table replacements, CodeMirror retains the DOM but the
new widget values no longer own it. Equality comparison therefore cannot
reconcile the mounted table. The widget now uses `updateDOM` and the existing
DOM-owner registry to publish source bounds, contents and image lifetimes.
Equality no longer changes the mounted table. Its current-position lookup also
resolves to the right of the opening DOM boundary, so row diff facts refresh
instead of resolving the preceding syntax node. Image production, table cell
editing, table commands and the complete table stability suite pass, including
retained DOM/source-bound assertions. A separate column-resize visual test
still reports a 44.78 px active-cell movement on both this build and unchanged
V56; its original assertion remains intact.

The equal-text Mermaid cutover failure is a second independent ownership issue:
two ordered updates could capture the viewport between layout and its scheduled
correction. The next update now inherits the current desired document anchor
only for the same persistent document and current stabilization generation.
The record is bounded, uses a weak document reference and cannot override a
new user interaction. No additional synchronous layout flush is added. The
complete cutover test passes its retained line/offset/focus/selection checks
plus a new sub-pixel visible-reading-line assertion. Viewport-controller,
Source-side Preview, isolated viewport-anchor production and type checks pass.

V56 (`e4da2086`, archive SHA-256
`b568b1c2f5a7b8ade5d75f2ebd227a3fab155e9327ddb571897373471c0bfb4c`)
passes the complete native ordinary/rich flow, sixteen distributed clicks,
exact source/undo/save and protocol composition. Warm rich Source input
median/P95/maximum is 41/59/168 ms; Live is 85/214/292 ms. First Preview is
4.09 s (3.29 s response). Cold Source is 41/135/141 ms with a 509 ms frame gap;
cold Live is 99/206/332 ms with a 344 ms gap. Cold runs remain partial
diagnostics, and the old 500 ms input gate is not the smoothness target.

A separate V56 Source profile is mapped against a frozen `e4da2086` source
build whose normalized executable bytes match the archive. It identifies a
224 ms worker-response task, including about 120 ms receiving the syntax tree,
and a different 442 ms task containing a 299 ms browser layout (252 ms thread
CPU, 796 dirty layout objects). Merge-conflict rescanning also consumes about
30 ms of a state update. These are remaining costs, not evidence that snapshot
sharing caused a latency improvement. The retained-DOM/anchor fixes above are
not included in the frozen V56 native package.

### Reuse conflict-free analysis across ordinary edits

Conflict analysis now carries an empty-result proof across an edit only when
every complete affected old and new line lacks all four conflict marker kinds.
This catches marker deletion and joins/splits that could complete an older
unfinished conflict; editing any candidate marker retains the full parser.
Disjoint changes inspect their own line intervals. Live registers this field
before presentation consumers, including deferred input, so readers share the
same immutable revision proof instead of racing to perform a global scan.

The real Source state-update regression fails before the change and passes
afterwards: 24 edits at opposite ends of 30,001 lines request 96 lines total.
Live input also retains the exact shared empty result. Another 2,646 fresh-scan
comparisons cover incomplete/nested conflicts, every marker kind, removals,
line joins and inserted newlines. Existing Live scan-budget and deferred-input
tests and type checking pass. Actual conflict documents retain conservative
whole-document parsing; this is not a claim that their updates are incremental.

### Cooperative syntax reception and retirement

The binary syntax protocol still reconstructs thousands of property-bearing
Lezer trees. Packing these nodes into TreeBuffers would discard their per-node
context hashes, so this change preserves the representation and parser reuse.
Reception now yields browser tasks at an 8 ms time check or 2,048-record work
cap, with checkpoints every 128 records. Old-graph retirement is iterative and
uses the same checkpoints. An individual record or garbage collection may
exceed that soft budget; this is not a hard frame-time guarantee. Small patches
do not wait for a task. Ordinary synchronous parser behavior is unchanged.

Worker syntax and rich-context replies enter one ordered promise chain. Only a
complete validated tree becomes ready; later block replies cannot overtake a
yielded syntax receipt. Clearing/disposal invalidates the current generation
before resumption. Syntax preparation and reception share a browser-task yield
helper, using user-visible scheduler tasks with a timer fallback.

The transfer regression is red without cooperative reception, then green with
multiple task opportunities for both the initial 16,560-object tree and its
retirement. Exact structure/positions, incremental patches, independent byte
ownership, malformed packets, cancellation and a fresh post-cancellation
revision pass. The actual CSP worker browser test also observes multiple
reception yields, injects exact input while a half-received tree is held, and
closes another editor mid-receipt. No partial syntax is published and the latest
input remains exact. Existing ordered projection, undo, modes and failure checks
pass; the inner-language incremental case remains 1,637 LR steps.

V57 (`9fd0465b`, archive SHA-256
`ea309e2be5938ddebf7774548d2d87b6e2fe81cda676f0e676c5ce2a308c2593`)
passes the complete native ordinary/rich flow and sixteen distributed rich
clicks. Warm rich Source input median/P95/maximum is 44/70/84 ms; Live is
70/99/155 ms. The seven generic Live clicks still range from 138 to 243 ms.
First Preview is 4.77 s (3.50 s response), drag frame gaps 91/91/136/107 ms and
whole formatted copy 6.73 s. Exact source/undo/save, timing clocks and protocol
composition pass; the final Preview screenshot is visually checked. Cold
Source is 43/92/98 ms, 428 ms frame gap and 55 ms click. Cold Live is
176/327/342 ms, 341 ms gap and 205 ms click. These partial cold diagnostics show
that the better warm pass is not a cold-input improvement claim.

### Limit palette DOM updates to the physical viewport

A frozen, byte-checked V57 Source profile identifies a 332 ms syntax-publication
task, including 277 ms Editor update and 116 ms native DOM insertion. A separate
178 ms task includes 126 ms layout. CodeMirror's `visibleRanges` describe its
rendered DOM buffer, so coloring every such range also repaints offscreen rows.
The bounded palette now measures a physical screen band plus 80 px on each side
through `requestMeasure`, intersects the existing visible ranges and retains
the complete ancestor/mounted-language grammar. Native DOM overscan is unchanged.

Scroll observers also update the band within the same CodeMirror viewport.
After measurement, a microtask repaints the plugin's decorations through an
empty View update, without a document transaction or a derived-consumer refresh.
Accepted input/composition maps the existing palette until its current input
generation settles. Disposal invalidates queued work. Small documents keep
their existing stock highlighter.

The actual Editor browser regression is red with 34 colored far-buffer rows,
then green with zero while every physical visible row remains colored. It
checks intra-buffer scrolling in both directions, arriving syntax during pending
input (zero palette builds), resize, Source/Live round trips and disposal.
The 128 exact ancestor/mixed-language comparisons and deep-code work bound pass.
Source-side Preview LF/CRLF, viewport-anchor production, complete document
cutover and type checks also pass. Native remeasurement of this palette change
is still required; the V57 numbers above do not include it.

### Defer inline-only table breaks until the table is requested

The exact V57 packaged Preview worker, executed diagnostically in the guest's
Node v24.21.0 with an in-memory parent port, takes 572 ms to load and 2,037 ms
to open the rich fixture. A byte-checked source map attributes about 813 ms to
deferred-inline setup, including 492 ms preparing supposedly lazy groups.
This diagnostic excludes the real host transport/wiki-resolution path and is
not a native first-Preview measurement.

Only roots that can affect cross-root HTML container state need early inline
children. Bare `<br>`, `<br/>` and `<BR />` neither own a container nor implicitly
close one in the pinned HTML parser, so their presence no longer forces early
table/paragraph inline work. Other angle-bracket content, attributed breaks and
closing tags remain conservative. Heading preparation and eager exports keep
their existing behavior and complete context.

The real Preview work-count test fails at 801 initial inline parses for 200
offscreen tables, then passes at one heading parse; requesting one table adds
four parses. It compares 144 eager/lazy complete HTML, heading and partition
cases across both presets, including open containers and escaped/code breaks.
An independent unchanged-HEAD build matches all 2,188 HTML/heading/block-manifest
comparisons for 547 inputs in eager/windowed modes under both presets, including
the complete 1 MiB fixture. HTML export, footnote scope reuse, type checks and
the actual Preview viewport work-budget browser suite pass. Host timing samples
are noisy; no stable end-to-end latency gain is claimed before native testing.

### Keep Live graph layout out of offscreen DOM overscan

The byte-checked V57 cold-Live profile also includes Mermaid SVG preparation
and measurement while typing, and a 541 ms task combining a derived refresh
with Editor layout. Large Live previously started diagrams as soon as their
CodeMirror buffer DOM mounted. A physical IntersectionObserver now admits
Mermaid layout and cached SVG DOM only within 80 px of the scroll surface.
Estimated height remains reserved. Source/theme changes while offscreen retain
the newest desired request; fullscreen updates remain eligible. Ordinary
documents retain their immediate behavior.

Visibility alone does not create another presentation generation: an unchanged
mounted SVG and its camera survive repeated observer notifications. The real
browser regression is red before admission gating (one offscreen render instead
of zero). A separate negative control without notification deduplication is
red on SVG identity; both assertions are green with the implementation. The
test checks first reveal, an offscreen source replacement, cached mode reentry,
nonzero reserved height, exact source and zero retained diagram observers after
mode changes/disposal. Existing small-document presentation, visible controls,
split refresh, foreground edits, partial-line viewport, actual CSP module/ELK
and Source-side Preview checks pass. The surrounding Preview shell and split
controller already own the mounted diagram's destruction; no second disposal
registry is introduced. Native remeasurement remains required.

V58 (`fe96f1d1`, archive SHA-256
`1ee10bc82f516f3263d0b3d8ceee7a1381f7133a8e47dfecd10a1b3bd155b3c2`)
passes the complete native ordinary/rich flow and sixteen strict rich clicks.
Warm rich Source input median/P95/maximum is 35/78/141 ms, Live is 64/156/201 ms;
their maximum frame gaps are 106/201 ms. Rich Live clicks range 128–168 ms in
this run. First Preview is 3.65 s (2.74 s response), cached Preview 664 ms,
drag gaps 60/107/139/101 ms and complete formatted copy 6.85 s. Exact source,
undo/save, timing clocks and protocol composition pass; the final Preview
screenshot is visually checked. This single run is not a universal caret P95 or
proof that cold input is solved. Cold verification is still separate.

### Preserve a measured diagram across unrelated presentation refreshes

A second real Editor regression shows that measuring a new diagram's actual
height changes its initial estimate. Widget equality previously treated that
cache refinement as different content, rebuilding the SVG and controls during
an unrelated presentation refresh. Equality now depends on source, source
bounds, indentation, language, theme and camera ownership. Mounted layout and
its observer continue to own actual height. The obsolete initial-height seed
field is removed; no per-history layout cache is added.

The production regression is red on SVG identity before this change and green
after a full presentation refresh following measurement. Existing real Mermaid
viewport persistence passes typing, undo/redo, both block/document mode cycles,
theme/fullscreen, source recovery, independent camera state, resets and layout
shrink. Type checks pass. This refinement is not in frozen V58; it still needs
native verification.
