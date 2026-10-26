# MEO Enhanced

This changelog retains the release history of the original Markdown Editor
Optimized project. New MEO Enhanced releases start from version 0.1.0.
---
## 0.3.35
- Improved large and complex documents with background Markdown parsing and syntax highlighting, incremental updates, and bounded rendering for long tables, code fences, lists, quotes and footnotes. Copy, search, navigation, history and exports retain the complete document.
- Separated the optional large-file startup mode from automatic runtime optimizations, and added delayed loading feedback while Live, Source or Preview prepares a document.
- Preserved reading positions and unchanged rendered content during typing, font or preset changes, linked scrolling, delayed resources and native wheel scrolling. Improved cold Source input, table activation and caret continuity when returning to the VS Code window.
- Prevented font changes from replacing a visible Live table with another table's content, while retaining native cell input after preceding edits.
- Added independent heading and link appearance colors, and expanded supported HTML document styles across Live, Preview and exports.
- Edit Mermaid source directly in the Live document with syntax coloring and a live preview. Switch between stacked and side-by-side layouts, resize the split, and finish editing to return to the diagram; narrow panels adapt automatically.
- Unified block editing transitions and reading focus across Mermaid, formulas, HTML and code. Preserved caret visibility, selections and reading positions through keyboard navigation, pointer release, folding, history and delayed layout updates.
- Improved Mermaid navigation, localized diagnostics, theme and Gantt colors, and split-preview alignment. Kept block feedback stable during unrelated updates and refined layout controls and resize indicators.
- Expanded Mermaid and image zoom beyond the previous 4x limit, with proportional button and wheel steps while preserving reset, panning and document layout.
- Added an independent Ctrl/Cmd + mouse wheel font-size setting, enabled by default, with saved sizes across Live, Source and Preview.
- Added HTML tag, attribute and value completion through the shared input suggestion menu. Preserved unfinished-tag completion, improved candidate sizing and detail alignment, and added Beta feature indicators.
- Added pasted-image naming presets with document-name numbering, date/time, image numbers and millisecond timestamps, including concurrent creation and escaped Markdown paths.
- Kept local-link navigation and missing-file hints synchronized with filesystem changes, retained reading positions on native window return, and improved wrapped formula spacing and Preview export-menu dismissal.
- Preserved the reading position when releasing a floating table-header column resize instead of scrolling to the document caret.
- Prevented an intermediate viewport jump during rich-document input when virtual block measurements changed the scroll offset while the caret stayed in place.
- Kept Windows Ctrl+A selection within search and other native input fields so a delayed VS Code command cannot replace newly typed text.

## 0.3.34
- Added in-place HTML fragment editing with syntax-colored source, live previews, visible placeholders for non-rendering fragments, and feedback for filtered content. Improved fragment rendering, inline styles, tables, images and disclosure elements.
- Added explicit HTML and block-math source formatting with a configurable shortcut. Formatting preserves protected content, command spelling and local source structure, and remains a single undoable edit.
- Unified HTML and formula editing frames and preview dividers. Stabilized expansion, pointer selections, final-line hit testing, copying, line numbers and viewport positions; kept source actions visible only when their source is shown.
- Kept HTML and formula source at the selected font size, prevented edited tables from jumping during layout changes, and kept pressed Mermaid controls attached during background updates.
- Preserved rendered tables' source identities during widget reuse and kept visible table rows mounted while font changes reflow a long document.
- Kept HTML and formula source expanded through table pointer gestures so collapsing source cannot move the cell before release or interrupt entering its editor.
- Prevented mixed table and formula edits from briefly scrolling away from the active caret while virtual layouts settle.
- Added LaTeX completion previews and syntax coloring in Source and Live, with better handling of unfinished formulas, fenced blocks and currency-like text.
- Added Save As and undo/redo toolbar actions, configurable shortcuts and safer recovery from document-action failures. Improved saved-copy state and link navigation within MEO.
- Added table actions and refined cell selection, active-cell borders, responsive column widths, paste handling and caret visibility.
- Added bidirectional navigation and viewport alignment for split Source/Preview, GitHub frontmatter rows, and matching Setext heading rendering.
- Added typography and color autosave controls, rendered-block image copying and refined fullscreen interactions. Improved Mermaid controls and preserved keyboard focus feedback without mouse-triggered focus rings.
- Matched PDF paper backgrounds to document colors and preserved HTML visibility, text, figure captions and whitespace in Word exports.

