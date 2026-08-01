# MEO Enhanced

Edit complex Markdown and see every addition, modification, and deletion as you work—all inside VS Code.

在 VS Code 中编辑复杂 Markdown，并在工作过程中清楚看到每一处新增、修改与删除。

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced">Install from VS Code Marketplace</a> ·
  <a href="https://github.com/huangko555/meo-enhanced/releases">Download VSIX</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./docs/theming.md">Theming guide</a>
</p>

![MEO Enhanced showing the same Live document in independent Dark and Light appearances](docs/readme/editor-appearance-dark-light.png)

MEO Enhanced is a Markdown editor for VS Code built around a stable Live editing workflow. It keeps source editing, rendered content, change review, advanced tables, Mermaid, LaTeX, images, and document navigation in one editor instead of splitting them across disconnected views.

It is based on [Markdown Editor Optimized (MEO)](https://github.com/vadimmelnicuk/meo) and focuses on deeper interaction, review, and layout stability for larger or structurally complex documents.

## Install

Install **MEO Enhanced - Markdown Editor** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced), or run:

```shell
code --install-extension huangko555.meo-enhanced
```

Then right-click a `.md`, `.markdown`, `.mdx`, or `.mdc` file and choose **Open With MEO Enhanced**. To make it the default Markdown editor, run **MEO Enhanced: Set as Default** from the Command Palette.

For offline installation, download a `.vsix` package from [GitHub Releases](https://github.com/huangko555/meo-enhanced/releases) and run **Extensions: Install from VSIX...**.

## Editing modes and appearance

- **Live** keeps Markdown directly editable while rendering headings, tables, links, images, alerts, code blocks, Mermaid, LaTeX, and other rich content in place.
- **Source** provides a focused Markdown source editor with syntax highlighting and the same document navigation tools.
- **Preview** provides a read-only rendering for final review.
- **Independent Dark and Light appearances** can be switched from the bottom of the More menu. The selected appearance applies to the current editor and becomes the default for editors opened later, without forcing already-open editors to change.
- **Consistent first Preview render** uses the selected editor appearance instead of inheriting an unrelated VS Code host theme.
- **Stable mode switching** preserves the reading position as closely as possible when moving between Live, Source, and Preview.

## Review changes without leaving the document

MEO Enhanced can show additions, modifications, and deletions directly beside the document, with an overview ruler for their distribution across the full file.

- Compare against **Current Edits**, **Recent Save**, or **Git HEAD**.
- Pin a recently saved revision as a fixed baseline and continue reviewing later changes against it.
- Inspect deleted content and move between change locations without opening a separate diff editor.
- Optionally show subtle modified-line coloring and Git author information.
- Keep change markers stable across repeated lines, tables, consecutive deletions, and long documents.

![Added, modified, and deleted lines with baseline controls and the document overview ruler](docs/readme/changes-overview.png)

## Edit real-world tables and nested content

- A sticky header keeps complete column context visible while scrolling long tables.
- Insert, remove, reorder, and select rows or columns from the table toolbar.
- Press `Shift + Enter` to add a line break inside the active cell.
- Use ordered lists, unordered lists, nested indentation, images, colors, inline formatting, and keyboard tags inside cells.
- Select multiple cells and copy them as text with `Ctrl/Cmd + C`.
- Keep tables, code blocks, Mermaid diagrams, and block formulas aligned when nested inside lists or other structures.

![A long table with a sticky header, nested cell lists, and indented block content](docs/readme/tables-and-nesting.png)

## Work with Mermaid, LaTeX, code, images, and rich Markdown

- Mermaid diagrams and block formulas support **Source**, **Split**, and **Preview** block modes.
- Split mode adds panning plus zoom, reset, and fit controls while keeping the source beside the rendered result.
- Wide Mermaid diagrams and block formulas scale to the available width in Live, Preview, and export output.
- Long fenced code blocks can collapse automatically; the behavior is enabled by default and can be disabled from More.
- Code blocks support line numbers, syntax highlighting, copying, and consistent Live/Preview/export styling.
- Images support clipboard insertion, stable local path handling, full-size viewing, and opening through the system application.
- Frontmatter Properties render Obsidian-style metadata, tags, and complex YAML values.
- Live text supports emphasis, strong text, strikethrough, `==highlight==`, inline code, `<kbd>` keys, links, colors, `<br>` line breaks, and collapsible `<details>/<summary>` content.

![Mermaid and block formula source, split, and preview modes](docs/readme/rich-content-modes.png)

## Navigate and keep your place

- Jump to an exact line from the toolbar.
- Return to the top through the floating document button.
- Use the hierarchical outline to collapse sections, reorder headings, and follow the current scroll position.
- Place and resize the outline on either side of the editor.
- Preserve the visible document position across editing, saving, folding, table interaction, rich block rendering, and mode changes whenever possible.
- Double-click the discard button to abandon all unsaved edits in the current document.

## Quick reference

| Action | How |
| --- | --- |
| Switch Live and Source | `Alt/Option + Shift + M` |
| Open Preview | Select **Preview** in the top-right mode control |
| Switch Dark and Light | Open **More**, then use the appearance control at the bottom |
| Jump to a line | Enter a line number in the toolbar and press `Enter` |
| Return to the top | Click the floating button in the lower-right corner |
| Discard unsaved edits | Double-click the discard button |
| Add a line break in a table cell | `Shift + Enter` |
| Choose a change baseline | Open **More**, then select Current Edits, Recent Save, or Git HEAD |

## Configuration and themes

The editor includes independent Dark and Light appearances plus a customizable theme system. The theme picker ships with ten presets, including One Monokai, One Dark Pro, Dracula, Gruvbox, Nord, Solarized Dark, Catppuccin Mocha, Tokyo Night, GitHub Dark, and GitHub Light.

Use the Command Palette to select a preset, export it as JSON, adjust only the colors or typography you need, and import it again. Themes can control:

- document and embedded-surface colors;
- Markdown and code syntax tokens;
- Live and Source font families, sizes, weights, and line heights;
- heading sizes and weights;
- HTML and PDF export styling.

See the [theming guide](docs/theming.md) for the schema, fallback behavior, and complete token list.

Common settings include:

- `meoEnhanced.outline.position` — place the outline on the left or right.
- `meoEnhanced.changes.baseline` — select `current-edit`, `recent-save`, or `git-head` as the comparison baseline.
- `meoEnhanced.gitChanges.visible` — show or hide document change indicators.
- `meoEnhanced.gitBlame.enabled` — show Git author and commit details when hovering over lines.
- `meoEnhanced.codeBlocks.collapseLongBlocks` — enable or disable automatic folding for long fenced code blocks.

## Compatibility and project scope

- Requires VS Code `1.97.0` or newer.
- Handles `.md`, `.markdown`, `.mdx`, and `.mdc` files through a custom editor.
- Uses distinct commands, settings, and editor identifiers, so it can be installed alongside the original MEO extension.
- The feature descriptions above use upstream MEO `v0.1.26` as the comparison point for this fork.
- Version-by-version additions, changes, fixes, and removals are recorded in the [changelog](CHANGELOG.md).

## Acknowledgements

- [Markdown Editor Optimized](https://github.com/vadimmelnicuk/meo) — original project
- [VS Code](https://code.visualstudio.com/) — extension platform
- [CodeMirror](https://codemirror.net/) — editor core
- [Obsidian](https://obsidian.md/) — interaction design reference

## License

[MIT License](LICENSE)
