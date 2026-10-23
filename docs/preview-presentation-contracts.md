# Preview presentation contracts

This document records the invariants that keep Source-side Preview stable. They
apply to both the split Preview and the standalone Preview surface because both
use the same presentation controller.

## Source-to-Preview geometry

- Source lookup and visual lookup are different indexes. Source navigation is
  ordered by source range; Preview capture is ordered by rendered geometry.
- Continuous linked scrolling uses only the longest monotonic in-flow path.
  Semantic blocks that render elsewhere, such as footnote definitions at the
  end of the document, remain available for explicit navigation but must not
  flatten or reverse the main reading-flow projection.
- Nested mappings may describe both a container and its descendants. They are
  input evidence, not independent scroll owners. The cached projection resolves
  them before the scroll hot path; a scroll frame performs no DOM scan.
- Exactly one surface owns a scroll gesture. A follower write must not claim
  ownership or echo a new projection back to the driver.
- Mode transitions carry a continuous position inside the most specific rendered
  source range, not only an integer source line. The destination is measured at
  its final width before that position is projected.
- When a split Preview is already visible and becomes the standalone Preview,
  it remains the transition anchor owner. The final-width layout reprojects that
  same Preview reading point instead of recapturing an approximate Source line.

VS Code's Markdown Preview follows the same broad model: it caches mapped
elements by document version, ignores duplicate list and `pre` containers,
special-cases fenced-code ranges, and filters elements that are not visibly
rendered. See the official
[`scroll-sync.ts`](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/preview-src/scroll-sync.ts).
Its 2026 scroll-sync regression also documents why a reverse-sync guard must
remain active for the whole gesture instead of being cleared by the first
echoed event: [microsoft/vscode#307762](https://github.com/microsoft/vscode/issues/307762).

## Split-pane interaction policy

The viewport controller owns cross-pane navigation. Preview owns the geometry
of its accepted reading revision; its render completion is not a new user intent.

| Action | Synchronized panes | Independent panes |
| --- | --- | --- |
| Click Source text | Reveal the corresponding block only if outside Preview; a visible block stays put. Wait for the current revision and a mounted reading block. | Update the locator without moving Preview. |
| Scroll after a click reveal or input hold | Continue from the pair currently being read. Neither the first delta, a reversal, nor switching the driving pane may first restore the old top alignment. A new click replaces this origin. | Each pane keeps its own position. |
| Type, compose, paste, delete, undo/redo, or accept an external edit | Preserve Preview's reading witness. Source caret auto-reveal and native height-map anchoring do not drive Preview. | Preserve Preview's reading witness. |
| Stop typing / finish delayed rendering | Commit content and layout while retaining that witness; do not realign to the caret or replay an old scroll. | Same. |
| Wheel, touch scroll, drag a thumb, or navigate with arrows/Page/Home/End | The surface receiving the gesture drives. Follower scroll events never take ownership. Keyboard selection changes without viewport movement do not scroll the other pane. | Each pane moves independently. |
| Explicit Find, outline, or line navigation | A measured Source navigation releases the input hold and follows its actual viewport. | Navigate only the requested surface. |
| Turn synchronization off/on | Off cancels queued navigation. On aligns from the last interacted reading surface, retaining the Source selection. | Manual alignment arrows move only the follower once and retain focus/selection. |
| Zoom wheel or zero-delta wheel | Neither is a vertical reading gesture and neither releases an input hold. | Same. |

A gesture while Preview still represents an older Source revision waits for
matching coordinates. Only its latest position is applied; another edit, a new
owner, a newer click, hiding the pane, or disabling synchronization retires stale
destinations. A queued Source click is applied **after** the presentation's
reading-position restoration, so the old transaction cannot overwrite it.

Complete Preview uses its measured, pinned pixel map. Windowed Preview instead
retains one source-backed point and its offset from each pane's current viewport;
unmounted height estimates must not become a global alignment map. The same point
is projected in both directions using actual Source line-block heights, including
wrapped lines. Inter-block blank lines retain fractional progress, so reversing
through a rendered margin does not accumulate integer-line rounding drift. If the
Preview revision is pending, retain the pre-gesture Source origin until matching
coordinates are ready. Explicit navigation, document-top navigation and disabling
synchronization retire this relative origin; idle presentation rebases it against
the accepted reading geometry without inventing another scroll gesture.

When editing replaces the sampled paragraph's text node, a uniquely matched,
revision-mapped paragraph boundary retains its pixel offset. This is a fallback
for the lost text witness, not proportional progress through the paragraph's new
height. Deleted/ambiguous source identities do not authorize that restoration.

Windowed rendering can legitimately change absolute `scrollTop` as estimated
gaps become measured. The acceptance invariant is the painted text's reading
position and identity, not equality of scroll offsets across different layouts.
Source and Preview have different line heights, hidden syntax and displaced
footnotes; continuous scrolling follows monotonic reading flow rather than
requiring every source line to share a pixel row with rendered text.

`scripts/test-source-preview-edit-ownership.ts` drives production Source input
until caret auto-scrolling actually occurs, holds render responses across native
wheel/click gestures, and checks both complete and windowed reading surfaces.
It also samples the first wheel after a minimal reveal, alternating owners and
directions, a second click, wrapped paragraphs and fractional device pixel ratios;
the reading witness must stay visible and return to its original painted point.
The viewport-controller suite locks down cancellation, reverse ownership,
revision matching and nested presentation completion. Existing Source marker,
side Preview, cold-scroll and compositor suites cover the companion rules.

## Atomic asynchronous presentation

### Outline metadata

- A full-length placeholder syntax tree is not proof of complete headings. Live
  and Source consume the certified outer Markdown structure, including its
  background result, without rendering a hidden Preview to obtain headings.
- An initially pending outline remains visually quiet for 200ms, then displays
  a localized loading label. Only a completed empty result says "No headings".
  Hiding the outline cancels the deadline; existing headings stay visible and
  quiet during editing and mode transitions.
- Accumulated document changes map accepted heading offsets when the directory
  reads them, keeping navigation current while parsing finishes without walking
  every heading on each keystroke. Complete metadata then replaces that snapshot.
- When title text, inline styling and hierarchy have not changed, update source
  coordinates while retaining the same rows and collapsed state. Mixed-language
  token publication alone does not invalidate the outer Markdown heading cache.

`scripts/test-outline-large-startup.ts` exercises the production split build and
real Workers with 1,301 headings in a 1.37MB document. The targeted loading suite
checks the quiet window, cancellation and pending-to-empty completion.

### Rendered blocks

- A visible Mermaid diagram, decoded image, or Shiki-highlighted code block is
  retained until its replacement is ready.
- A changed code block must not expose the renderer's fallback token markup and
  then recolor it in a later visible frame. Tokens are requested while the last
  fully themed block remains connected; the new source and Shiki token DOM are
  committed together.
- Unchanged nodes survive incremental updates so selection, expanded details,
  decoded assets, and layout identity are not discarded.
- A content edit inside or below the visible Preview retains its physical viewport;
  an edit strictly above it maps the top semantic anchor through the text change.
  Presentation-only geometry changes retain the semantic point in the reading
  band, then pin the cached linked-scroll map to the committed position.
- Initial split Preview content becomes visible only after both editor layout and
  Preview paint readiness are confirmed. Render completion alone is not a reveal
  signal. Slow explicit activation may show a loading surface while content stays
  covered.

## Preview loading feedback

Opening Preview, opening its side pane, or changing between their final widths
starts a single 200ms presentation deadline. A ready surface cancels it without
showing a busy label or animation. After the deadline, a theme-colored opaque
loading surface replaces the previous editor cover (or occupies only the right
pane), with a localized status and a reduced-motion-aware spinner. The unfinished
iframe stays inert; Source and the mode/side-pane controls remain usable.

Feedback ends on accepted paint readiness, after final split geometry and source
alignment when applicable. Receiving a Host payload alone does not end loading.
Content appears immediately when ready, without a minimum spinner duration. An
error replaces loading with the existing failure status. Leaving Preview for an
editor without a side pane, hiding or disposing Preview cancels the deadline;
a late response cannot reopen it. Source edits and
resource refreshes never start this feedback or clear the existing reading surface.

`scripts/test-preview-loading-presentation.ts` drives the production bootstrap,
holds actual Host responses and iframe commit separately, and checks delayed
full/side loading, warm silence, input silence, cancellation, errors and initial
Preview startup. Its screenshots are actual DOM captures under an injected wait.
The full and split captures are saved in `.local/preview-loading/`.

Live and Source use the same 200ms quiet window for initial mounting and explicit
mode preparation. Their loading surface follows the existing mode intent through
actual readiness; it does not advance parsing, own mode state or start on edits.
The bootstrap shell is revealed when feedback becomes visible. In established
split layouts the overlay occupies only the editor's final grid column. A full
Preview remains a cover until the atomic split commit, so feedback covers that
whole preparing surface rather than exposing right-hand fragments of the old
full-width document beside a half-width loading surface.
The covered editor is inert while mode controls remain available to cancel.
Completion, failure, a newer intent and disposal retire both the deadline and
surface. An old completion cannot clear a newer intent's loading state. Mode
buttons keep their selected pill and keyboard focus without a progress underline.
`scripts/test-editor-loading-presentation.ts` holds actual cold module requests
and the production adapter's asynchronous preparation boundary to verify those
rules, quiet fast transitions, silent editing and Preview/split coordination.

VS Code's official Preview implementation similarly moves new styles into place
before morphing specifically to prevent an unstyled flash, and preserves equal
nodes during incremental updates. See
[`preview-src/index.ts`](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/preview-src/index.ts).

## Table fit and visible right edge

These fit rules apply to the Default preset. GitHub README keeps native table
layout and local horizontal overflow to match the platform's reading behavior.
Preset changes discard measured Default column groups before morphing, while
retaining the source reading anchor. See [preview-presets.md](preview-presets.md).

- Preview tables never create an internal horizontal scrollbar. Column demand
  controls the proportions; when space is insufficient, every column continues
  to shrink and wrap.
- When the readable column target is infeasible, cell padding is reduced before
  content can be clipped. Native list markers are visually omitted only in this
  compressed state because their unbreakable marker box can otherwise exceed a
  narrow cell; the semantic `ul`/`ol`/`li` structure and all text remain intact.
- `scrollWidth <= clientWidth` is not sufficient evidence. Chromium rounds those
  values while collapsed borders and antialiasing use fractional geometry.
- The final painted table edge must remain inside the wrapper's clip edge by at
  least one physical pixel and the declared outer border width. Layout converges
  against `getBoundingClientRect()`, not only the declared CSS width.
- Genuine fixed-width non-table HTML may keep local horizontal overflow, but it
  must not expand the Preview document root.

The browser contract in `scripts/test-source-side-preview.ts` covers the reported
five-column table, narrow many-column tables, raw HTML tables, split Preview,
standalone Preview, displaced footnotes, continuous bidirectional scrolling,
atomic code highlighting, and cross-mode continuous range projection. Delayed
asset geometry is covered by `scripts/test-source-preview-late-layout.ts`. The
standalone reading-surface matrix also checks table descendants across viewport
widths, zoom factors, and device pixel ratios. The pure projection outlier
contract is in `scripts/test-linked-viewport-map.ts`.

Giant top-level Markdown tables in built-in MEO presets use source-backed reading
bands within the existing logical Preview document. Columns belong to the complete
accepted table, so typing in a distant row cannot resize untouched visible cells;
newly mounted bands use those same preferences. A changed column schema accepts
fresh preferences, while font/viewport changes fit the existing preferences anew.
The authored header appears once. Adjacent mounted bands retain continuous row
borders and stripes. Search reveals the actual match after visible matching is
ready, rather than centering a whole band taller than the viewport. Presentation
transactions retain an explicit top/end intent while estimated gaps resolve;
content-edit transactions retain their existing reading-position rules.
Wheel quiet time is a resource-work budget, while only an actual held native
scrollbar forbids viewport restoration. Delayed image geometry during a wheel
must retain the current text witness rather than silently moving the page.
Screen readers, raw HTML/nested containers, GitHub and custom renderers retain
complete-table semantics. Standalone exports retain the original complete table;
logical whole-table clipboard HTML rejoins internal bands. Internal rendering
bands must never become missing rows in full-document search or copying.

Source positions are revision-specific. When edits insert/remove preceding blocks,
an ordinary table wrapper derives identity from its direct authored table, rather
than a changing window index. One transaction maps source identity for retained
roots, accepted column preferences and the exact text reading witness together.
An unchanged glyph remains at its fractional painted position after source-line
attributes change; a reused node for different source content is not a witness.
The Source position marker uses only coordinates belonging to the accepted
Preview revision. Pending Source line numbers must never briefly mark or reveal
an unrelated row in the older Preview. Edits inside a visible paragraph may
legitimately reflow following content; this does not require pinning that content.

An editor native thumb deliberately released at the track's top/bottom owns that
document edge through later row and CodeMirror height-map publication. The editor
viewport controller retains this intent at its existing scroll-write boundary;
row windows do not become a second navigation owner. A subsequent input/navigation
releases it. Stationary arrow/track clicks, content-margin selections, cancellation
and blur must not invent an edge intent.

Live row-window movement sizes only newly mounted rows. Retained cells must not
have their natural-height constraints cleared and reapplied just because nearby
rows mount. Actual font/width/content invalidation still resizes mounted rows.
A held native thumb uses a smaller offscreen buffer for page jumps; release
restores ordinary wheel/keyboard overscan while retaining the reading row or
explicit edge intent. This must not retire an active cell or omit logical rows.
