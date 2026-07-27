# MEO Enhanced

This changelog retains the release history of the original Markdown Editor
Optimized project. New MEO Enhanced releases start from version 0.1.0.
---
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
