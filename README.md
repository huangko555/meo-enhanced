# MEO Enhanced

Edit complex Markdown and see every addition, modification, and deletion as you work—all inside VS Code.

在 VS Code 中编辑复杂 Markdown，并在工作过程中清楚看到每一处新增、修改与删除。

<p align="center">
  <strong>English</strong> · <a href="https://github.com/huangko555/meo-enhanced/blob/main/README.zh-CN.md">简体中文</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced">Install from VS Code Marketplace</a> ·
  <a href="https://github.com/huangko555/meo-enhanced/releases">Download VSIX</a> ·
  <a href="https://github.com/huangko555/meo-enhanced/blob/main/CHANGELOG.md">Changelog</a>
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

## Three display modes

- **Live** — edit Markdown directly while headings, tables, images, diagrams, formulas, and other content are rendered in place.
- **Source** — work with the original Markdown text in a focused source editor with syntax highlighting.
- **Preview** — read and review the fully rendered document without entering editing state.

## Review changes as you write

Additions, modifications, and deletions stay visible beside the document, so you can review work without moving to a separate diff editor. Compare the current text with your latest save or Git version, pin a saved version as a baseline, and use the overview ruler to see where changes are located.

## Work with complex Markdown

- Edit Markdown tables visually, including long tables and rich content inside cells.
- Work with Mermaid diagrams, LaTeX formulas, code blocks, images, and safe HTML without leaving the editor.
- Use document links, Wiki links, footnotes, alerts, and Frontmatter Properties in the same workflow.
- Keep nested lists, tables, diagrams, and other structured content readable while editing.

![A long table with a sticky header, nested cell lists, and indented block content](docs/readme/tables-and-nesting.png)

![Mermaid and block formula source, split, and preview modes](docs/readme/rich-content-modes.png)

## Find, navigate, and share

- Find and replace text across editable and rendered content.
- Jump by line number or use the document outline to move through long files.
- Keep your place while editing, saving, or switching modes.
- Review the finished document in Preview, then export it as HTML or PDF.

## Quick reference

| Action | How |
| --- | --- |
| Switch Live and Source | `Alt/Option + Shift + M` |
| Find or replace | `Ctrl/Cmd + F`; replace with `Ctrl + H` (Windows/Linux) or `Cmd + Option + F` (macOS) |
| Jump to a line | Enter a line number in the toolbar and press `Enter` |
| Add a line break in a table cell | `Shift + Enter` |
| Choose a change baseline | Open **More**, then select Current Edits, Recent Save, or Git HEAD |
| Export HTML or PDF | Open **Preview**, then use the export control |

## Configuration and appearance

Open VS Code Settings and search for **MEO Enhanced** to choose the interface language, Editor and Preview appearance, Preview font and code colors, outline position, content width, large-document behavior, change baseline, and pasted-image folder.

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