## 0.3.33
- Preserved Preview and Source split Preview reading positions when switching to native VS Code editor tabs with the outline open, including hidden Webview resizing and normal visible panel resizing.
- Added Whitey dark mode using Typora Whitey Deep's palette, with Auto/Light/Dark choices, per-document appearance memory, and matching custom preset examples and HTML/PDF exports.

## 0.3.32
- Validated retained Webview layout sizes against actual panel visibility, preventing an open outline from collapsing Preview during native tab switches while preserving normal resizing under VS Code's clipping containers.
- Distinguished visible small panels from parked Webviews using browser intersection geometry, preserving hidden-tab reading positions without treating a fixed viewport size as hidden.
- Coalesced reading-layout resize updates and removed synchronous layout reads from the resize handler, with coverage for adjacent small-panel sizes and different parked-frame dimensions.

## 0.3.31
- Fixed Source split Preview returning to the start when mouse tab switches park the retained Webview before its blur event. Reading layout protection now applies before tab deactivation, with regression coverage for both focus/parking orders and real panel resizing.

## 0.3.30
- Preserved Preview and Source split Preview reading positions when switching to native VS Code editor tabs with the document outline open. Retained tabs keep their reading layout while VS Code parks the Webview in a smaller iframe.
- Kept hidden-tab reflow from disturbing delayed image layout updates, with regression coverage for all built-in Preview presets and same-file or different-file native tabs.

## 0.3.29
- Removed build-machine paths from the PDF browser runtime and checked every packaged text file before release, while preserving relocated QuickJS/WASM proxy support.
- Added GitHub README and custom Preview presets, with import, update, sharing, visibility and removal controls in Settings. Preset authoring guides and examples are available on GitHub; HTML and PDF follow the selected preset and appearance while Word retains its fixed document format.
- Preserved the reading position when switching presets in full and split Preview, including rapid changes and late render responses.
- Added Obsidian wiki images and vault-aware resource lookup, with readable Unicode link targets.
- Added eight configurable UI colors and an independent document background, with live appearance previews, save/cancel controls, readable surface layers and consistent light, dark and high-contrast controls.
- Let Source inherit VS Code syntax colors and retain session caches, reducing repeated highlighting and work for hidden content.
- Kept the last valid Mermaid diagram visible during split edits, coalesced typing, reused cached results and prioritized current edits over obsolete background work.
- Unified input-method handling and popup placement for slash, path and emoji suggestions; restored comments for additional code languages and slash shortcuts on international keyboard layouts.
- Refined segmented controls, tooltips and candidate text hierarchy, and stabilized rendered-block editing, history, line numbers and mode transitions.
- Kept Preview copy controls paired with independent preset colors and synchronized matching default controls during live color changes. Preserved readable suggestion matches on selected rows.
- Prevented Source typing from briefly losing syntax colors inside tokens and at their boundaries, while invalidating replaced source until fresh highlighting arrives.
- Synchronized table source positions before focus after embedded block edits, and refreshed Mermaid control appearance together with diagram colors.
- Kept the Live reading line visible during font changes after tall tables, preventing repeated viewport jumps while block heights settle.
- Preserved measured table height when virtualized tables reappear, preventing temporary row collapse from interrupting Live scrolling.
- Kept Markdown formatting markers inside code, formulas, link destinations and titles, comments, and HTML code from affecting surrounding text; fixed pointer expressions being shown as italics in Live mode.
- Aligned punctuation-adjacent emphasis, strikethrough and highlighting across Live prose, tables, Preview, and HTML, PDF and Word exports.
- Corrected nested and mixed inline formatting, unmatched delimiters and incremental editing while preserving literal code and readable outline labels.

