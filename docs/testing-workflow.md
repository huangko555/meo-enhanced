# Testing workflow

This repository separates fast feedback from release confidence. The normal
repair loop stays narrow; broad and endurance runs are intentional events.

For release execution and new-test placement, start with
[long-running gates](#long-running-gates) and [adding or changing tests](#adding-or-changing-tests).
After release authorization, pass the chosen disposable document to
`bun run test:release -- <document> --confirm-long-run` when the acceptance scope
requires the full font sweep and endurance. This keeps their complete coverage
in one report and shares identical preflight results. Final installed-VSIX
and native desktop acceptance remain required separately for their applicable scope.

`scripts/test-editor-font-wheel.ts` covers the default-enabled independent wheel
setting, Auto-to-Custom adjustment from the displayed size, persistence/reopening,
coalesced saves, ordinary scrolling, Live/Source/Preview input, fine trackpad
deltas, Ctrl/Cmd modifiers, font bounds, and bilingual light/dark settings at
normal and narrow widths. It runs in quick, targeted appearance and browser gates;
visual evidence is saved under `.local/font-wheel-acceptance/`. The existing
font-size viewport contract covers reading-anchor continuity during layout changes.

Preview preset memory is covered by `scripts/test-preview-preset-preferences.ts`
and `scripts/test-preview-preset-preferences-browser.ts` in quick, appearance and
release gates. They verify built-in/custom initial Auto behavior, independent
theme/font/Boolean choices, switching away and back, reopening a fresh document
without Webview state, stale-cache precedence, legacy migration, concurrent Host
writes and persistence failure. Fixed/unsupported controls retain preset policy;
Default retains its existing configuration owner.

`scripts/test-preview-fonts.ts` covers font catalog decoding, family deduplication,
correlated queries, shared caching, failed refresh retention, code font persistence
and the fixed GitHub font policy. The preset preference browser contract also covers
large searchable catalogs, aliases, restored localized font labels before opening either picker,
shared label queries without preference writes, lazy default/fixed typography, and a pinned default during filtering and scrolling,
IME confirmation, separate body/code families, inline/block typography and split Preview.
Short viewports also verify restored selections remain visible after popup sizing, with
toolbar geometry and outer scroll positions unchanged through comparison, filtering and closing.
Unopened font popups must have no comparison rows during startup or catalog arrival;
the open popup retains all existing selection, search and keyboard contracts.
The toolbar menu contract verifies click ownership and nested Escape ordering in
Chinese/English, light/dark and narrow layouts. System enumeration is local-only;
Windows is smoke checked against the installed font collection. Mac/Linux adapters
need native platform verification before release; unavailable queries use fallback fonts.

The user-facing inventory is in [testing-feature-coverage.md](testing-feature-coverage.md).
`scripts/test-mode-wrapped-line-position.ts`, included in `test:input-presentation`,
checks immediate trusted clicks and the first digit on a cold Live surface five
times, plus actual reading text inside a giant wrapped paragraph through Source,
Live and Preview. `scripts/test-editor-mode-preparation-production.ts` also gates
cold Live preparation and checks that a newer mode intent reveals its own surface.
Performance strategy comparisons are opt-in through
`scripts/benchmark-document-strategies.ts --confirm-long-run`; see
[the policy evidence](large-document-policy-evidence.md) for fixture dimensions,
cold/warm definitions, input/heap measurements and native-test limitations.
`--cpu-profile` saves a separate Chromium profile for each case; those instrumented
runs diagnose call stacks and must not be compared as ordinary timing samples.
`scripts/test-rendered-block-discovery.ts` additionally checks 400 actual tables
mixed with 1,200 literal code examples. It verifies exact table start lines and
bounds tree-root seeks independently of noisy wall-clock measurements.

`scripts/test-large-table-row-window.ts` drives the production Live editor with
1,600 variable-height table rows. It bounds actual mounted cells, checks every
painted native input frame and delayed commit, complete offscreen rich/Markdown
copy, undo/redo row positions, source-cell navigation and mode round trips.
It also covers logical gutter lines, column dragging, narrow/wide viewports,
fractional fonts, source prefix edits, the measured-height path above 12,000px,
and enabling/disabling screen-reader rendering in an open document. Automatic
eligibility is checked at 200x2, 256x4 and 512x2. Run it directly after table,
block-height, native-focus or viewport changes.
`scripts/test-table-worker-history.ts` uses the full production bootstrap and
actual Markdown Worker after a Preview round trip. Every sampled Ctrl+Z/Ctrl+Y
frame must retain the original native cell, source caret positions must be exact,
and the first digit immediately after Undo must reach that cell. This specifically
catches a whole-document readiness wait that the standalone editor harness cannot.
The row-window test also checks stable thumb progress while row heights are
discovered, exact end/reading-row retention on release/cancel/blur, unchanged
automatic and manually resized columns, and native text-copy ownership with zero
unrelated preview allocations. Actual Win32 scrollbar tests remain the native
geometry/interaction check; synthetic pointer intent is not reported as OS input.
The previously focused cell must be able to blur without ending the scrollbar
gesture. This catches capturing window blur listeners that incorrectly observe
descendant focus changes; actual window blur still completes the gesture.
Native scrollbar checks first calibrate both directions in an ordinary scrolling
container. Grips must exclude native arrow buttons; the lower vertical grip uses
`clientTop + clientHeight`, excluding any horizontal scrollbar. A track click or
arrow press must not be reported as a thumb drag or as a table-window failure.
`scripts/test-large-table-gutter-budget.ts` independently exercises the complete
1,600-row accessibility DOM, so row virtualization cannot conceal unbounded
gutter work. `benchmark-document-strategies.ts` provides benchmark-only
`table-eager`/`table-windowed` controls without adding a user-facing performance
switch. Initial GC heap measurements are outside `startup.initMs`; the later
confirmed-interactive navigation timestamp includes GC and is not pure startup.

`scripts/test-preview-table-bands.ts` checks source-backed 32-row reading bands
for giant top-level Markdown tables. It compares every rich row and complete
export with the original renderer, bounds inline parsing as well as HTML,
and verifies complete search/source navigation/copy. Logical table copy joins
internal bands back into one table. HTML containers, nested tables, GitHub and
custom renderers retain the complete semantics. Column preferences retain a
source-table identity across edits and prefix line changes; schema changes reset it.
`scripts/test-preview-table-bands-production.ts` uses the actual production
bootstrap and Worker. Run it both normally and with `--sync`: it checks bounded
DOM, real wheel and Find navigation, top/end intent, native keyboard navigation,
column consistency after visiting new bands, resize/DPR, screen-reader fallback
and every delivered unchanged compositor paint during Source input. Wait for the
split handoff's inert/visibility state before treating its reading surface as
accepted. Internal table bands do not imply a fresh Preview document for every
512-row file: the standalone table admission is separately measured at 1024 rows.
`scripts/test-preview-table-source-identity.ts` inserts preceding Source paragraphs
while split Preview independently reads an unchanged ordinary table containing
HTML, math and footnotes. Both full-DOM and windowed paths must retain original
row/formula DOM, column widths and every observed compositor paint. Source marker
coordinates must belong to the accepted Preview revision, and mapped source-line
changes must retain the exact fractional glyph witness.

`scripts/test-preview-giant-code-highlight.ts` bounds actual token DOM writes for
an 18,000-line fence across scrolling, wrapping and theme changes. It verifies
full selectable text, multi-line grammar and bracket depth from preceding,
offscreen rows. `scripts/test-preview-palette-stability.ts` rejects unchanged
palette refreshes that remove/reapply reading-root styles, and checks real color
changes still propagate. Both belong to the browser release gate. The fence reuse
contract also retains full export highlighting and fallback-only languages.

`scripts/test-markdown-structure.ts` also caps real ParseContext offscreen
registrations for a 2,000-host corpus through twelve first/middle/last viewport
demands. `scripts/test-large-table-gutter-budget.ts` measures real row-geometry
reads in a 1,600-row editor, checks complete visible line-number alignment and
DOM retention, and preserves distant overview endpoints, search, resize and
line-number remounts. It is a targeted browser check; the normal table, search
and diff ruler tests retain their existing gates.


Webview viewport setup waits for an editable mode to be applied before sending
fixture navigation or sampling its controls. The mode button projects a request;
Source preparation can still be pending. Check the visible, interactive editor's
mode and the completed saved-mode projection, then keep the existing frame samples
and behavioral assertions. Do not wait directly for the expected diff-row or gutter
counts. Intentional transition-frame and pending Preview checks retain their own
observation windows.

Document-update fixtures use strictly increasing Host revision numbers for changed
content and verify the complete text was applied before starting another scenario.
A captured `docChanged` message or a fixed frame delay does not establish that
precondition; reusing a revision for different text can leave the old document on
screen. Keep the later theme, trusted-wheel and painted geometry assertions.

Responsive table setup waits on the visible Preview iframe's own animation-frame
clock after outer Webview frames. Its ResizeObserver projects wrapper widths on
that document; outer frames can still expose the preceding width. Keep the full
theme/mode/continuous-resize matrix and the original geometry limits. A finite
pause of the iframe clock must expose the old setup race and the owner-clock
barrier must complete after release, without polling for the expected widths.

Clipped rendered-content history verifies the exact changed native source target,
collapsed selection, real editor focus and full caret visibility after undo.
Retain the clipped-preview precondition and exact history snapshots. A derived
Mermaid graph below that source need not also fit in the viewport: revealing it
again would violate the single history-positioning intent.

Pasted-image naming is covered by `test:image-storage` and the production settings
and link-destination contracts. They verify the document-name default, all naming
presets, continuing numbers across image formats, concurrent exclusive creation,
Chinese folders/document names, escaped Markdown targets and final-file-name alt
text. Settings coverage includes persisted selection, bilingual search and narrow
light/dark layouts; `MEO_SETTINGS_SCREENSHOTS` captures the naming controls.

`scripts/test-link-candidates-production.ts` initializes the standalone fixture's
host font variables and measures native textarea text through Chromium's debugging
protocol. Its real mouse-click checks cover both single-line and wrapped paths in
monospace and serif fonts, retaining caret, completion-resume and insertion assertions.
Native character bounds establish the target's visual line; a shared table-row
height or a separate div mirror cannot establish the native text layout.

`scripts/test-pdf-page-background.ts` runs in the browser gate and uses the production
PDF renderer for every built-in preset and a custom dual-theme preset. It compares
the final PDF's full-paper background drawing on every page against the rendered
document color, including non-white light backgrounds, dark backgrounds, custom
zero/variable margins and a partly filled last page. DOM color checks or a PDF file
header alone cannot catch a contrasting frame in the printed page margins.
`scripts/test-html-content.ts` covers shared HTML tag/style filtering in default
HTML/PDF/DOCX output, adjacent and nested fragments, CommonMark boundaries, image
dimensions, and Live source-above-result editing. Its browser checks preserve
native text selection, disclosure/link actions, undo and mode continuity,
tag/attribute completion, closing tags, literal paste and IME input. They
use the shared input candidate menu. `scripts/test-html-completion-production.ts`
covers its Live/Source tag, attribute and value insertion, single-step undo/redo,
unfinished block tags across Markdown parse transitions (`<p` → `<pr`), quiet
unfinished markup and retained warnings for completed unsupported tags,
paired quotes to the right of an unfinished tag's attribute value,
manual activation, disabled and reconfigured settings, Escape caret retention,
IME ownership, shared placement and bilingual light/dark/narrow screenshots under
`.local/html-completion-acceptance/`; it belongs to quick and browser/release gates.
The HTML content checks
verify pasted HTML opens source without reformatting or moving the native caret,
including trailing blank lines, hidden fragments, sibling blocks and history.
Source/Live transitions continue to respect the caret; inline HTML and code keep
their own input paths. `bun scripts/test-html-content.ts --pointer-only` runs only
the HTML layout/gutter alignment with hidden trailing nodes and nested containers,
HTML/math final-row clicks, native source dragging and actual Ctrl+C/Ctrl+V round trips,
the nonselectable format action and source presentation through pointer release, including
entering a native table cell whose widget bypasses CodeMirror's pointer handlers. The checks also
cover forward/reverse HTML/math cross-block drags, keyboard selection extension,
source-only copying, exact cut/undo/redo and native HTML reading selection.
`bun scripts/test-html-content.ts --selection-only` isolates those selection checks.
Editing previews must not add a second copy of rendered text to the native source
selection. Native VS Code clipboard acceptance has a separate disposable-profile
launcher: `./scripts/test-vscode-html-copy.ps1 -CodePath <Code.exe>`. Build the
current extension and Webview first; it checks mouse selection, Ctrl+C, the workbench copy command,
Ctrl+V and whole-document copying through the system clipboard, restores previous
clipboard text, and records results under `.local/probes/html-copy-*/`. The isolated
launcher uses CDP rather than the host mouse/keyboard and writes only temporary
fixture documents. This does not verify the user's existing profile or keybindings.
The HTML browser checks also
verify that empty/hidden fragments remain discoverable as muted source without
adding an empty preview. Screenshots under `.local/html-fragment-acceptance/`
cover Chinese/English, light/dark and narrow layouts. Existing gutter, mode,
focus and layout contracts use main-document selection to enter HTML source.
The same contract verifies explicit HTML formatting and its single undo/redo,
Live/Source keyboard entry with reassigned and cleared bindings, unified tooltip
shortcut labels, localized filtered-content details, preserved
whitespace, invalid input and late-result protection. Its trusted-wheel scenario
places rendered HTML above the viewport and checks every frame of HTML and math
expansion, preventing unrelated reading-anchor restoration from shifting earlier content.
Word HTML acceptance uses `scripts/test-docx-export-runtime.ts` for inline text,
figure captions and explicit pre-wrap line breaks, and
`scripts/test-docx-export-browser.ts` for hidden attributes, CSS visibility,
transparent/zero-size text, closed details and visible child overrides. Inspect
the final Word document in Word as well: its HTML converter retains editable
text but approximates browser typography, repeated spaces, ruby and custom list
numbering. Deliberately unclosed tags can still affect following HTML content.
`scripts/test-block-editing-transitions.ts` adds a shared production-editor contract
for formulas, HTML, short/folded code and both Mermaid layouts: four directional
boundaries, pointer release, Escape/Enter, reverse Tab, document selection, visible
reading focus and document-end completion without text mutation. It distinguishes temporary hidden-target reveals from explicit long-code
expansion and samples every frame of a tall Mermaid roundtrip, rather than checking
only coordinates after a fixed settlement delay. It belongs to `test:rendered-source`.

`scripts/test-block-passive-updates.ts` covers compact long-code summary focus,
unchanged reading focus through passive refresh and position mapping, retained
neighboring render roots and source tokens during typing, and painted Mermaid
layout icon/caption alignment in both themes, languages, fonts and directions.
It also belongs to `test:rendered-source` and saves visual evidence under
`.local/block-passive-acceptance/`.

`scripts/test-mermaid-viewport-persistence.ts` and `scripts/test-image-layout.ts`
also verify proportional button/wheel zoom beyond the former 4x limit, inverse
steps, retained minimum, reset and unchanged camera/layout behavior. The Mermaid
contract saves a production-rendered zoom screenshot under `.local/visual-zoom-acceptance/`.

The Mermaid/formula inner-source matrix and findings are in
[testing-rendered-block-source.md](testing-rendered-block-source.md). Run
`bun run test:rendered-source` for its dedicated input, boundary and appearance
checks; it also belongs to the targeted rendered and browser gates.

`scripts/test-mermaid-partial-line-input-viewport.ts` also samples each native
source input frame in stacked and side-by-side Mermaid layouts, across plain,
quote, list, nested quote/list, footnote and tab prefixes in both appearances.
Enter, continuous typing and undo/redo must retain the code font, source inset,
split wrap width, focus and scroll position, without adding inner line numbers
or modifying real container prefixes. Visual samples are saved under
`.local/mermaid-input-acceptance/`.
Review its operation outcomes against the README, commands, settings and changes
since the last release before selecting acceptance evidence. Gate membership is
necessary, but a visible control or emitted message alone is not a successful
operation. Report browser, Host-contract and final installed-VSIX evidence separately.

`scripts/test-mermaid-editing.ts` checks that a zoomed tall diagram in side-by-side
editing fills the document viewport to its bottom, including after window resizing,
and stops at its block boundary. It covers English/dark and Chinese/light with fixed
editor chrome above the document. Use `--preview-viewport-only` for the focused
regression; the default invocation retains it in the rendered and release suites.

`scripts/test-tab-switch-reading-position.ts` checks retained Webviews with both
offscreen parking and `visibility:hidden` inside the viewport. Geometric intersection
alone treats the latter as visible; accepting its smaller size can let the outline
collapse Preview and reset its scroll. Check outline on/off, native selection messages,
full/split Preview, built-in presets and actual small-panel resizing. Confirm the
visible paragraph and its offset throughout the return, rather than only the final scroll.
Include VS Code's `clip-path:content-box` ancestor: painted visibility can report
false negatives there, so the correlated Host reply must still permit visible resizing.

`scripts/test-native-scroll-progress-production.ts` checks trusted wheel input in
both directions, instantaneous scrolling and the browser's multi-frame native
scroll animation, with independent visible-content witnesses. The headless wheel
default does not animate, so this test switches only its platform scroll behavior
to native `smooth` scrolling while retaining the trusted wheel event. It belongs
to the quick, targeted viewport and release gates. Late-layout compensation remains
covered by the viewport and virtual-block contracts. Full-document scroll traversal
must reach both boundaries; a capped or stalled loop cannot report full traversal.
The tall-Mermaid viewport contract checks each trusted pixel-wheel event's target,
delta and scroll response, then waits for stable anchor/gap/scroll geometry before
applying its unchanged displacement limit. Failure reports retain event and frame
traces so dispatch timing cannot be mistaken for settled native scrolling.
`scripts/test-rendered-block-scroll-layout.ts` bounds Chromium layout counts when
a 60-row table mounts and scrolls, loads the real Mermaid runtime, and checks
reading retention when either block fills the viewport without a text line.
It rejects redundant source-metadata mutations and geometry reads from detached
or disposing tables, while retaining focused-cell caret measurement.
Its controlled height-map receipt isolates delayed CodeMirror anchoring from
actual DOM movement. It also verifies that background Mermaid warming waits for
native scrolling to settle, resumes afterward, and respects cancellation; visible
render calls remain immediate. Full-document scroll and font sweeps use delayed
SVG adapters to control layout timing; actual Mermaid rendering is covered by
the editing contracts and full-document UAT.
The viewport-controller unit matrix interleaves background document presentation,
native wheel adoption and virtual-gap contraction in both directions. Document
presentation yields its fixed-target projection to the active native reading owner;
explicit viewport controls retain their separate capture behavior.
Standalone bulk edits retain the explicit capture path and end the preceding
native reading owner, including edits between wheel receipt and scroll adoption.
Native layout retention uses the last observed scroll position and line geometry;
nominal height-map movement is only a layout signal. Cover complete/partial
anchoring, browser boundary clamps, below-line growth/contraction and input whose
native scroll has not yet been adopted, without replaying event deltas.
Also combine range growth/contraction with continuing native motion in the same
gesture: range changes alone must not reject actual scroll progress.
`scripts/test-live-caret-continuity.ts` also covers input whose virtual height
correction changes the scroll offset while the physical caret stays in place,
with and without a separate `beforeinput` event. Compare successive measurements
so accumulated normal typing scroll is not mistaken for a new correction.
Retain normal wrapping context, later layout retention and cancellation by new
navigation; supplement this contract with the original production document UAT.
IME fixtures must hit painted text or use native caret movement, then verify the
source boundary after Live marker reconciliation paints. A `display:none` source
delimiter has a zero rectangle and must never become an editor click at `(0, 0)`.

For installed-VSIX scrollbar acceptance, use an isolated VS Code profile and check
Live, Source, full Preview and split Preview in light/dark appearances, including
Default and GitHub Preview presets. Trusted wheel input must move actual content;
drag the native thumb to both boundaries and record visible scrollbar screenshots.
Resolve pointer coordinates against the active outer Webview and nested Preview
frame. The scrolling document's content width excludes its scrollbar, so use the
Preview viewport width when targeting that scrollbar. Grab the thumb rather than
the platform arrow buttons, and remeasure after virtualized content settles.
Programmatic scroll assignments may prepare a case but cannot prove dragging.

`test-live-decoration-history.ts` counts baseline comparisons and full rendered-block
discovery during accepted large Source/Live input. Both stay behind the primary text
frame, including its first two animation frames; settled summaries must still describe
the actual change. The real DOM keydown path must not request the full HTML block
list to decide whether the current selection needs source editing. A real collapsed-code
pointer click must not invalidate unrelated canonical Markdown presentation. Existing
exact undo/redo, pending-input mode changes and widget-position checks remain required.
`test-live-scan-budget.ts` also checks the actual CodeMirror height-comparison mode
(`minPointSize=0`): shared offscreen widgets must not pull ordinary marks into that
comparison. Preserve point semantics and the combined height summary when mapping
partitioned ranges, including edits with no widget offset changes.
An anonymous full-length parser placeholder must not expand a Live presentation
band to the whole document. Cold Live must wait for matching Worker presentation
facts before creating rich widgets. Syntax readiness alone is insufficient: publish
the final Live decoration value before uncovering the initial editable surface.
The delayed-Worker regression in `test-background-markdown-structure.ts` checks
this without a foreground full parse; `test-mode-wrapped-line-position.ts` checks
the first visible heading geometry and immediate trusted click/first-digit input.
Do not add a post-reveal settling delay to make that first input pass.
Paint tests explicitly activate their own page and require visible document state.
Frame waits have a deadline and report whether the page still executes JavaScript,
its visibility and mode, so a stopped compositor and a blocked renderer are not
both reduced to an opaque three-minute protocol timeout.
The nested Markdown fixture must use the actual View decoration providers, since
single-layer synthetic ranges do not catch height-summary propagation through
joined layers. Shifting one control must retain unchanged line-point chunks.
Caret clicks must not toggle the descendant drag-cursor override; real drags must
still enable it and clean it up on release.
Local input also fixes one proven Markdown syntax snapshot for nested readers;
successive projected footnote reads must not repeatedly extend embedded parsers.
Cover nested, middle and trailing Enter through settlement, compare later widget
offsets and source lines against a complete build, and undo exact text. A newline
that introduces a global reference definition must invalidate its outside users.
Large Live pointer input must delay cold code highlighting until caret frames
have yielded, resume afterward, and cancel the pending retry on destruction.
Also cover an internally complete parse whose published tree is still partial;
the first input must not retire its complete presentation. Footnote continuation
line metadata must match an independent new-state parse, including numbering and
reference targets. Explicit line jumps must show their real target without a
full Live rebuild, while pure geometry effects retain accepted presentation and
unrelated resource effects still invalidate it.
First caret selection can also publish an already completed internal parse.
Cover that coalesced publication with frontmatter and distant footnotes, compare
the selected canonical presentation with a complete build, and verify that its
local readers do not advance embedded parsers. Incomplete or unproven syntax
must retain the authoritative fallback.
Also check completed syntax publication on the next microtask without source or
canonical-presentation changes or another full Live build. This path must use
the public zero-budget parse publication API and cancel on View destruction;
unfinished syntax must not become a new Source prewarm path.

`test-preview-viewport-work-budget.ts` exposes the browser's native scrollbar.
It checks range retention while a nearby block changes height, release outside
the iframe, exact restoration of authored styles, a release-time upward anchor
adjustment after the thumb reached the bottom, bottom retention through late
range growth and retirement of that intention by a new wheel gesture, deferred reading controls,
zero-size code typography, copied source after a preserved-frame update, and
bounded geometry inside a 150-note footnote section. Its parser contract compares
the browser's canonical HTML across UTF-16, entity, code, table and MathML chunk
boundaries, including superseded writes and repeated cancellation.

For changes to large Preview loading or positioning, the bounded variants
`test-preview-loading-reuse.ts --large`,
`test-source-preview-late-layout.ts --large`,
`test-mode-roundtrip-reveal.ts --large` and
`test-preview-navigation-continuity.ts --large` exercise the actual size policy
and sliced parser. Their ordinary variants retain the existing gate membership.
Run native VS Code measurements separately from other browser tests. Start the
measurement after profiler activation and stop it before profiler teardown;
those diagnostic operations can themselves pause animation frames. Retain actual
trusted pointer receipt and visible scroll progress separately from CDP command
delivery. A missing pointer event is an invalid drag sample, not evidence of a
successful or slow product gesture.

`scripts/test-long-document-scroll.ts` exercises the production Webview in Live,
Source, Preview and split views, using shared visible-content witnesses in both
scroll directions. The targeted viewport gate uses a bounded rich-document fixture
and verifies that unchanged tables retain their measured height, including the
first mounted geometry after virtualization before queued row sizing completes. For a reported
local document, use `--document=<path>`; `--full` requires reaching both boundaries,
and `--gesture` checks continuous native mouse scrolling. Full traversal follows
the long-run authorization policy below.

| Tier | Use it when | Expected time | Command |
| --- | --- | --- | --- |
| Light UI | Copy, existing icon replacements, or local visual style changes meet the boundary below | Build plus a scoped smoke pass | `bun run test:ui-light` |
| Quick | A behavior or other implementation change is ready for a general regression check | Last measured baseline about 18 minutes; host dependent | `bun run test:quick` |
| Targeted | A change affects one high-risk area, or a quick check identifies that area | About 1–5 minutes | `bun run test:targeted -- <area>` |
| Release | A release candidate or separately authorized cross-cutting risk needs the complete gate | Historical baseline 55–105 minutes before execution optimizations; document supplements and native acceptance are additional | `bun run test:release -- --confirm-long-run` |
| Large document | A shorter production-like document stress pass is specifically needed | About 1–3 minutes | `bun run test:large-document -- <document> --confirm-long-run` |
| Endurance | Full-document edit, undo/redo, cursor, and viewport stress is specifically needed | About 20–35 minutes per run | `bun run test:endurance -- <document> --confirm-long-run` |

## Validation for commits and merges

Select validation by behavioral scope and risk. An ordinary feature/fix commit
or merge into `main` uses the normal quick/targeted checks and applicable type,
build, privacy and staged architecture/Protocol checks. Reuse evidence that
still covers the same candidate; a fast-forward merge does not require another
run. Conflict resolution or integration changes require checking the affected
scope. Ordinary completion needs no waiver from the full long-running suite.

Full long-running validation primarily supports release acceptance. Outside
release work, recommend it only when specific cross-cutting, Protocol,
persistence/migration or accumulated interaction risks expose gaps in the
existing checks. State those gaps, scope and duration and obtain current-task
authorization. A commit, merge, completed feature or milestone alone does not
promote validation to the release tier; release coverage remains unchanged.

## Light UI changes

Use this path only for copy, replacing an existing icon, or local visual styling.
The diff must preserve interaction behavior, Protocol, persistence, configuration
structure, and other high-risk logic. Changes to event handling, focus, keyboard
routing, input, state, theme derivation, or multiple interactions use the normal
quick and relevant targeted gates. When the boundary is unclear, use that path.

Completion requires:

1. A build or type check appropriate to the changed files. `bun run test:ui-light`
   builds the Webview; its success reports automated build evidence only.
2. One focused visual smoke of the changed control in Chinese/English and
   light/dark appearances. Check legibility, wrapping, clipping, overlap, and
   the relevant hover/focus states; include a narrow view when layout is affected.
3. A functional smoke of the affected entry or control, observing its actual
   outcome, such as opening and closing the intended Settings window.
4. Update existing expectations affected by the copy/icon change and run the
   relevant contract when needed. Simple copy does not need new mirror tests.

Use the existing preview/browser path and retain screenshots plus the observed
action results. Report build and smoke evidence separately; running the command
alone does not complete this path. Reuse evidence that still covers the current
diff instead of rebuilding or repeating unchanged checks. This path does not
automatically run unrelated history, table, scrolling, or broad regression packs.
Behavior changes and accumulated interaction risk still require quick/targeted
checks. Release coverage, long-run authorization, privacy and commit Hook checks
retain their existing requirements.

## Long-run recommendation and authorization

The agent owns the decision to recommend a long run; the user does not need to
remember the tiers or commands. Recommend the appropriate run proactively when
the work reaches one of these boundaries:

- **Release:** a release candidate needs acceptance, or specific broad
  cross-cutting risks exceed the coverage of normal quick/targeted checks.
- **Large document:** a shorter production benchmark, sampled strict UAT, and
  live-scroll integrity pass are enough to assess document-scale risk.
- **Endurance:** undo/redo, cursor, viewport, tables, or rendered-block editing
  has changed substantially, regressed repeatedly, or is ready for final UAT.
- **Clean-environment/VM validation:** a final VSIX or installer needs an
  installation and startup check outside the development checkout.

Every recommendation must state the test type, why it is warranted, its scope,
and its expected duration. Release, endurance, full browser matrices, repeated
stress runs, full-document sweeps, and VM validation wait for explicit user authorization
in the current task. A generic request to fix, build, test, commit, or merge
is not authorization. The confirmation flag records an intentional invocation;
it is not a substitute for asking. `--dry-run` is always safe and prints the
exact commands without running them.

## Daily repair loop

Browser fixtures must establish the state their assertions inspect. Reset an
inherited selection and fit a finite fixture before querying its complete reading
DOM; offscreen nodes may be virtualized. After a pointer release, wait for the
resulting presentation before reading its activity markers. For text-boundary
clicks, use integer coordinates inside the first half of the visible glyph rather
than a fractional edge that can round into hidden syntax. Inject command failures
into document-changing transactions so unrelated UI effects cannot consume them.
When positioning a popup after typing, use a native wheel gesture and verify the
actual anchor position before testing its edge layout. Assigning `scrollTop`
alone does not signal a new user scroll and can compete with input retention.

For native block-action clicks, wait for `whenVisiblePresentationReady` after the
last fixture navigation and before acquiring the final control handle. A visible
box and `scrollend` may precede that navigation's source presentation; stale
coordinates can turn a button click into a source selection. Preserve actual
pointer events and the existing identity/replacement guards.

Document navigation may itself open a rendered block's source. Wait for that
presentation before operating Edit/Finish or layout controls, and locate Mermaid
toolbars by their source position rather than a label that changes on completion.
After leaving Preview, wait for the editor host to become visible and non-inert
before a separate focus/selection scenario; the active mode label precedes the
end of the covered presentation transition.
Inspect diagrams through `.meo-mermaid-svg-wrapper > svg`; toolbar icons are also
SVG elements. Completion returns keyboard focus to the block's reading target.
Assert a tooltip's retained identity only while its owning control survives;
replaced or moved controls must close their previous hint before a fresh hover.

`scripts/test-document-save-as-view-state.ts` checks one-shot view handoff before
native replacement resolves and when the default editor needs a later MEO open.
The first init retains mode, semantic reading position and selection with opening
memory enabled or disabled. Initial native selection must not override it.
`scripts/test-save-as-view-state-browser.ts` captures the production Save As
snapshot and verifies both the first visible frame and settled viewport in Live
and Source, including table geometry above the reading position.

`scripts/test-viewport-controller.ts` covers native smooth progress past its final
wheel event and deferred height-map updates after scrolling becomes idle. A proven
reading anchor becomes dormant rather than polling indefinitely; new input retires
it. `scripts/test-fixed-chrome-dom-geometry.ts` checks that repeated fixed-toolbar
measurements do not mutate widget DOM, while live transforms and replaced parents
still produce fresh coordinate mappings.

`scripts/test-document-save-as.ts` checks strict request/response codecs, draft
preparation, active-MEO native Save As, cancellation, failures, duplicate
requests and replacement of the old panel before completion. Same-file native/MEO
tabs in one group or split groups must keep the dialog on MEO and leave the native
source tab intact. Dispatch guards reject inactive panels, changed documents or
editor types, including focus changes during save preparation. The native command
returns no URI, so only the initiating group's resulting tab with a manual native
save receipt confirms the destination; unrelated saves, source auto-save during
the dialog and unconfirmed tab changes must not claim success. It distinguishes a
saved file from failure to reopen its Markdown target in MEO.
Native open recovery returns a successful save result and offers retry/default-editor
actions without writing again, even after the source panel closes. An undefined
native result stays quiet and does not assert cancellation. Live-Webview errors
have one owner; closed-panel failures retain native feedback.
`scripts/test-document-toolbar.ts` exercises the production toolbar order,
Live/Source undo/redo, pending native table cells, Save As snapshots and retries,
Preview restrictions, user shortcut hints and light/dark Chinese/English layouts.
Narrow layouts use the existing overflow menu. Host API contracts and browser
clicks are separate evidence; native dialogs and final installed-VSIX replacement
still require native acceptance.
The toolbar browser fixture also injects Save As failures/timeouts and native
history failures. It checks latest-draft retry, quiet incomplete results,
no automatic repeat writes/replays, actionable copy recovery for toolbar/keyboard,
and captures bilingual light/dark screenshots of the production notice UI.

`scripts/test-list-toolbar-browser.ts` checks all three toolbar list actions in Live
and Source with monospaced/proportional fonts: empty and nonempty caret placement,
indented markers, immediate task layout without overshoot, conversion, cancellation,
forward/backward multiline selection and one-click undo/redo. It runs in the list,
high-risk browser and release browser gates.

`scripts/test-ui-colors.ts` checks the eight base inputs, configuration ownership,
strict Protocol decoding and correlated saves. `scripts/test-ui-colors-production.ts`
uses the production Settings window and the same configuration owner to verify
preview/cancel, save failure/retry, reload, separate light/dark profiles, external
updates, delayed replies, high contrast and narrow layout. Opposite host/UI
appearances must use the bundled VS Code default base colors, remain independent
of the opposite host's UI colors, honor custom overrides, and show the actual
default source in Chinese/English hints, reset labels and search. Returning to
Auto must follow the active host again. Continuous swatch input
must coalesce derivation into one frame, retain the latest value and avoid feedback
writes to the native input. Apply and discard are also checked before that frame.
Both are quick and targeted appearance checks; ordinary UI edits must preserve
Source content. Document background edits change only its carrier, retaining
native Source ink and keeping the toolbar surface independent.
`scripts/test-editor-background-theme.ts` additionally checks Live/Source/Default
Preview backgrounds, CSS-only Preview color updates without Markdown rendering,
and independent Preview presets retaining their paired backgrounds.

`scripts/test-source-syntax-first-paint.ts` checks idle Source preparation through
the production editor. An unchanged Live/Source roundtrip and reapplying the same
palette must paint syntax immediately; edits prepare only the latest revision.
It also checks preparation behind a hidden Preview cover and cancellation.
The Shiki lifecycle contracts verify bounded shared caches, unchanged palette
reuse, real palette invalidation, stale-work cancellation and final disposal.
The background-demotion unit check explicitly advances reading-pause timers and
idle callbacks, including fast polling turns. A fixed count of zero-delay timer
callbacks does not prove that a real 50ms pause expired on every operating system.
Background Source preparation pauses between batches during native reading and
retains completed work. Explicit Source transitions promote the same job, keep
the current surface covered until prepared, and reuse the cache on return.
These checks are small, deterministic regressions rather than long benchmarks.

`scripts/test-shiki-empty-line-recovery.ts` checks the shared Source, Live and
Preview token caches in light and dark themes. Raw HTML followed by a blank line
must recover Markdown headings, emphasis and inline code, regardless of language
loading order or a token batch boundary. It also checks CRLF offsets, quote/list
exits and open multiline strings/comments. It belongs to quick and appearance
gates; Source DOM recovery and installed Node export have separate checks.

`scripts/test-input-focus-return-production.ts` checks production Find, Replace
and Settings search in Live, Source and Preview. It uses separate browser
documents to exercise window focus ownership, backward/forward/collapsed ranges,
horizontal input scrolling, immediate typing and returning to the document on
close. New clicks, explicit Find and value changes must supersede old recovery.
It belongs to the quick and targeted search gates. The smaller
`scripts/test-editor-focus-window-return.ts` also checks both blur event orders,
input invalidation, modal ownership and disposal. Browser evidence does not
replace native Windows Alt+Tab or Workbench menu validation.

`scripts/test-preview-navigation-continuity.ts` exercises the production Webview
with real Preview rendering. Outline jumps, keyboard fragment links and return
to top must retain the new location when returning to either Live or Source,
without a body click. It also checks unchanged roundtrips and samples multiple
frames after the return. It belongs to the quick and targeted viewport gates.

`scripts/test-tab-switch-reading-position.ts` connects the real Host navigation
adapter to the production Webview in a separate browser document. It hides the
MEO frame, activates a native-editor fixture, delays its messages until return,
then replays document sync and focus. Live, Source, Preview, linked split and
independent split must retain both their visible content and its viewport offset
on every sampled frame, across two returns with different native selections.
It covers the first native selection arriving after startup, an initial native
selection and an unrelated native document. The first post-startup selection
must preserve the viewport even when no selection was sent during startup;
deduplication of an initial selection alone cannot prove that path.
`scripts/test-panel-session-tab-navigation.ts` separately drives actual Panel
Session activation, visibility and selection subscriptions. Both contracts and
the navigation lifecycle check belong to `test:reading-position`, which is
required by quick, targeted viewport and release gates. These browser and Host
contracts do not replace installed-VSIX Workbench validation.

`scripts/test-preview-preset-position.ts` samples the same content-relative reading
point on every frame while switching built-in and custom presets with different
fonts, widths and spacing. It covers light/dark, full Preview, linked and independent
Source side Preview, rapid switching, late responses after trusted scrolling and
the document start. It belongs to quick, targeted appearance/viewport and the
preview-preset acceptance pack; pixel scroll offsets alone cannot pass this check.

`scripts/test-preview-shortcuts-production.ts` checks trusted keyboard input in
full and side Preview, including live binding changes, Save's emitted revision,
Find/Replace and mode switching from text and margins. Native selection, copy,
undo, scrolling, composition and iframe input controls must keep their scope.
It belongs to the quick and targeted history gates.

`scripts/test-wiki-paths.ts` uses POSIX and Windows URI fixtures on every host to
distinguish vault-root `/...`, document-relative paths, explicit `file:` URIs and
drive-qualified paths. It covers links and image resource maps, fragments,
Unicode/space/literal-percent names, and collisions with OS-root files. It runs
in the unit and Wiki gates. `scripts/test-wiki-resources.ts` retains real-filesystem
coverage; its native `fsPath` absolute-path assertion applies only to Windows
drive paths. POSIX filesystem locations use `file:` URIs instead of changing
the existing vault-root meaning of a leading slash.

`scripts/test-image-path-compatibility.ts` checks document-relative precedence,
Obsidian vault and owning-workspace fallback, encoded image names, explicit
relative paths, root traversal, unrelated workspaces and remote URI identity.
It exercises the production Preview-to-Host seam and the HTML/PDF/Word export
HTML builders for Markdown and HTML images. It runs in the image-storage and
unit gates; final PDF/DOCX generation is separate evidence.

`scripts/test-link-destinations.ts`, `scripts/test-link-cursor-production.ts`,
`scripts/test-preview-links.ts` and `scripts/test-document-links.ts` exercise the
shared link-destination rules through Live/Source, actual Preview rendering and
Host file navigation. Windows drive paths use file URIs before URL filtering;
check both separators, escaped filenames and fragments. Preview links must keep
their pointer, hover hint and click routing in every built-in preset. MEO Preview
and HTML/PDF exports explicitly allow local file links in every preset; executable
URL schemes remain filtered. The direct GitHub compatibility renderer retains its
strict defaults. Raw HTML destinations must normalize before early URL filtering.
Host contracts assert the final editor choice: resolved Markdown targets use MEO
in every view, including Wiki, extension fallback, mixed-case extensions, remote
URIs and fragments; other files retain their associations. Same-document fragments
reveal without reopening. Browser contracts click Markdown, reference, Wiki and
HTML links through production Live/Source and Preview paths, including ordinary
and Ctrl clicks where supported. Source HTML coverage includes relative hrefs,
multiline tags, unquoted attributes and entities, with code/comments and unsafe
schemes excluded. Browser message delivery and Host command routing are distinct
evidence; final installed-VSIX behavior still requires native acceptance.

`scripts/test-local-links-production.ts` covers angle-wrapped local paths with
Chinese and spaces in Live prose and tables, real Ctrl clicks, file-resource
invalidation and out-of-order responses through the full Webview bootstrap in
Chinese/light and English/dark. It runs in quick and browser/release gates.
`scripts/test-document-links.ts` also runs in quick and retains Host coverage for
creation/deletion, extension fallback, external file URIs, missing directory
ancestors, watcher disposal, asynchronous native registration races and Markdown
filenames that must not fall back to websites.
`test-protocol-stale-responses.ts` covers immediate invalidation of
obsolete missing hints; these focused checks take seconds rather than a long run.

`scripts/test-export-links.ts` and `scripts/test-export-links-browser.ts` run in
quick, targeted appearance and release gates. They cover all built-in presets and
a custom preset with the GitHub base, both path separators, encoded filenames,
local URI fragments, web/mail links, authored/raw HTML anchors, contents and
footnotes. Trusted HTML clicks must stay in the exported file despite its resource
`base`, including Unicode IDs and filenames containing spaces, percent and hash
characters. Final PDFs must contain the matching URI link annotations and internal
destinations; a PDF header alone is insufficient. This does not prove how each
desktop PDF viewer handles opening a local file.

`test:mermaid-compatibility` uses the shipped offline runtime to check Live and
Preview, real Source split typing, stale-render rejection, focus, reading-anchor
retention, linked editing and light/dark switches. Its export checks cover seven
diagram types, actual ELK/Dagre geometry, author overrides and shared colors;
the browser export check also generates final Word and PDF files. Eight-category
pie charts are checked in both themes, Word drawing bounds against actual page
margins, and PDF heading/description/diagram pagination. Build first.
This focused pack typically takes less than a minute.

`bun scripts/test-fenced-code-boundaries.ts` checks Source/Live coloring and real
Mermaid source typing at unfinished fences, including quote/list exits, nested
quotes, ordered lists, deleting a closer, authoring an unfinished diagram, and exact document undo/redo. It also
captures light/dark screenshots. `test:rendered-source` includes this contract.
The quick Shiki recovery contract checks longer same-type closing fences and
rejects short or mismatched closers, including unfinished embedded syntax.

1. Reproduce the reported behavior with the smallest relevant contract.
2. While implementing, rerun only that contract.
3. For a coherent change within the Light UI boundary, complete that path.
   For behavior or other implementation changes, run `bun run test:quick` once.
4. Add the matching targeted pack when the change touches a high-risk area.
5. Assess the long-run triggers above. If one applies, recommend the matching
   run and wait for authorization; otherwise stop.

When an authorized release gate immediately follows the repair, do not prepend
another complete quick gate. The release gate covers those contracts. Finish
the focused regression and review first, then fix the candidate and run release
once. A real failure returns the task to diagnosis; report that phase separately
instead of repeatedly promising that acceptance is almost finished.

This avoids repeatedly paying for browser startup and unrelated matrices while
still checking type safety, workflow policy, history, tables, rendered blocks,
input-derived work, viewport behavior, and one production browser scenario in
the quick gate.

For semantic UI colors, `test:theme-inheritance` covers shared surfaces, neutral
text and icons, switch states, cached palette reuse and invalidation when the
base surface changes. It also checks that unrelated native menu colors cannot
recolor the palette. `scripts/test-webview-search-controls.ts` covers empty,
typed and cleared inputs, inset clear-button geometry and hover feedback in
light/dark appearances; the panel close action retains toolbar button styling.

`scripts/test-source-active-line.ts`, included in `test:theme-inheritance`, checks
that ordinary, quoted, and fenced-code Source lines use the native
`editor.lineHighlightBackground` without a rectangular shadow, border, or outline.
It covers Light/Dark 2026, custom translucent colors, and transparent backgrounds.

`scripts/test-line-number-rendered-block-stability.ts` runs in the quick, targeted
viewport, and high-risk browser gates. With real Mermaid, KaTeX and fonts, it
samples every animation frame while typing and deleting above rendered blocks.
Unchanged preview heights and all downstream line numbers must stay stable;
a settled final frame alone cannot pass this contract.

`scripts/test-display-math-gutter-paint.ts` also replays held-key input at about
30ms intervals in formula source and inline code, across Live/Source and narrow
quoted layouts. It compares source content and native gutter DOM rectangles
after each frame's callbacks, without CodeMirror geometry queries that would
flush pending measurements and mask a one-frame mismatch. The rendered-source
gate includes it so both retained and changing preview heights are checked.
It also covers browser composition input, saved/agent baselines at 120%/150%
scale and actual screencast pixel alignment during changing formula fitting.

The [line-number layout contract](line-number-layout.md) defines numbering,
geometry, caret and lifecycle invariants. `test-line-number-layout-contract.ts`
checks first-frame split projection, caret-relative numbering in Mermaid/HTML,
setting changes, typing, resizing and font changes. It and the input-frame test
run in quick and targeted viewport gates. The daily long-caret test uses
`--sampled --hidpi`: six distributed targets in a 2,112-line document, including
original-content display, rather than a full-document sweep. Empty-line caret
screenshots are included in the targeted viewport and source-diff gates.

`scripts/test-math-tag-layout.ts` uses real KaTeX styles and fonts to check that
equation numbers remain visible, fit inside the formula canvas and never overlap
the expression. It covers `\tag`, `\tag*`, long expressions and numbers, aligned,
align and gather environments in Live Preview/Split, Preview, Source's side
preview and HTML export, including PDF/Word formula fitting, with both themes
and narrow/wide panes. Live zoom,
reset and fullscreen are checked through their controls. This contract runs in
the targeted rendered and full browser gates.
It also checks automatic wrapping of continuous and nested fractions: adjacent
rows must retain visible clearance and fit their container in Live, Preview,
Source's side preview, HTML export and print preparation. Inline math, equation
numbers and fraction/matrix internals retain their native spacing. The matrix
covers Default, GitHub and a GitHub-based custom preset in Chinese/English,
light/dark and narrow/wide panes. Live is checked once per language/theme/width
because reading presets do not affect its layout. The Preview and side-preview
checks confirm the requested preset actually rendered. `--capture` saves narrow
Live/Preview screenshots under `.local/test-artifacts/math-reflow/`, named by
preset, surface, theme and language.
Use `--preview-only` for the focused preset display/visibility loop while
retaining the full surface matrix in the registered regression run.

`scripts/test-live-input-path-production.ts` observes inserted text's computed
styles in the first four input frames, including IME preedit and commit. It covers
inline format boundaries, nested formats, content replacement and history replay.
Input outside delimiters must remain unformatted; invalidated syntax must release
the old formatting after the deferred refresh.

`scripts/test-link-cursor-production.ts` checks Live links in inactive/active prose,
HTML and native Markdown tables, with trusted pointer and modifier-key input.
It verifies stationary Ctrl/Meta hover, excluded Alt/Shift combinations, focus
outside the editor, window blur, plain clicks and one-time navigation in both
themes. Source links and directly clickable footnote/open-link buttons remain
covered. This check is part of the production browser gate.

`scripts/test-preview-code-update.ts` also checks style-only reading geometry.
It warms the source map, changes paragraph metrics, and captures/projects a real
reading point synchronously in `onRendered`, before ResizeObserver delivery.
Both growth and shrinkage must expose current source ranges and retain the same
scroll position. This closes the window where a queued image commit could reuse
pre-font-change geometry; asynchronous resize notification alone is insufficient.
`scripts/test-preview-deferred-geometry.ts` also releases a real pending image
below an active font reading point. Growth, shrinkage and a newer appearance
must keep that point through the same rendering opportunity; trusted wheel
input must take over, and hiding or replacing the document must retire retention.
The image transaction still uses the shared viewport path, then reaffirms the
active appearance's visual anchor before paint instead of treating that
programmatic projection as native input.
`scripts/test-preview-mermaid-runtime.ts` holds a real Mermaid resource operation
past the 20-frame appearance settling window. Hide/stay, hide/show and a style
update while hidden must permanently retire the old anchor, while the late SVG
still commits. These controller checks complement the production hidden-image
and Source Split checks; the adjacent editor is only an isolation observation.

## Tooltip display timing

`scripts/test-tooltip-display-latency.ts` observes actual Chromium compositor frames
while a synchronous renderer task spans the 200ms hover deadline. It checks both
themes, reduced motion, Preview iframe styles, pending dismissal and committed
state updates. It complements the production control checks in
`scripts/test-tooltips-production.ts` and runs in the targeted appearance and
release browser gates. A JavaScript timer or RAF alone cannot prove paint timing
while the renderer is busy.

`scripts/test-tooltip-pointer-position.ts` checks the shared component and delegated
binding in both languages and themes, including Preview iframe coordinates,
continuous movement, boundary fitting, scroll dismissal, keyboard fallback and
menu avoidance. It also verifies clipped outline and completion text outside the
list on the right/left, row alignment, explicit direction precedence and fallback
when neither side fits. It runs in the targeted appearance and release browser gates.
The production tooltip check also reveals a clipped heading beside the real outline.
Production split-view alignment and floating table header checks verify ordinary
button-anchored alignment hints and pointer-positioned table hints respectively.
`scripts/test-source-position-marker.ts` retains the existing editing-position
marker coverage and checks the fixed divider pair while synchronized scrolling is off:
a shared 26×48px capsule with shortened arrows and touching circular hit targets,
stable centering independent of caret and hover,
semantic viewport alignment in both directions, unchanged origin viewport, Source
selection/text/focus and horizontal position, independent subsequent scrolling,
repeated activation, document boundaries, keyboard activation and anchored hints.
Stale Preview content disables alignment until the current render is ready;
automatic sync resumes from the last explicit origin. Automatic sync and full
Preview hide the pair. The previous moving locator and hover-block overlay are absent.
`scripts/test-viewport-controller.ts` also checks one-shot semantic mapping with
unequal content heights, fresh geometry, origin ownership, selection preservation
and no background work or continuous projection while sync remains off.

`scripts/test-tooltip-hover-sequence.ts` checks the 500ms continuation window
with native button and Preview frame crossings in both themes, including hover
fade-in controls and persistently hidden controls. It verifies that only shown
pointer hints start or renew the window, and covers expiry, empty
targets, clicks, explicit dismissal, blur, removal, owner disposal, keyboard focus
and stateful updates. It runs in the targeted appearance and release browser
gates alongside the compositor timing and production control checks.

## Math source highlighting

`bun scripts/test-math-syntax-production.ts` checks math syntax through the production
Source and Live editor in both themes: inline and display delimiters, all four math
fence aliases, quoted/list containers, unfinished formulas, escaped/currency/code
boundaries, comments, lazy language loads, multiline token batches, independent
Source customizations and typing/undo/redo. It saves real-theme screenshots under
`.local/test-artifacts/math-syntax/`. This contract belongs to the quick, targeted
appearance and release browser gates. Source first-paint coverage also includes
inline math so preparation and mode roundtrips retain its syntax colors.
Currency checks compare every numeric run with the prose foreground, including
Chinese text and a later escaped dollar on the same line. Closed numeric formulas
and explicit unfinished math must retain their highlighting.
Unclosed `$$` source stops at headings, code fences and quote/list container exits
in both Source and Live, with or without blank separators. Recovery preserves
native Markdown colors, typing/history, empty lines and long formulas; math code
fences retain their normal Markdown extent. Completion cannot reuse a TeX closer
past the recovered boundary. The contract also captures the unfinished-block result.

## Math autocomplete

`bun run test:math-completion` checks formula command contexts, replacement and
template compatibility with the installed KaTeX, then exercises the production
Live/Source editor. It covers incomplete delimiters and all four math fence
aliases, nested tab stops, existing arguments and environment closers, literal
and comment exclusions, IME composition, undo/redo, mode changes, read-only
state, disabled preferences, bilingual light/dark menus and a narrow viewport.
The deterministic contract and browser contract run in the quick gate and
release suites; the browser contract also belongs to the targeted history pack.
Settings persistence and the shared menu placement are covered by the existing
editing-preferences and settings-window contracts.

The browser contract also checks every catalog entry in both UI languages and
light/dark themes: fixed insertion templates, valid KaTeX examples, equal row
heights and preview containment. Existing arguments/closers do not change the
menu template. `bun scripts/test-math-completion-production.ts --capture-catalog`
saves actual production menu row screenshots for the full catalog, plus a
manifest, under `.local/test-artifacts/math-completion/catalog/`.

## HTML comment input

`scripts/test-html-comment-input-production.ts` runs in the quick, targeted history
and browser release gates. It uses the production editor to check comment commands,
slash completion, selection/caret continuity, configurable pairing, template exit,
undo/redo and native table cells. It also checks shell, C# and Power Query comment
rules, plus full-width and shifted-layout slash gestures in table cells with
default, cleared, reassigned and previously recorded Shift bindings; editor fallback
bindings must not bypass those preferences. IME preedit is never rewritten;
operating-system IME candidate handling still needs native verification.

## Window return focus and caret

`scripts/test-toolbar-input-viewport.ts` runs in the quick and release gates.
It checks input immediately after activation without waiting for focus, a trusted
click delivered in a later frame, late Host notifications, Alt release, composition,
passive controls, and nested table/rendered-block editors. Unknown activation may
briefly guard caret painting; input must remain ready and a click or input must
end that guard early. Duplicate return notifications must not extend it.

The Workbench-menu cases use nested Webview frames: a late Host notification
must leave the outside menu focused, and an actual return into the content frame
must retain the insertion position and first input. Activity-only WindowState
changes are covered by `scripts/test-panel-session-window-focus.ts`; they must
not be treated as window activation. A shell-only return is not a content-focus
signal. Native menu dismissal still requires separate Windows verification.

The Live and Source painting cases capture the browser's actual caret pixels,
using a distinct caret color and a visible-caret positive control. Disable blink on
the existing caret so a slow PNG cannot hide a regression in its off phase. Control
only newly scheduled application timeouts with a test clock advancing 0→34→68ms;
the 50ms activation grace must be canceled by the trusted click. Native rAF,
performance.now, selection, input and the compositor keep running. Real animation
frames settle each stage before its terminal screenshot; PNG transport consumes no
logical timeout budget. This proves logical timeout behavior, real rAF ordering and
actual painted pixels together, without claiming a 34ms wall-clock paint deadline.
A tiny marker outside both caret regions identifies each PNG's action epoch,
including late transported frames. Inspect every received frame: all focus/click
epochs must have no old caret, and every terminal click frame must have the new
caret. Missing baseline or terminal frames fail. The timeout lifecycle matrix covers
ordering, cancellation, native-handle delegation, renewal, errors and exact restore.
Stop/acknowledge the stream, restore timers and detach on success or failure, keeping
the primary error if cleanup also fails. Frame observations also cover the unfrozen
browser event path. These checks do not simulate Windows Alt+Tab or prove native
activation event delivery; foreground acceptance remains a separate check.

The same test observes the content-window keyboard forwarding boundary for the
Windows bare-left-Alt policy. Live/Source prose, table cell selections and code,
HTML, Mermaid and math inputs must keep focus and selection and accept immediate
input. Repeated Alt, window handoff, lost keyup, Alt+Shift+M, Host combinations,
AltGr/composition and read-only/outside controls are checked. These are browser
contracts with an explicit Windows platform fixture; real Windows menu, Alt+Tab
and input-method switching remain separate native acceptance checks.

## Preview pending code updates

`scripts/test-preview-code-update.ts` runs the production Preview controller with
only the external Shiki grammar loader held at deterministic boundaries. It
checks atomic source/color commits when two blocks finish separately, newer
revisions, removed blocks, hidden Preview, appearance and source-coloring
changes, and disposal. Token completions must not parse the whole document
again. A garbage-collection check ensures pending blocks do not retain the
parsed full-document tree. The existing production reading-surface, viewport
anchor and mode-transition tests cover the real Shiki/browser integration.
The pending-code test also checks that prose revisions retain the themed DOM
and selection of unchanged, structurally matched code while updating source
mappings. Same-text language changes and theme replacement must still recolor.
The pending-code test runs in the full browser suite.

`scripts/test-preview-code-copy.ts` runs the production Preview controller with
real clipboard reads and writes. It covers exact fenced and indented code,
Mermaid source and LaTeX expressions, including diagram redraws and fitted math,
selection, keyboard activation, successful and failed feedback, language/theme
changes and incremental rendering. It also checks that HTML, PDF and Word export
inputs contain no reading controls or tooltips, and generates PDF/Word smoke
artifacts. Run this focused check for Preview copy changes; it also belongs to
the full browser suite.

`scripts/test-indented-code-blocks-production.ts` checks Live/Source indentation
entry, Shift+Tab and Backspace exit, exact space/tab and container continuation,
empty-Enter exit, Shift+Enter blank code rows, literal multiline paste with
retained prefixes, internal empty-line exit and undo/redo. Explicitly indented
trailing blanks remain part of the editable code surface even though Markdown
excludes them from its syntax node. Ordinary and 9,000-line documents sample
the first painted input frame for caret, scroll and line-number stability.
Native caret checks inspect screenshot pixels inside structural prefixes, at
payload boundaries and beside the first-row toolbar, including real clicks.
The existing light/dark palette, wrapped layout, document gutter, selection and
copy checks remain part of the same contract and the targeted rendered gate.

## Editor startup and loading

The quick and release gates run `scripts/test-panel-session-ready-init.ts` and
`scripts/test-editor-startup-load.ts`. The first checks that concurrent Webview
`ready` messages share one `init`, a later `ready` can retry a lost delivery,
and Markdown uses LF even when the file uses CRLF. The second opens the
production Webview directly in Live, Source, and Preview, then waits for the
document text on the active surface. In Preview, the test also requires the
loading status to clear and the rendered document to exist. A selected mode
button alone does not prove a successful load. The startup check also reopens
all three modes with the actual Webview state written during initialization,
then with a manual mode choice that must override Host initialization. It covers
default/custom layout settings and verifies that initial settings do not save a
temporary default mode as a user preference. Source's optional side-by-side
preview is covered by
`scripts/test-source-side-preview.ts` in the production browser matrix.
`scripts/test-mode-roundtrip-reveal.ts` checks Live → Source → Preview → Live
with a viewport table whose row layout is deliberately delayed. The first
visible Live frame must already contain content and the table's final height;
this check runs in the quick, targeted table/viewport, and release gates.
`scripts/test-preview-transition.ts` tolerates a temporarily absent iframe body
while polling readiness. It establishes interactive Live readiness before the next
case; rapid Preview/Live cancellation still must restore interactivity within 150ms.
The slow-image reveal bound remains 260ms and measures the trusted click through
the actual visibility mutation in the browser, excluding automation transport.
`scripts/test-mode-transition-matrix.ts` checks both six-step mode cycles with
Source's split preview on and off. It covers paragraphs, tables, code blocks,
successful and failed Mermaid renders, images, math, HTML/quotes, and nested
lists in the viewport. Every painted frame must retain visible content, the
first revealed editor frames must keep their geometry, and the 95th-percentile
switch-to-ready time must stay
below 300 ms in the production browser harness. Run it for mode-transition
changes and as part of the targeted viewport and release browser suites.

`scripts/test-viewport-anchor-production.ts` also runs in the full browser suite.
It checks semantic reading-band position and proportional rendered-block progress
across modes, every visible transition frame, and Preview selection/focus through
late resources, external revisions, and disk reloads. Same-surface captures inside
paragraph whitespace must preserve the gap; cross-mode checks do not require
identical raw pixel offsets for differently sized rendered blocks.

The controller contracts check that late block layout preserves an in-flight
navigation target instead of replacing it with a nearby reading line, alongside
new navigation, input, disposal and read/write measurement boundaries.

`scripts/test-preview-loading-reuse.ts` holds the initial Preview iframe load after
its Host response. It verifies that activation reuses that presentation while
changed text, forced refresh, failed-response retry, and disposal retain their
behavior. It runs in the full browser suite; the quick startup test also requires
one Host render when opening directly in Preview, with the configured language
and font size already applied to the initial request. Force-failure retry is
checked both before and after the retained iframe becomes ready.

For final installed-VSIX acceptance, use an isolated VS Code profile and open
a Markdown file in each saved mode after both closing its tab and restarting
VS Code. Confirm that the content is readable and interactive without changing
modes. This native check complements the browser contract by exercising the
actual extension Host/Webview startup handshake.
Install the artifact with the official `code` CLI into the isolated extensions
folder. Loading extracted VSIX files through `--extensionDevelopmentPath` can
select development-only source styles that do not belong in the package. Run
cross-process persistence checks in a normal host: `--extensionTestsPath` uses
in-memory storage. The extension test host remains suitable for in-session
automatic-save, document synchronization, and cursor assertions.
Seed a saved mode with an actual mode change before quitting; selecting the
already active Live default does not create an explicit stored preference.

The full-document endurance runner keeps the curated operation set for its
original acceptance fixture. For other Markdown documents it discovers unique
edit targets by structure, samples up to eight per category across the document,
and mixes forward and shuffled traversal. Its report lists available/selected
targets and locations that could not be addressed safely. This is sampled editing
coverage; the subsequent production scroll-integrity pass traverses the document.
Duplicate text and unsupported shells are reported rather than counted as tested.
Custom fixture-specific phases still require their matching curated document.

`scripts/test-preview-code-highlight-layout.ts` exercises the production Preview
renderer and Shiki projection in Chromium at three widths and both appearances.
It checks source text, theme changes, viewport deferral, scrolling, resizing, and
full-document projection. CDP layout counts enforce bounded layout work during
projection without relying on machine-dependent elapsed-time thresholds. It runs
in the appearance pack, highlight suite, and full browser suite.

`scripts/test-source-lightweight-shiki-lifecycle.ts` checks shared highlighter
ownership and hidden-editor revisions through the production editor. Hidden
editors keep previously presented fences warm across source, language, and theme
changes and prepare at most one unseen block per document revision. Token refreshes
must not restart this preparation budget. Reveal must color the latest
visible content, and another visible editor must keep working independently.
Performance comparisons must include the first return to Live/Source and a single
large fence, with Preview source coloring both enabled and disabled. Include a
hidden editor measured after resizing, then external introduction of supported code,
both into plain text and after an already cached block. Reduced background work
must not conceal a new mode-switch delay.

`scripts/test-source-syntax-stability.ts` holds the real token runtime at its
asynchronous batch boundary. After successive edits, newly visible unchanged
Source text must retain its last completed colors and font styles. Edited text
must discard obsolete formatting, and the latest tokens must replace the retained
projection when ready. The bounded check belongs to the quick, appearance and
viewport packs and the release browser gate.

`scripts/test-shiki-highlighter-lifecycle.ts` also checks completed token reuse
between editor and Preview when language, exact source and all Shiki theme inputs
match and each highlighter has requested only that one language bundle. Mixed
language histories remain independent because lazy embeddings and injections can
change token output. Reuse still loads the recipient grammar. The surfaces retain
independent consumers, generations, cancellation and bounded caches. Tests cover both completion orders, differing inputs, pending
retirement, last-consumer release and replacement. `scripts/test-highlight.ts`
checks real token colors when the two surfaces match, diverge and match again,
and when only one surface has preloaded an embedded language.
Measure large-fence updates alongside first mode entry and retained heap; reuse
must not shift the work into a later mode transition.

`scripts/test-export-fence-highlight-reuse.ts` runs the bundled renderer in Node
and observes the real fallback highlighter. It checks reuse after prose changes,
code/language invalidation, custom-highlighter isolation, error retries, bounded
entry count and text payload, oversized-entry bypass, parent-document release,
and repeated sanitization.
It runs in the unit suite. Performance comparisons must separate first rendering
from later revisions and include both many small fences and a single oversized
fence; cache reuse does not promise faster cold starts or oversized highlights.

## Performance investigation

Start with a fixed revision and document, then measure cold startup separately
from settled interaction. Change one suspected source of work at a time. Keep
the document hash, viewport, font, runtime version, and profiling mode with the
results; CPU sampling changes timings and must not be mixed with unprofiled runs.

For repeatable built-Webview loading measurements after a production build:

```powershell
bun scripts/benchmark-mode-loading.ts --confirm-long-run --rounds 5 --label candidate
```

This uses the emitted ESM chunks and real Mermaid runtime, with a fresh browser
context and disabled HTTP cache for each Live, Source, and Preview startup.
Ordinary, many-line, rich-block, and prose-only Mermaid mention fixtures have
recorded hashes. Reports in
`.local/probes/mode-loading-*` include build hashes, browser/version/viewport,
navigation-to-ready-handshake, navigation-to-first-content-frame, and individual
mode transitions tagged by whether the destination has been visited. Use
`--fixture mention-only` to focus a follow-up sample. The Host render bridge
uses the real preview renderer; it does not model Extension Host activation, VS Code IPC, OS file-cache coldness, saved
reading-position restoration, or optional Source split preview. Rich-resource
completion is not the first-content metric. The run additionally checks that
Source does not request Mermaid code for documents without a diagram hint and
that rich fixtures eventually produce a real SVG after switching to Live.

Use `--preload-mermaid` only to reproduce the former broad word-match policy
for comparison; it is recorded in the report and is not the current production
policy. Compare matching fixtures, runtime, viewport, and sampling order without
concurrent tests. Report medians and sample ranges; a few repetitions do not
establish a reliable p95. Complement these Webview measurements with the native
probes below. This is a repeated performance campaign and requires explicit
long-run authorization.

For native saved-mode and process-restart coverage, build first and create a JSON
case with an absolute `document` path, `savedMode` and `expectedMode` (`live`, `source`, or
`preview`), plus boolean `optimization` and `restore` fields. For example:

```json
{"document":"C:/fixtures/ordinary.md","savedMode":"preview","expectedMode":"preview","optimization":false,"restore":true}
```

```powershell
pwsh -File scripts/benchmark-vscode-modes.ps1 -CaseFile <case.json> -CodePath <Code.exe> -ConfirmLongRun
```

The probe seeds the saved mode and reading position through the real UI, quits,
then restarts the same isolated profile. It checks initial mode, a same-process
reopen, and all six directed mode transitions with Source split preview disabled
and enabled. The large-document policy can override a saved mode with Source;
encode that expectation explicitly rather than counting it as a Live/Preview
startup. Split preview is intentionally session-only. When `restore` is false,
the seed still saves a non-top position before the measuring process disables
restoration. Non-scrollable documents are explicitly excluded from restoration
coverage; scrollable documents must produce both a non-top DOM position and a
non-top persisted position.

This uses a small companion development extension, because VS Code's extension
test runner uses in-memory storage and cannot prove cross-process persistence.
Each phase is bounded to 180 seconds. Reports retain seed and measurement results,
built entry/runtime hashes, document/driver hashes, runtime, viewport, font and
focus state. Failure reports and isolated seed storage snapshots remain available
for diagnosis. The seed waits five seconds outside measured intervals and Bun
checks scroll geometry and the copied SQLite state before measuring restore.
Seeding uses trusted wheel input. Restored position must still be away from the
top in the settled snapshot. Each Source transition also asserts the actual split
state, and fresh Webviews must start with split disabled.
Missing persisted state fails the setup instead of being counted as a restore
test. Source documents are never edited.

`launchToHarnessMs` and `launchToReadyMs` include VS Code and automation overhead;
`openToReadyMs` starts at `openWith`. Extension activation may have begun earlier
and its state at harness entry is recorded. OS file caches are not cleared. DOM
polling is not exact first-paint measurement, and content readiness does not mean
all diagrams/images have finished. `readingPositionReadyMs` only detects a move
away from the top for a previously scrolled document; exact semantic fidelity is
asserted separately by the production reading-position browser tests. Do not
infer whole-application speedups, foreground latency, installed-VSIX acceptance,
or reliable percentiles from one development-window sample. The launcher requests
Hidden, but Electron may show its own window; use the recorded focus/visibility
state rather than assuming it stayed hidden.

For a short, read-only native Windows startup/scroll probe after building:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This opens an isolated hidden development window, measures immediate and settled
wheel scrolling, and stores JSON in `.local/probes/startup-*`. `openToEditorMs`
starts at the open command, after VS Code itself has started. Add `-Profile`
only to investigate CPU stacks. It never edits the input document. The timings
are comparative evidence, not hardware-independent pass/fail limits. This probe
uses a hidden window whose scheduling may differ from foreground use. It
does not measure native input latency or prove pixel-level scroll integrity;
use the existing input/viewport contracts for those checks.

For user-visible acceptance, obtain permission to occupy the foreground and add
`-Visible`. Compare only samples whose `foreground` values are true and whose
recorded viewport/font settings match. `-ExtensionPath` selects an independently
built baseline checkout. A single pair is indicative, not a stable improvement
percentage; repeated performance/endurance campaigns still require long-run
authorization. Do not run other tests alongside timing samples.

For a short read-only mode-transition and image-decoding probe:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario reading -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path> -ImageLine <one-based-source-line>
```

This visits Preview, Source, Live, Source, Preview, and Live once, and records the
document and build hashes in `.local/probes/reading-*`. `readyMs` ends when the
destination surface is ready and the transition cover is gone; it includes
automation overhead and does not wait for every image or diagram. `-ImageLine`
optionally selects the first image whose mapped source line matches, aligns its
source block with the top after a trusted interaction, and checks real decoding
separately from the placeholder. The image report records its bounds and visibility after decoding;
decoding success alone does not prove that late layout kept it in the viewport.
`-Profile` samples each transition separately and marks the run as profiled.
`-Trace` instead captures `reading.trace.json` from before `openWith` through all
six transitions, including CPU samples from newly created webview renderers. User Timing marks
identify editor detection and each transition's automation start/ready bounds.
The trace excludes VS Code process startup and Extension Host CPU stacks;
editor detection can lag actual mounting. Use it to attribute renderer work,
not as an exact first-paint measurement. Group trace CPU profiles by process and
profile ID before aggregating samples; a renderer can also have worker profiles.
The trace cannot be combined with the separate per-transition `-Profile` mode;
collect uninstrumented timings separately.
These single samples are diagnostic, not percentiles or endurance acceptance.
The same hidden-window, foreground-permission, and no-concurrent-test rules apply.

For a short native input/save baseline on a disposable copy of a rich document:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario interaction -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This adds known edit targets to a copy inside the isolated workspace and measures
one prose, table, and Mermaid input/save action, followed by one delayed auto-save.
It checks the expected contents against both Host and disk and verifies the original
file is unchanged. The report remains under `.local/probes/interaction-*`. Input
latency ends after two animation frames following the native input event; this is
a scheduling proxy, not a physical display measurement. Save latency includes
the native save command and disk verification; auto-save includes the configured
one-second delay. Hidden windows remain diagnostic even if DOM focus is true.
`-Visible` requires foreground authorization, and `-Profile` is unavailable for
this scenario. A single sample per action establishes a baseline, not percentiles.

Add `-ColdInput` to observe the editor while `openWith` is still pending and
issue one trusted input at its default first-line-end caret immediately after
detection and focus, without the normal settling sleep or changing selection.
Direct DOM selection changes can race the editor's initial selection sync and
must not be used for this cold probe. It then scrolls once, switches Source →
Preview → Live, and performs the usual input/save checks, including that first
edit in the expected contents. Reports separate detection-to-command,
setup-to-input-event, input-to-two-frames, and command-to-result times.
Cold input also reports `inputToFirstFrameMs` and `betweenFramesMs`, whose sum
is `inputToPaintMs`. The split distinguishes waiting for the first frame callback
from subsequent work; neither callback proves that pixels reached the display.
Detection-to-command and setup-to-input-event include automation/setup overhead; editor detection can
lag mounting; this is not a measurement from the physical key press. Collecting
the result can wait behind later renderer tasks even when the two frames have
already occurred, so command-to-result must not be treated as input latency. The scroll
and switches follow that first input, so they do not represent independently
cold launches. This option is limited to `interaction` and remains a short
diagnostic, not an endurance run or a pixel-level scroll assertion.

Combine `-ColdInput -Trace` to write `interaction.trace.json` with CPU samples
and `meo-cold-setup`, `meo-cold-input`, `meo-cold-frame1`, and `meo-cold-frame2`
marks. Use this to attribute work between input and frames; tracing affects
timings, so collect untraced samples separately. This combination cannot use
`-Profile`.

For one bounded native hide/return/close resource sample:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario lifecycle -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This opens the read-only rich document and one disposable plain control editor
in the same tab group, returns to the rich document, then closes its tab. It
records Host tab activity separately from Webview visibility, diagnostic timer
progress, buffered long tasks, runtime availability, and CDP heap/DOM counters.
Different Webview targets may share an isolate: heap samples are deduplicated
by isolate ID and must not be added once per target. These are not native/GPU
memory totals or leak evidence. No forced GC is performed; closing a tab checks
frame detachment, not immediate return of memory to the OS. The probe does not
exercise multiple rich documents or repeated open/close cycles.

`richOpenToEditorMs` and `controlOpenToEditorMs` end at automated editor detection;
`returnCommandMs` ends at the Host command completing, not at first paint.
The counters and timers themselves add overhead. Reports include document/build
hashes and environment information under `.local/probes/lifecycle-*`. The same
hidden-window and foreground-permission rules apply; Profile/Trace are rejected.
Use the reading trace separately for startup attribution, and collect timing
samples without concurrent tests. Repeated resource campaigns remain long runs.

After explicit authorization for a repeated resource investigation, use:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario lifecycle -ResourceCampaign -ConfirmLongRun -Document <absolute-markdown-path> -ImagePath <absolute-local-image-path> -CodePath <absolute-Code.exe-path>
```

This bounded campaign runs eight rounds with three generated rich documents
(small SVG images, twelve flowcharts, and the supplied large image) plus a
retained plain control, at most four editors at once. All assets are local
copies in the isolated workspace. The supplied Markdown is hashed for provenance
and checked unchanged; the campaign renders generated fixtures, not that entire
document. It waits for real Preview SVG/image completion, records return command
latency, observes five seconds hidden and five seconds after closing each round,
and writes incremental `progress.json` alongside the final report. Input/save,
foreground paint latency, and full-document scroll integrity are not covered.

Windows process private bytes and working sets are sampled only for process IDs
reported by the isolated browser. Shared working sets must not be summed as unique
memory; heap samples remain deduplicated by isolate. A final forced-GC diagnostic
is labeled separately, after every normal round and timing measurement has ended.
It helps distinguish retained objects from delayed collection, but cannot prove
the absence of native/GPU leaks. Reserve about 10–15 minutes and do not run other
tests concurrently. This authorization does not imply a release or VM run.

To isolate one diagram using the real runtime and production editor:

```shell
bun scripts/benchmark-mermaid-render.ts
bun scripts/benchmark-mermaid-render.ts <markdown-path> <opening-fence-line>
```

The default fixture has 40 edges. The optional document is read-only; only the
selected fenced Mermaid source is rendered. Reports record its hash, viewport,
cold render duration, long tasks, and whether Split reuses the cached SVG.
Initial editor work and individual diagram computation should be distinguished:
yielding can separate tasks without reducing total render time. Neither probe is
part of the quick gate or a substitute for authorized repeated/endurance checks.

For a narrow ordinary-document input, scroll, resource, and Live/Source baseline:

```shell
bun scripts/benchmark-large-document-production.ts --fixture ordinary
```

Keep the default full fixture matrix and endurance behind the existing long-run
authorization. Select additional scenarios from the actual changes: startup,
input, rendering, mode transitions, or native save scheduling. Optimize measured
bottlenecks and recheck adjacent behavior so work is not merely moved to the
next interaction. Preserve deterministic regression tests for excess work or
incorrect scheduling; do not turn noisy millisecond samples into CI assertions.

## Auto-save verification

Auto-save concurrency is part of `bun run test:quick`. The focused save checks are:

```shell
bun scripts/test-document-auto-save-concurrency.ts
bun scripts/test-document-save-flush-webview-adapter.ts
bun scripts/test-vscode-document-save-lifecycle-adapter.ts
bun scripts/test-panel-session-native-save-flush.ts
bun scripts/test-native-save-table-flush.ts
```

For native VS Code acceptance, use an isolated development profile and disposable
Markdown files. Check `files.autoSave` with `afterDelay` (1000 ms),
`onFocusChange` (switch to another editor), and `onWindowChange` (leave the VS Code
window). Verify Live and Source input, a table cell without leaving the cell,
continued input during save, and reopening the saved file. Compare disk contents
with the editor and verify focus/history are preserved; a simulated save event
alone does not validate the platform's focus or auto-save scheduling.

The transient-input browser check also covers input arriving during snapshot
collection, Live/Source IME confirmation and cancellation, table-cell IME after
pending ordinary input, and Mermaid/math embedded input. During composition,
saving must preserve the candidate and save only confirmed text; after confirmation,
the final characters must reach disk. Include a short delay (100 ms), switching
auto-save off and back on, manual save, and a clean external file update in native
acceptance. Keep failure checks for rejected applies, mismatched text, timeout,
and closing the editor: a warning must not be suppressed when input is unconfirmed.

## Targeted packs

```shell
bun run test:targeted -- history
bun run test:targeted -- table
bun run test:targeted -- rendered
bun run test:targeted -- appearance
bun run test:targeted -- search
bun run test:targeted -- viewport
bun run test:targeted -- changes
```

Choose only areas affected by the change. Several areas may be run one after
another for a cross-cutting fix; the workflow never escalates itself to the
full suite.

For a sampled real-document UAT, use:

```shell
bun run test:targeted -- uat path/to/document.md
```

The sample performs eight representative edits with undo/redo, then checks the
real Webview shell during first-pass outline navigation and bidirectional
scrolling. It treats every soft viewport finding as a failure. This is the
regular substitute for the full document sweep, not a release claim.

## Long-running gates

After explicit authorization, the release entry runs type checking,
architecture checks, every sub-suite from the repository's unchanged full
`bun run test` pipeline, a production build, and package-content validation:

```shell
bun run test:release -- --confirm-long-run
```

The production build runs first, so tests that consume generated assets cannot
accidentally use an old checkout's output. Build failure blocks dependent tests.
Independent static and domain suites retain bounded concurrency. High-risk
browser contracts run before the complete serial production browser matrix;
package validation finishes the base gate. Workflow contracts
verify both that every sub-suite from `bun run test` appears exactly once in
the release plan and that every non-UAT targeted contract is transitively
included in the full suite, so scheduling changes cannot silently remove
coverage. Each runnable test also has a resource classification in
`scripts/test-inventory.json`: `process` permits bounded concurrency for isolated
process-only work; `exclusive` runs without any other command in this workflow.
Browser, real frame/pixel/timing, desktop focus, clipboard and native input checks
use `exclusive`. Unknown commands default to exclusive execution. A queued
exclusive test cannot be starved by later process checks. Other terminal sessions
are outside this lease: do not launch competing browser, native or stress jobs.

The workflow expands test aliases into individual script executions, preserving
their arguments, environment and within-group order. Within one release invocation,
identical script/argument/environment combinations share their first execution;
every logical occurrence still has a result and an evidence reference. A failed
first execution remains failed for all its occurrences, without retry. Distinct
arguments or environments execute separately. Independently invoked packs remain
self-contained; the documented alias overlaps do not require redundant execution.
It does not add browser
workers, remove cases, change thresholds or retry tests. During release, a test
failure does not short-circuit the remaining independent scripts or stages:
collect their results in the same run, then report a failing gate. Infrastructure
errors that prevent safe execution stop the run. Short repair and endurance
workflows retain stage failure boundaries. Direct `bun run test` retains its
existing shell behavior; use the guarded workflow for release evidence.

When the acceptance scope includes full-document supplements, use one entry:

```shell
bun run test:release -- path/to/disposable-document.md --confirm-long-run
```

The plan first completes every base release check, including package validation,
then runs the unchanged complete font sweep and all endurance contracts. The final
input/artifact check still covers the whole combined run. Document bytes
join the before/after input fingerprint even when the fixture is ignored or outside
the repository. A failed base census blocks supplements; a failed supplement blocks
its downstream stages. The overlapping endurance preflight references the same
candidate's earlier results. Omitting the document intentionally selects only the
base gate, so it must not be reported as full-document or native acceptance.

Each invocation owns a fresh `.local/test-runs/<run-id>/` directory. `report.json`
records per-script commands, status, elapsed time and separate stdout/stderr logs;
it is checkpointed after each result. Stage times measure actual wall time,
including scheduling, rather than the maximum single-command duration. The
console lists the ten slowest executed commands. Reused results are labelled
separately and point back to the original evidence. Never infer completion from
the latest console line: require the final report's passed status and complete
coverage. Keep the report and all referenced logs together.

Total time starts before inventory and fingerprints. Reports include preparation,
final verification and individual fingerprint section times, physical file/byte
counts and shared dependency nodes. Resource wait is included in command wall time.
Input hashing reads actual bytes and retains file boundaries, directory membership
and link targets; physical nodes are shared only within a single snapshot. The
final snapshot reads them again. Never replace installed-content checks with only
lockfile or modification-time checks. Architecture fixture checks call the same
rules with fresh per-fixture state, retaining CLI and staged-index coverage.

### Adding or changing tests

Agents complete this procedure whenever they add, move or change a test or its
workflow registration, without waiting for the user to request it:

1. State the behavior that needs protection and select the smallest existing
   suite that owns it. Prefer a focused contract; use a browser, native host or
   endurance scenario when that environment is needed to expose the failure.
2. Put runnable tests under `scripts/` using `test-*.ts`, `.tsx`, `.js`, `.mjs`,
   `.cjs` or `.ps1`. Connect routine regressions to the appropriate release suite.
   Imported helpers belong to their reachable caller; browser `test-*-entry.ts`
   fixtures must be explicitly referenced by a reachable owner. A filename alone
   is not registration. Keep nonliteral fixture construction explicitly registered
   or change it to an auditable reference.
3. For supplementary targeted, native or endurance checks, add an exact entry in
   `scripts/test-inventory.json` with the classification, invocation and reason
   for separate execution. Preserve existing release coverage. An exception is
   a reviewable testing decision, not a way to waive a failing regression. The
   initial supplementary entries record existing practice; they do not claim
   those checks have passed or that their behavior is covered by another test.
   Register every runnable script exactly once under `resources.process` or
   `resources.exclusive`, including separately run checks. Helpers inherit their
   runnable owner's placement. Choose exclusive whenever isolation is uncertain;
   a script name or a fast local run is not evidence that parallel execution is safe.
   The inventory rejects missing/stale/duplicate resource declarations and known
   browser/desktop dependencies in process-only tests, including shared helpers.
   This static guard is conservative and does not replace reviewing dynamic
   subprocesses, shared output paths and external state.
4. Run `bun run test:inventory`, then the smallest relevant behavioral tests.
   The inventory check discovers nonignored untracked files too. It verifies
   reachable tests, helpers, separate-test registrations and every `test:` alias.
   Same runtime, arguments and environment count as the same invocation. Exact
   intentional repeat counts need a reason; stale registrations also fail. The
   existing repeat allowances describe overlapping suite ownership; a guarded
   release records each occurrence while executing the identical invocation once.
5. In the change summary, identify the added/changed tests, their suite or
   separate classification, the behavior protected, why costly execution is
   necessary, and measured time when available. Use the next natural run's timing
   report when no representative timing exists; do not start a long acceptance
   run merely to fill this field. Timing informs optimization and never skips a
   required test automatically.

New tests join the smallest owning suite. Quick membership needs a distinct daily
regression benefit; do not add every browser matrix to quick or repeat it in an
endurance preflight by habit. Keep actual input/frame observation and negative
controls when optimizing a costly test. Separate environments or fewer samples
require an explicit coverage argument; runtime targets never waive checks.

CI runs inventory validation and its small contract tests before typechecking
and building. Every guarded workflow checks registration before launching work,
including dry runs. Architecture checking also invokes inventory validation;
`bun run architecture:check:staged` reads the package scripts, workflow policy,
test files and registrations from the Git index. The existing main-checkout
pre-commit hook therefore rejects a staged omission even if the working copy
contains an unstaged fix. Other checkouts must run that staged command as part
of their commit checks; CI provides the repository-wide fallback.

This check reads source and constructs plans; it never runs the product tests,
opens a browser or starts VS Code. It cannot assess assertion quality, semantic
overlap or whether a separate-test reason is justified; review must assess those
decisions. It does not enforce Git hosting branch protection settings.

### Conservative release resume

An interrupted or previously successful run can be resumed only after verifying
that OS motion/theme preferences, installed fonts, display and other external
conditions are unchanged, and no abandoned test/browser processes remain.
A hash cannot establish those host conditions; when
they are unknown, start a fresh run. The executing agent performs this check;
the user does not need to manage test IDs or hash inventories.

```shell
bun run test:release -- --confirm-long-run --resume=<previous-report.json> --same-environment
```

Resume additionally requires matching commit/index identity, source/test/config files, installed
dependency contents, Bun/Node/browser executables, process environment, host
identity and the expanded plan. Changed inputs, missing/changed evidence,
an apparently live previous runner, and any recorded failure reject resume.
The original report is never overwritten. Build and package checks execute
again; a different built artifact invalidates reuse and reruns the test cases.
Incomplete scripts restart from their beginning, never from the middle of a
stateful scenario. Inputs and built outputs are checked again before success.
This does not import historical ad-hoc logs. A standalone font sweep is not
resumable; in the combined plan only an entirely completed font script can be
reused, never a partial mode/position sequence. Changing the selected document
invalidates the combined plan's evidence.

This first implementation deliberately does not infer which tests are unaffected
by a code or test change. Fixing a known failure requires a fresh gate, but the
preceding release census should already have exposed its independent siblings.
Do not restore an earlier checkpoint to conceal a later failure. Do not use
resume as an automatic flaky-test retry or as evidence from a different OS.

For future speed improvements, first use the recorded per-script times to split
isolated functional checks across independent machines. Timing, focus and pixel
checks need exclusive resources. A changed-file heuristic is only an early
feedback tool and must not replace complete release coverage. These boundaries
follow the [Playwright CI guidance](https://playwright.dev/docs/ci) and
[sharding guidance](https://playwright.dev/docs/test-sharding); the current
implementation keeps the existing Bun/Puppeteer tests.

The existing `bun run test` command remains the complete test pipeline for CI
compatibility. Agents and local repair work use the guarded release entry when
requesting that pipeline as part of a full gate.

The simplified large-document entry is a shorter stress test, currently about
one minute on a steady local machine and budgeted at about 1–3 minutes:

```shell
bun run test:large-document -- <document> --confirm-long-run
```

It runs the production large-document benchmark, an eight-edit strict
full-document UAT, and the production live-scroll integrity check in that order.
All three commands run serially so their performance measurements do not
contaminate one another. Despite the shorter duration, this remains a stress
test: an agent must wait for explicit user authorization in the current task
before running it. Omitting `--confirm-long-run` is rejected; `--dry-run` may be
used without authorization to inspect the exact plan.

The full-document endurance entry first runs save concurrency, transient-input
flush (including IME), and recent rendered-block, search,
reload, table interaction, change-review, diff-gutter, and code-block line-number
regressions. It then preserves the original high-intensity UAT and finishes with
production live-scroll integrity against the same document:

```shell
bun run test:endurance -- path/to/document.md --confirm-long-run
```

Use the recommendation and authorization policy above before either long run.

## Release candidate evidence

Before a release, compare the last published tag with the candidate commit.
Map every user-visible change to a relevant contract or native acceptance result,
and write release notes from that inventory. Do not describe an unconfirmed report
as fixed. Record the candidate commit, clean working-tree state, runtime versions,
commands, exit codes, log locations, and final VSIX size and SHA-256.

After packaging, run `bun scripts/test-vsix-contents.ts <artifact.vsix>` against
the final archive. This verifies CRCs, release manifest identity, file inventory,
licenses, and every UTF-8 text file (including VSIX metadata) for private build
paths and credentials. `bun run package:check` also checks prospective package
contents and relocated Puppeteer/QuickJS/WASM operation in Node without development
dependencies. Publish the same final file to every release channel; rebuilding
after acceptance requires repeating the artifact checks.

When font-size or viewport behavior changes, supplement the release gate with
`bun scripts/test-font-size-full-document.ts --document=<absolute-markdown-path>
--confirm-long-run` on a representative rich document. The runner checks every
sampled position in Live, Source, split Source/Preview, and Preview through five
size increases and decreases. Record the fixture hash and anomaly count. Near
the document end, either increasing or decreasing font size can exhaust the
available scroll range. Count a frame as bottom-constrained only when preserving
the same source anchor would require scrolling beyond the measured maximum and
the actual scroll is already at that boundary. Report those frames separately;
any remaining displacement over 12 px is a failure. Track table rows by their
captured source identity, excluding duplicated sticky-header rows, since a
previous DOM node can be reused for a different table.

After focused fixes and review have converged, run the complete release gate before endurance. Keep browser performance and
native endurance runs serial to avoid resource contention. Diagnose failures with
the smallest reproducer and use the per-script census to inspect the full result,
then run the required formal gate on the corrected candidate. For unchanged
interrupted runs, use conservative resume above. Do not retry failures until one passes
or lower endurance limits to obtain release evidence. A short runner preflight
is useful during setup, but must be reported separately from the full run.

Adaptive endurance loads production KaTeX styles and fonts and locates table
cells by their source-mapped row, including quoted tables. Unsupported quoted
formula shells are reported rather than edited through the outer editor. For
rendered blocks taller than the viewport, visible history checks the edited source
line. A document-end scroll clamp is counted separately only when the target line's
removed height accounts for the entire scroll-limit change without oscillation.

The full-document editing UAT loads the packaged Mermaid runtime and verifies
its render entry before creating the editor. Missing renderer dependencies are
fixture failures; an error fallback must not stand in for normal rich-document
rendering. Keep all original input, history and painted-frame assertions.

The full-document endurance runner exercises editor history and viewport
stability; it does **not** exercise VS Code's auto-save scheduler or real disk
persistence. When save behavior changes, supplement it with native acceptance.
The reusable `scripts/test-vscode-auto-save-endurance.cjs` runner is loaded through
VS Code's `--extensionTestsPath`, alongside `--extensionDevelopmentPath=<repo>`.
Launch it in a dedicated disposable workspace with separate `--user-data-dir`
and `--extensions-dir`, and `--remote-debugging-port=9337`. It requires:

- `MEO_CONFIRM_LONG_RUN=1`, only after explicit authorization.
- `MEO_NATIVE_ENDURANCE_WORKSPACE`: the absolute path of that disposable workspace.
- `MEO_NATIVE_ENDURANCE_ROUNDS`: defaults to 60 (1–120); use three rounds only
  for setup verification, then the default for candidate acceptance.
- `MEO_NATIVE_BROWSER_URL`: defaults to `http://127.0.0.1:9337`.

The native runner creates its own Markdown fixture, uses `afterDelay` at 1000 ms,
and keeps one document session alive across Source input, Live table editing,
undo/redo, and Preview transitions. It waits for actual platform save events and
compares exact expected text with TextDocument and disk, checks cell focus, then
reopens the file. It never calls `document.save()` to simulate auto-save. Results
are written to `auto-save-endurance-result.json` in the disposable workspace.
Budget approximately 3–6 minutes in addition to full-document endurance. This
complements, rather than replaces, the native focus-change/window-change and IME
acceptance described above. Do not use an actual user workspace or edit a user's
original document for this runner.

## Manual F5 acceptance

For Preview host-shortcut changes, run the short native check after building:
`./scripts/test-vscode-preview-shortcuts.ps1 -CodePath <absolute-Code.exe-path>`.
It starts a hidden VS Code extension test instance with its own disposable user
profile, workspace and extensions directory. Real keyboard input must open the
workbench command palette, Quick Open and a two-stroke binding from full and
split Preview, with Live as a binding baseline. The runner writes `result.json`
and a command-palette screenshot under `.local/probes/preview-shortcuts-*`.
This supplements the production browser checks; it never edits user keybindings
or invokes the command under test through `executeCommand`.

Manual acceptance should also be risk-based. Test the changed surface first,
then do a short transition check around it: Live/Source/Preview mode switching,
typing and undo/redo, cursor visibility and scroll stability. Add Mermaid/math,
tables, themes, or export only when the change can affect them. Reserve the
complete top-to-bottom document walkthrough for an explicitly scheduled
release acceptance session.

## Settings, typing assistance and shortcuts

The quick and release gates include `test-editing-preferences.ts`,
`test-editor-services.ts`, `test-link-candidates.ts`, `test-input-assistance-production.ts`,
`test-editing-features-production.ts`, `test-link-candidates-production.ts`, `test-slash-commands-production.ts` and
`test-settings-window-production.ts`.
The table/history packs exercise the new editing paths; the appearance pack
includes the actual settings and toolbar menus. Browser tests use the production
editor and full Webview bootstrap. They assert resulting documents, undo results,
actual remapped gestures, persisted projections, focus and DOM disposal.
Link candidate checks cover owning-workspace and remote root paths, directory chaining,
segment/fragment/title preservation, vault-scoped fuzzy/multiword ranking before the
limit, background aliases/titles and invalidation, shortest unambiguous Wiki targets,
native table alias escaping, slash ownership even when suggestions are disabled, and
selected clipped text without pointer hover. Path menus use one line and do not repeat
the path; default-size width is 248px, larger fonts stop at 300px, selection and
directory chaining retain width, and narrow viewports constrain the menu. Wiki
document results retain the wider two-line layout at 320px for the default size.
Candidate widths are fixed by family and UI language, with font scaling and viewport
constraints. Each menu family uses a uniform row structure: HTML omits type labels,
all headings show anchors, and all slash commands retain descriptions. Math catalog checks
assert that complete templates fit beside the rendered example. Focused visual smoke
covers every family in Chinese/English, light/dark, large fonts and narrow windows.
Browser checks include Source/Live,
Chinese/light and English/dark, all candidate families, narrow menus, focus,
Escape followed by metadata refresh and owner disposal. Quoted-directory IME checks
retain literal directory prefixes and raw preedit spans while filtering separators
only in the current segment. Pointer-return checks resume an existing directory in
Source/Live and native table editing after dismissal and external focus.
Existing tooltip checks retain
the ordinary hover delay and continuous-hover handoff contracts.
Window-return checks in `scripts/test-input-focus-return-production.ts` cover
offscreen native table cells and Live/Source document carets above and below the
reading viewport. They sample every animation frame through window activation,
late native element focus and duplicate Host recovery, preserving collapsed and
backward selections. New wheel gestures, document clicks and the first typed
character supersede the activation guard; typing still reveals the caret.
These browser checks model native activation ordering; an actual desktop click
outside and back into VS Code remains a separate native acceptance boundary.
The contract belongs to the quick, search and release suites.

Settings-return checks cover the close button, backdrop and Escape in Live/Source,
scrolled documents, native table cells, and Mermaid/math Source/Split editors.
They require preserved caret/selection direction and the first typed character
to reach the original document without another click. Segmented controls keep
constant pill dimensions and radius during motion, respect reduced motion, and
automatic font sizing disables the whole stepper. Toolbar checks cover localized
HTML-comment labels and consistent indicator insets.
Animation checks explicitly emulate both motion preferences so desktop accessibility
settings cannot disable the ordinary-motion branch of the fixture.
Table delete-confirmation checks wait for actual rendered width progress before
asserting expansion. A fixed JavaScript delay does not establish that Chromium's
animation timeline advanced; keep the bounded progress wait and the behavioral
assertion, together with timeout cancellation, paging, deletion and history checks.
Popup scroll-following checks use a real wheel gesture and verify its actual scroll
distance before comparing menu coordinates; direct scroll assignment is not user input.
`test-live-command-presentation.ts` exercises the shipped Webview and Markdown Worker
for all table commands and prose/table color popups in small and large documents.
It observes held pointers and compositor frames, retains unrelated DOM and formatting,
and checks cell focus returns and long-table deletion's visible document caret.
The long-table setup uses an assigned starting viewport; the toolbar actions are
native pointer input, and delayed settlement is observed through 80 frames.
`test-table-provenance-history.ts` checks inverse effect coordinates against
the restored document with the real input extenders, including combined pending
cell edits, row insertion/deletion and repeated undo/redo.
Sticky-header occlusion fixtures wait for an edited tall row to shrink before using
its bounds to position the row behind the header.
Column-width fixtures settle the current presentation before a trusted wheel
gesture, then verify the main header is above the viewport and Sticky is visible.
Use the same setup after font/mode restoration and in rich tables; preserve native
cell focus where the scenario requires it. Sticky column resizing must retain the
reading position after pointer release, without revealing the document caret.
The selection-toolbar switch is checked through real Source/Live drag selections,
native cell selections, immediate updates, failed writes, stale snapshots and
reopened documents, while formatting shortcuts remain usable.
Symbol surrounding uses an explicit native Markdown fixture, independent of
the production pair map. It covers all 11 native pairs plus Chinese extensions,
repeated markers, forward/reverse/multiline/code-context selections, all-or-none
multiple selections, quote/ASCII-whitespace/escape-prefix exceptions, cell-save
projection and undo/redo. Surrounding-only markers are separately checked against
empty-cursor auto-close, overtype and paired Backspace.
Slash commands cover Source, Live and native cells: direct/no-space triggers,
English aliases, context exclusions, every command template, field traversal,
IME filtering without consuming candidate keys, cancellation and committed Chinese,
settings updates, disposal and undo/redo. Visible-frame checks keep the popup open
through filtering and native-cell automatic commits; pointer-held candidates retain
their identity, and mouse-selected formats and template fields remain editable.
The table checks cover all 1–10 row/column combinations, larger explicit sizes,
shared total-cell capacity boundaries (including the header), default dimensions,
invalid parameters, preserved selections, paragraph boundaries and list/quote nesting.
The full Webview checks verify actual shortcut priority and Chinese/English,
light/dark popup surfaces, localized descriptions and inherited editor fonts.
Slash positioning checks cover document scrolling, stable slash anchors, above/below
flips, whole-row viewport limits (including fractional font heights), first/last
command visibility through viewport shrinking, stable keyboard-selection DOM and
minimal list scrolling, preserved internal scroll during repositioning, list-only
scrolling, dismissal without reopening,
native table clipping and textarea scrolling. Pinyin separators are exercised in
Source, Live and native-cell preedit, including complete raw-query replacement.
CDP composition validates preedit/commit boundaries without proving a specific
Windows IME. Clipboard events and the mocked VS Code clipboard validate payloads
and ownership, without proving native Excel/OS permission or installed-VSIX behavior.
