# 粘贴图片的保存目录与命名 / Pasted image folders and names

打开编辑器的 **设置 → 输入 → 粘贴 → 图片保存位置**：

- **文档旁的文件夹（默认）**：输入 assets、images/screenshots 等文件夹名称。
- **文档旁，按文档名分开**：图片仍保存在文档旁，自动追加不含扩展名的文档名。例如 draft.md 使用 ./assets/draft。
- **自定义路径（高级）**：输入绝对目录、相对当前文档的目录或变量规则；“选择文件夹”打开系统目录选择器，点击变量按钮可插入变量。

选中某一项后，路径控件就在该选项下面展开。前两项的固定前缀 ./ 表示当前 Markdown 文档所在目录，不可编辑。无需工作区。有效修改自动保存；既有图片不会移动。未保存文档需要先保存为本地 Markdown 文件，再粘贴图片。

| 变量 | 对 /notes/draft.md 的值 |
| --- | --- |
| ${fileDirname} | /notes |
| ${fileBasename} | draft.md |
| ${fileBasenameNoExtension} | draft |
| ${fileExtname} | .md |

例如 ${fileDirname}/images/${fileBasenameNoExtension} 对应 /notes/images/draft。高级相对路径（如 ../images）以文档目录为起点。插入的 Markdown 优先使用相对路径；Windows 跨盘目录使用绝对路径。保存不覆盖同名文件，不允许通过符号链接或目录联接重定向。

## 图片命名

同一设置项下提供四种命名预设，保存示例显示完整路径：

| 预设 | 示例 |
| --- | --- |
| 日期时间 | `2026-10-20-143025.png`（本地时间） |
| 图片序号 | `image-1.png`、`image-2.png` |
| 文档名＋序号（默认） | `设计方案.md` 中生成 `设计方案-1.png`、`设计方案-2.png` |
| 毫秒时间戳 | `1792477825000.png` |

未配置命名规则时默认使用文档名＋序号。序号从目标目录内同前缀图片的最大编号继续，不区分图片格式；并发重名自动递增且不覆盖。删除图片不整理编号。日期时间和时间戳重名时追加数字后缀。

命名规则只影响新粘贴的图片。文档改名后，新图片采用新文档名，旧图片和链接保持原样。扩展名由实际图片类型决定，设置预览中的 `.png` 仅为示例。中文路径保持可读；空格、括号、百分号等字符在插入的 Markdown 目标中正确转义。文档名中的跨平台非法文件名字符替换为 `-`。

## VS Code 配置

已有图片的读取不受粘贴保存目录设置影响。普通 Markdown 和 HTML 图片先按文档目录查找；未命中的裸相对路径再尝试最近的 `.obsidian` 仓库根目录，或当前文档所属工作区。识别到仓库后不再尝试外层工作区。显式 `./`、`../` 及绝对路径保持原意；同名图片优先使用文档目录中的文件。预览、外部打开和 HTML/PDF/Word 导出使用相同规则，不改写文档中的链接。

新设置保存模式以及两种输入的值：

    "meoEnhanced.imageStorage": {
      "mode": "perDocument",
      "folder": "assets",
      "rule": "${fileDirname}/assets",
      "naming": "documentSequence"
    }

mode 可为 default、perDocument、advanced。前两种使用 folder，高级使用 rule。imageStorage 未设置或为 null 时，保留旧 imageFolder 的原有位置，包括其工作区相对规则。设置窗口只展示旧规则实际位置，主动修改后才启用新规则。没有旧配置时默认使用文档旁的 assets。

`naming` 可为 `dateTime`、`imageSequence`、`documentSequence`、`timestamp`，省略时为 `documentSequence`。调整命名时沿用当前显示的保存目录。

通常写入 VS Code 用户设置；已有显式文件夹/工作区覆盖时自动保持其作用域。无效规则不替换上次有效设置。选择目录后，直到下一次粘贴才会写入图片。

## English

Existing Markdown and HTML images resolve beside the document first. Missing bare relative paths fall back to the nearest `.obsidian` vault root, or the document's owning workspace. A detected vault takes precedence over an outer workspace. Explicit `./`, `../` and absolute paths retain their meaning. Preview, external image opening and HTML/PDF/Word export share this behavior without rewriting links or using the paste-folder setting.

Open **Settings → Input → Paste → Image save location**. Choose a folder beside the Markdown file, separate images by the document's file name, or use an advanced path rule with the four variables above. Choose folder opens the native directory picker.

Each selected option expands its path controls directly below its label. The fixed ./ prefix in the first two options starts in the current Markdown directory and cannot be edited. No workspace is needed. Valid changes save automatically, and existing images stay in place. Save untitled documents as local Markdown files before pasting.

Image naming offers Date and time, Image number, Document name + number (default), and Timestamp in milliseconds. A full-path PNG example reflects the selected rule; actual extensions follow the pasted image format. Numbered names continue after the largest matching image number in the target folder across formats, including after reopening. Concurrent collisions increment without overwriting files. Document renames affect only new images. Chinese paths remain readable, with Markdown syntax characters escaped on insertion. Existing directory settings and images are retained; missing naming settings use the document-name default.

Relative advanced rules use the Markdown directory. Absolute paths are supported, including Windows folders on another drive. Existing files are never overwritten; symbolic links and directory junctions are rejected. An absent/null imageStorage preserves the legacy imageFolder behavior until you edit the new controls. Changes normally use user settings; existing explicit folder/workspace overrides keep their scope.