## 0.3.28
- Expanded bilingual settings search, editing assistance and configurable shortcuts, including image storage rules, contextual slash commands, link and emoji suggestions, and native table paste behavior.
- Kept Live code, Mermaid and math block controls visible while scrolling, and added hover copy controls for Mermaid source and LaTeX expressions in document Preview.
- Let floating block controls wait for geometry-only mode updates to settle, preventing CodeMirror measurement-budget warnings while preserving their first visible frame and cleanup.
- Unified link destination tooltips across prose, tables and Preview, with readable Unicode targets, localized prefixes, consistent modifier-key behavior and compact content-sized bubbles.
- Preserved search text and highlights across editor modes without delaying mode transitions or competing with navigation.
- Stabilized rendered block geometry, nested lists and quotes, table widths, scrolling and embedded-editor viewports through input and history changes; corrected clicking and selecting empty quoted lines.
- Kept explicit Live navigation authoritative while late rendered-block layouts settle, preventing distant targets from being pulled back out of view.
- Prevented window activity changes from stealing editor focus and improved keyboard focus feedback on preview controls.
- Harmonized inline-code spacing and colors, dark text contrast, and borderless block backgrounds between Live and Preview.
- Prevented Preview from announcing readiness for an initial blank iframe before its reading document is available.
- Kept adopted Live table widgets synchronized with later height measurements after multiline rows finish laying out.
- Unified logical text identity for CRLF document sync, local edits, save confirmations, Preview startup and split Preview disk reloads while preserving Host line endings.

## 0.3.27
- Improved caret continuity across window activation, toolbar and menu interactions, and Live/Source mode switches, including table cells, Mermaid, and math editors. Fixed reversed formula input when nearby tables were re-rendered. Kept typing carets visible through late layout changes without competing scroll corrections. Retired stale embedded-input positioning after undo/redo and external synchronization.
- Preserved Mermaid and math source/split choices across mode switches and kept new Source selections authoritative; restored HTML source positions when editing rendered content again.
- Centered offscreen Live table search matches in the usable viewport, accounting for floating table headers. Preserved the reading position during bulk replacement.
- Preserved automatic table column minimum widths after window resizing and manual widths through external document updates; kept HEX color controls aligned with editor scrolling.
- Added document recovery actions and safe copy saving, with native notifications for opening a saved copy or its containing folder.
- Made HTML, PDF, and DOCX exports use light document appearance independently of Preview's theme.
- Aligned Preview bold labels ending in punctuation with Live rendering and prevented time literals from being treated as emoji syntax.
- Reduced redundant highlighting, Preview DOM updates, and table-layout work; stabilized startup reading positions, late virtual-layout changes during Live scrolling, linked Preview geometry refreshes, and retryable Preview refreshes.
- Refined editor notices, split Preview controls, and content-sized Preview font controls; lowered the minimum VS Code version to 1.94.

## 0.3.26
- Removed a local build path from the extension package while retaining direct opening of exported files with Unicode names on Windows.
- Fixed clean-checkout DOCX export tests and strengthened cross-platform package validation.

## 0.3.25
- Fixed Preview startup for CRLF Markdown and Webview reloads so the rendered document appears without switching modes.
- Let VS Code manage the default Markdown editor choice instead of rewriting user editor associations on extension startup.
- Added Word (`.docx`) export with light document styling, a native table of contents, formatted Front Matter, code blocks, tables, images, diagrams, formulas, links, and footnotes.
- Added optional bold-text coloring in Live mode, disabled by default, with body-derived colors tuned separately for light and dark appearances.
- Added an enabled-by-default large-file startup optimization setting with a compact explanatory tooltip.
- Opened Live, Source, and Preview directly in the requested startup mode without briefly exposing Source presentation.
- Stabilized ordinary blockquotes and all GitHub Alert variants during activation and Enter, preserving marker alignment, text inset, color, and first-frame styling.
- Kept the floating table header's one-pixel bottom divider visible across display scales.
- Shifted Preview body foreground blending to the requested 70/30 balance.
- Added HTML comment visibility controls in Live and Preview, with visible comments carried into exported output.
- Preserved nested lists, task items, blockquotes, quoted tables, and Unicode word underscores in Live editing.
- Added color comparison while adjusting supported HEX colors, and refined table color controls and editor notices.
- Unified toolbar and settings controls, added split Preview display options, and made editor heading weight configurable.
- Kept viewports, line numbers, embedded source editors, and table controls stable through font-size changes, typing, and undo/redo.

## 0.3.24
- Fixed Shift+Enter line breaks in Live table cells so rows expand downward and the viewport moves only when the caret would leave the visible area.
- Stabilized outline navigation and fixed/floating outline mode changes to prevent brief viewport jumps.
- Matched Source table header typography to ordinary body text.
- Prevented the Source split Preview to Preview transition from briefly flashing stale Source content.
- Rendered Preview table borders as solid lines so intersections no longer appear as dark dots.

## 0.3.23
- Added optional HTML and PDF exports with a clickable table of contents, with PDF body content starting on a fresh page after the contents.
- Improved PDF pagination and overflow handling for long code, tables, complex lists, headings, large Mermaid diagrams, and unbroken inline content.
- Added localized export progress and completion actions, including opening the exported file or revealing it in its folder, while keeping cancellation and repeated export clicks responsive.
- Kept exported code blocks, Front Matter, semantic surfaces, and light/dark colors aligned with Live and Preview, including when the Preview appearance differs from VS Code or changes at runtime.
- Stabilized Preview activation, document backgrounds, reading position, and first-frame code colors across Live, Source, Preview, and Source split Preview transitions.
- Scoped disk reloads to the active document and preserved embedded editor focus, table state, history context, and long-document viewport continuity during asynchronous presentation work.
- Fixed installed HTML and PDF exports by resolving bundled Shiki and browser runtime assets from the extension package, while reusing language assets to limit package growth.
- Fixed Mermaid split Preview so the rendered viewport fills the complete fenced-block height on wide layouts.

## 0.3.22
- Added an early warning when an open document changes on disk, with localized actions for reviewing or reloading the external version.
- Added a persistent Source-to-Preview edit-position highlight and click-to-source navigation, with smoother semantic targeting while moving across Preview content.
- Stabilized reading position and first-frame rendering when switching among Live, Source, Preview, and Source split Preview, including transitions back to Live.
- Restored Live table column widths after editor-tab visibility changes and refined sticky-header editing, row insertion, contextual tools, and restrained header styling.
- Kept wrapping table cells and offscreen carets anchored predictably during input instead of applying a typewriter-style viewport shift.
- Prevented partially visible Mermaid source editing from competing for the viewport or flashing unrelated rendered content.

## 0.3.21
- Added an optional Source split Preview with live rendering, bidirectional semantic scroll synchronization, a compact session-only sync control, and linked back-to-top navigation.
- Stabilized reading position across Live, Source, Preview, split-view transitions, edits, asynchronous layout, and disk reloads without changing cursor, selection, or focus.
- Reworked Preview presentation so code highlighting, Mermaid diagrams, and other rendered content update atomically with less flicker and redundant work.
- Improved Preview table fitting with content-aware column allocation, proportional compression, and no unnecessary horizontal scrolling or clipped right edge.
- Refined editor interactions and visual consistency, including selection toolbar timing and surfaces, HTML details line numbers and spacing, table header colors, and scroll-to-top controls.

## 0.3.20
- Added GitHub-style disclosure markers to collapsible HTML and Markdown details, with stable geometry in both states.
- Fixed Live-mode blockquote text shifting while clicking.

## 0.3.19
- Refined table controls with opaque neutral surfaces, clearer hover and active states, and balanced contrast in both light and dark appearances.
- Kept table toolbars at the viewport edge for exceptionally tall cells, including when sticky headers are disabled, and preserved column widths across Preview and Live transitions.
- Narrowed the outline resize guide and isolated text selection between current and previous-version content in Source mode.

## 0.3.18
- Added contextual table actions, rectangular multi-cell selection and paste, safer deletion, and more predictable focus, undo, and keyboard navigation.
- Improved table layout and interaction with configurable sticky headers, stable toolbar placement, clearer column-resize boundaries, and better default widths.
- Stabilized minimal scrolling and reading-position continuity during typing, history replay, table editing, image refreshes, and Live/Source/Preview transitions.
- Fixed first-frame line numbers and input colors in code, Mermaid, and block-math editors so rendered editing feedback appears immediately.
- Refined image presentation and reload behavior, editor settings labels and layout, and initial reading-position restoration.
- Fixed Windows F5 builds by locating Bun reliably when it is not available on the task shell path.

## 0.3.17
- Stabilized reading-position continuity across Live, Source, and Preview transitions, including image loading and long-document viewport restoration.
- Improved mode-switch performance by reusing Markdown parses, decorations, rendered-block discovery, and loaded Preview documents while discarding obsolete background results.
- Kept Preview, HTML, and PDF links consistently blue; limited Live HEX color previews to six- and eight-digit values and removed color swatches from reading and exported output.
- Fixed local and network Preview image handling, including encoded Windows paths, deferred loading, and non-embedded image delivery.
- Refined multiline footnotes, editor leading-edge selection, language-switch line numbers and long-code widgets, settings and change-review menus, and feedback access.
- Improved table resource disposal, list normalization, plain-text scanning, Mermaid startup work, and inactive diagnostics and diff processing.
- Expanded browser, viewport, image, mode-transition, resource-lifecycle, native performance, and endurance regression coverage.

## 0.3.16
- Stopped delayed Preview appearance renders from restoring an old reading position after user interaction.
- Yielded before uncached Live diagram rendering and added focused diagram and native input/save performance probes.
- Prevented stale viewport measurements from briefly shifting the document when first opening a Mermaid split view.
- Kept existing code syntax colors visible while updated highlighting is pending during typing.
- Reduced startup work by limiting code highlighting to the reading viewport, batching highlight refreshes, and yielding between diagram preloads.
- Reduced Preview activation layout work and prevented blank frames during mode switches, including the first render.
- Fixed auto-save snapshot races when editing continues during a save, and preserved pending table, Mermaid, formula, and IME input.
- Made Preview links, document jumps, and footnote returns blue in both light and dark appearances.
- Dismissed toolbar menus and floating panels when clicking Preview content while preserving link activation.
- Expanded save regression coverage and added reusable native auto-save endurance acceptance.

## 0.3.15
- Added an explicit comparison-off option and enabled comparison with the last saved version by default for new users, while preserving existing preferences.
- Refined settings switches, comparison labels and icons, toolbar overflow menus, and the find-and-replace panel; clarified that reloading discards unsaved changes.
- Kept line numbers, change markers, and original-content backgrounds aligned when toggling line numbers and constrained width, with scrollbars and overview rulers remaining at the window edge.
- Unified the Properties heading across interface languages and corrected its vertical alignment and Preview row height.
- Refreshed Mermaid and formula toolbar line identities after edits and undo, and prevented change-marker hit areas from overlapping list content.
- Expanded browser regression coverage and corrected asynchronous syntax-highlighting test synchronization.

## 0.3.14
- Added change-review baseline controls for disk, Agent edits, Git HEAD, and manual snapshots, with persistent display preferences.
- Kept change counts and editor markers synchronized, and restored comparison retries after saving or reloading a document.
- Stabilized line-number alignment, floating code-block collapse, rendered-block mode changes, and Mermaid viewport geometry.
- Improved code and formula syntax colors, removed nested source-editor focus outlines, and refined settings and change-menu spacing.
- Improved table resizing, search replacement context, and editing history, with expanded release regression coverage.

## 0.3.13
- Improved theme, syntax-color, and interface consistency across Live, Source, and Preview modes.
- Stabilized editing, undo and redo, cursor placement, and viewport continuity for tables, Mermaid diagrams, block formulas, long code blocks, and lists.
- Improved long-document loading, scrolling, rendering, and reading-position recovery.
- Refined the outline, Properties, diff and baseline controls, exports, language switching, and related toolbars.
- Strengthened architecture checks, browser coverage, stress tests, and VSIX content validation.

## 0.3.7
- Reworked editor state and lifecycle boundaries for more reliable mode changes, history, tables, rendered content, diagnostics, preview, and export.
- Fixed Mermaid source mode being lost after undo and redo.
- Strengthened TypeScript, architecture, CI, and VSIX content validation.

## 0.3.6
- Fixed table editing and column resizing

## 0.3.5
- Added session-only Markdown table column resizing, including sticky headers.
- Stabilized code, Mermaid, and formula block controls across hover and mode changes.
- Refined task checkbox outlines to match the desktop note style.

## 0.3.4
- Fixed README navigation links

## 0.3.3
- Added underline HTML support

## 0.3.2
- Refined HTML editing controls and block backgrounds across dark and light appearances.

## 0.3.1
- Improved dark editor background contrast

## 0.3.0
- Added independent Light and Dark editor appearances with per-window switching and persisted defaults for newly opened editors.
- Added safe inline and block HTML rendering, source editing, link navigation, and consistent Preview and export output for supported elements.
- Added `==highlighted text==` across Live, Source, Preview, tables, and exported documents.
- Added responsive Mermaid and block formula layouts with stable Source, Split, and Preview interactions, zoom controls, and export fitting.
- Improved change indicators, long-document scrollbar stability, and viewport preservation around rendered blocks and code fences.
- Refined table editing controls, sticky headers, shared floating controls, segmented controls, and scroll-to-top presentation.
- Added bilingual English and Simplified Chinese documentation with an updated Dark and Light feature overview.

## MEO Enhanced 0.2.0
- Prepared the first Visual Studio Marketplace release under the independent `huangko555.meo-enhanced` extension identity.
- Added document scroll-to-top controls for quickly returning to the beginning of long documents.
- Stabilized Live mode layout updates and block interactions across Mermaid, LaTeX, tags, and long code blocks.
- Preserved collapsed details state while editing source content and improved details folding stability.
- Refreshed the README with feature screenshots, Marketplace installation instructions, and clearer upstream attribution.

## MEO Enhanced 0.1.9
- Fixed long Mermaid node labels being clipped or overflowing their nodes by enabling reliable Chinese text wrapping and matching node height to the wrapped content.
- Matched Mermaid label measurement to the active editor font after fonts finish loading for consistent rendering across installed and development builds.

## MEO Enhanced 0.1.8
- Restored the shared level-one and level-two heading divider in Preview and HTML/PDF exports for both light and dark appearances.

## MEO Enhanced 0.1.7
- Fixed stale table interaction state that could prevent Markdown markers, links, and images from expanding when clicked.
- Prevented the fixed-baseline toolbar action from briefly shifting the editor viewport.
- Fixed sticky positioning for the shorter pane while editing Mermaid diagrams in split mode.
- Unified Preview and export reading styles in both light and dark appearances, removed heading dividers, and preserved rounded rendered blocks.
- Scaled oversized Mermaid diagrams to the printable A4 area to prevent blank PDF pages and cross-page clipping.

## MEO Enhanced 0.1.6
- Hid incomplete left-side toolbar controls as whole items and moved the non-interactive white ellipsis to the end of the visible left group.

## MEO Enhanced 0.1.5
- Prioritized right-side toolbar controls in narrow windows and indicated covered left-side tools with a non-interactive ellipsis.
- Disabled text selection throughout the toolbar.

## MEO Enhanced 0.1.4
- Matched the outer borders of the mode and Preview appearance controls to their active pill background while preserving the full-size selection indicator.

## MEO Enhanced 0.1.3
- Refined the Live / Source / Preview and Light / Dark controls with consistent pill styling and content-aware widths.
- Improved the line jump input alignment and simplified line navigation to use Enter without an inline action button.

## MEO Enhanced 0.1.2
- Added a fixed baseline workflow that can pin the latest valid saved version and switch back to the selected Changes mode without releasing the baseline.
- Added Obsidian-style Frontmatter Properties in Live and Preview while preserving direct editing and complex YAML content.
- Preserved list indentation for code blocks, Mermaid diagrams, display math, and long-code controls.
- Added consistent rounded corners to rendered block elements in Live and Preview.
- Fixed occasional cursor jumps after pressing Enter and typing quickly.
- Fixed invalid Preview fence markup that left an empty block before nested code blocks.
- Fixed document position loss when switching between Live, Source, and Preview modes.
- Fixed list-indented tables rendering as source text or misaligning with adjacent block content in Preview.

## MEO Enhanced 0.1.1
- Isolated commands, settings, editor identifiers, and F5 debugging from the original MEO extension
- Added indented table rendering that preserves document hierarchy and restored multi-cell clipboard copy
- Fixed sticky table header borders, ordinary link expansion, and floating long-code action states
- Refined the line jump input and Live / Source / Preview and Light / Dark switcher borders and alignment
- Removed browser focus outlines throughout the Webview while preserving component interaction states
- Prevented stale content-hashed Webview chunks from accumulating in VSIX packages

## 0.1.34
- Added a two-click discard action that reloads unsaved content without losing the current reading position
- Improved Preview scrolling, cross-surface search selection, search highlight cleanup, and overview ruler accuracy
- Refined sticky table headers, table controls, long-code actions, document jump icons, and cross-device heading typography
- Fixed Windows absolute-path images in Preview, HTML export, and PDF export while preserving remote image URLs

## 0.1.33
- Fixed Preview link navigation so external and local document links open consistently without clearing the preview or invoking the `vscode-webview` protocol
- Preserved accessible mouse and keyboard interaction for brokered Preview links, including pointer cursors and page anchors

## 0.1.32
- Added a persistent read-only Preview mode with stable navigation, search, toolbar actions, and export appearance
- Improved Mermaid and LaTeX rendering consistency across Live and Preview modes
- Added collapsible long code blocks in Live mode with search-aware expansion and accessible controls
- Added Live color value previews in normal text and rendered tables while keeping colors distinct from Markdown tags
- Improved viewport restoration across documents and editor modes without unexpectedly expanding folded code blocks
- Refined toolbar controls, sticky table headers, inline table rendering, and cross-table interaction stability

## 0.1.31
- Added current-edit, recent-save, and Git HEAD change baselines with an explicit save checkpoint action
- Replaced custom line pairing with VS Code Quick Diff semantics for stable added, modified, and deleted markers around repeated blank lines
- Added original-content previews for modified and deleted markers, including deduplicated Mermaid, LaTeX, and table block markers
- Added an optional line author hover toggle, disabled by default, and refined toolbar action placement

## 0.1.30
- Centralized viewport stabilization to prevent asynchronous Mermaid, image, and layout updates from moving the current reading position
- Added reliable external and document-internal link controls to rendered table cells, including stable focus and table re-entry behavior
- Matched the floating outline background with the docked outline and kept code block select-all focused at the start of the selection

## 0.1.29
- Fixed visible indentation for ordered and unordered lists after continuation lines in table cells

## 0.1.28
- Fixed external document updates and preserved the visible reading position across saves, focus changes, and asynchronous rendering
- Improved table list indentation, multiline spacing, Enter navigation, image rendering, and multi-row or multi-column deletion
- Fixed clipboard image paste handling in both document content and table cells
- Added dismiss controls to editor notifications
- Removed nested list guide lines

## 0.1.27
- Added editable Mermaid and LaTeX preview, split, and source modes
- Added HTML break rendering and list editing inside table cells
- Added code block line numbers and selection controls
- Added toolbar line navigation for normal text, tables, Mermaid, and LaTeX blocks
- Improved editor viewport stability, outline navigation, and inline Markdown rendering
- Grouped secondary toolbar actions under a persistent More menu

## 0.1.26
- Improved dark Mermaid diagram line contrast
- Fixed live find matches and preserve active highlight
- Fixed inline toolbox and ignore intraword underscores
- Fixed find results in rendered tables

## 0.1.25
- Added spellcheck suggestions and toolbar toggle
- Fixed mermaid diagram rendering and controls
- Fixed content width toggle state

## 0.1.24
- Added light theme and background customisation
- Added sync with VSCodeVim custom keybindings
- Added VS Code theme highlighting for code blocks
- Added spell diagnostics in MEO editor
- Added content width toolbar toggle
- Added contextual table cell editing controls
- Added sortable live table columns
- Improved wide table rendering
- Improved find result highlighting and controls
- Fixed Git baseline refreshes during editor startup
- Fixed pending markdown edits during save sync

## 0.1.23
- Added inline footnote support with decorations and styling
- Enhanced full list line decorations and currency vs latex rendering

## 0.1.22
- Added support for additional task statuses in-progress [~] and dropped [-]
- Added drag threshold handling for git blame gutter
- Enhanced single tilde strike handling with whitespace and boundary checks

## 0.1.21
- Added scroll position restoration for long markdown files
- Fixed shortcut handling for local search shortcut to exclude shift key

## 0.1.20
- Added export image mode configuration for HTML export
- Added font weight configuration for headings in theming
- Added ready handshake mechanism for webview
- Removed auto-save feature and related configurations
- Enhanced VSCode API compatibility with fallback state management
- Enhanced copilot handoff
- Updated anchor coordinates for improved selection handling
- Updated global configuration
- Fixed base01 theming issue
- Fixed padding for mode-toolbar when line numbers are hidden

## 0.1.19
- Added support for customizable font weights in theme settings
- Fixed URL boundary decorations
- Fixed agent review handling
- Fixed min-width for hidden line numbers
- Updated configuration for browser path handling
- Updated demo image URL for proper rendering outside of GitHub
- Removed git decorations from no git paths and files in .gitignore

## 0.1.18
- Implemented Theming v2
  - Built-in themes
  - Granular style customisation for individual markdown tags
  - Import/Export themes as JSON
- PR: Extra code block langs (#26)
- Fixed local link handling and navigation
- Various minor improvements

## 0.1.17
- Added latex math rendering
- Added kbd tag parsing and rendering
- Improved auto save stability
- Improved table inline parsing
- Updated demo gif and enhance feature descriptions

## 0.1.16
- Added mermaid colon fences in markdown rendering
- Fixed document offset mapping in applyDocumentChanges function (patch for issue 23)

## 0.1.15
- Added find functionality for whole word and case sensitivity options
- Added GitHub Copilot native change review support
- Fixed link decoration handling in live mode on text selection
- Refactor extension entry point
- Implemented load performance improvements

## 0.1.14
- Added .mdc/.mdx support
- Added collapsible details blocks with summary widget and styling
- Added GitHub alerts render
- Added footnotes
- Added emoji support
- Added floating toolbar display for table cells
- Added draft state synchronization and messaging
- Added git blame support for tables and mermaid diagrams in live mode
- Improved frontmatter HTML export
- Enhanced git diff functionality with live mode renderer
- Fixed z-index for row controls to get hover working

## 0.1.13
- Refactored webview from JS to TS
- Added image paste function with 'assets' as default folder
- Added font size setting
- Fixed top toolbar position
- Fixed numeric lists issue & double enter press behaviour
- Performance improvements

## 0.1.12
- Added Git change visualisations to the left gutter and scroller with toggle functionality
- Added Git blame feature
- Added basic support for merge conflict markers
- Added Vim mode and associated keyboard shortcuts, can be enabled in settings for Source mode
- Added a customisable shortcut to toggle between Live/Source modes, Option+Shift+M is default
- Enhanced list marker handling and indentation logic
- Improved arrow key navigation for list content in live mode
- Improved error handling for live mode transient render issues

## 0.1.11
- Added inline markdown rendering in table cells
- Added support for markdown code block rendering
- Added frontmatter styling for simple arrays
- Improved mode switching behaviour
- Enhanced table image rendering
- Enhanced inline code styling
- Fixed editor focus during mode toggling
- Fixed initial cursor position in editor and focus on mount

## 0.1.10
- Added HTML and PDF export functionality
- Improved handling of pending changes and flush logic in editor
- Enhanced frontmatter lists handling and styling for YAML fields
- Enhanced table cell editing with inline previews and improved selection styles
- Removed unnecessary multipleOf constraints for line height settings

## 0.1.9
- Added outline controller with drag-and-drop functionality for headings
- Added heading collapse functionality
- Added customizable line height settings for live and source modes
- Added keyboard handling to close find panel with Escape key
- Enhanced task list handling

## 0.1.8
- Added language label for code blocks
- Added outline position customization for the document sidebar
- Added powerquery syntax highlighting

## 0.1.7
- Fixed `Reset Theme to Defaults` so theme/font overrides are cleared correctly at global, workspace, and workspace-folder scopes.
- Improved live-mode thematic break decorations so active-line state and frontmatter boundary rendering stay consistent.

## 0.1.6
- Added settings for theme overrides and per-mode fonts.
- Added a `Markdown Editor Optimized: Reset Theme to Defaults` command to reset all theme colors/fonts to defaults.
- Added line number visibility toggle
- Added rendering for mermaid math blocks

## 0.1.5
- Added wiki link support, including link parsing, local file presense detection, and navigation for `[[...]]` references.
- Added local image source resolution so workspace-relative image paths render correctly in the editor.

## 0.1.4
- Added image insertion and rendering functionality in the editor.

## 0.1.3
- Added support for different list indentations.
- Added frontmatter support with enhanced styling for the editor.
- Added git associations resolver for native source control file loading.
- Improved editor loading time and performance.

## 0.1.2
- Added full find/replace support in the editor, including next/previous navigation, replace current, and replace all.

## 0.1.1
- Improved list handling, including consistent two-space indentation for nested lists.
- Applied packaging and documentation fixes (`package.json`, ignore files, and README updates).

## 0.1.0
- Initial build of the Markdown Editor Optimized (MEO) VSCode extension.
