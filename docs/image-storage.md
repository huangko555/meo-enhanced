# 粘贴图片的保存目录 / Pasted image folders

打开编辑器的 **设置 → 输入 → 粘贴 → 图片保存位置**：

- **文档旁的文件夹（默认）**：输入 assets、images/screenshots 等文件夹名称。
- **按文档分开**：自动追加不含扩展名的文档名。例如 draft.md 使用 assets/draft。
- **高级**：输入绝对目录、相对当前文档的目录或变量规则；“选择文件夹”打开系统目录选择器，点击变量按钮可插入变量。

固定的 ~/ 表示当前 Markdown 所在文件夹，只用于界面提示。无需工作区。有效修改自动保存；既有图片不会移动。未保存文档需要先保存为本地 Markdown 文件，再粘贴图片。

| 变量 | 对 /notes/draft.md 的值 |
| --- | --- |
| ${fileDirname} | /notes |
| ${fileBasename} | draft.md |
| ${fileBasenameNoExtension} | draft |
| ${fileExtname} | .md |

例如 ${fileDirname}/images/${fileBasenameNoExtension} 对应 /notes/images/draft。高级相对路径（如 ../images）以文档目录为起点。插入的 Markdown 优先使用相对路径；Windows 跨盘目录使用绝对路径。保存不覆盖同名文件，不允许通过符号链接或目录联接重定向。

## VS Code 配置

新设置保存模式以及两种输入的值：

    "meoEnhanced.imageStorage": {
      "mode": "perDocument",
      "folder": "assets",
      "rule": "${fileDirname}/assets"
    }

mode 可为 default、perDocument、advanced。前两种使用 folder，高级使用 rule。imageStorage 未设置或为 null 时，保留旧 imageFolder 的原有位置，包括其工作区相对规则。设置窗口只展示旧规则实际位置，主动修改后才启用新规则。没有旧配置时默认使用文档旁的 assets。

通常写入 VS Code 用户设置；已有显式文件夹/工作区覆盖时自动保持其作用域。无效规则不替换上次有效设置。选择目录后，直到下一次粘贴才会写入图片。

## English

Open **Settings → Input → Paste → Image save location**. Choose a folder beside the Markdown file, separate images by the document's file name, or use an advanced path rule with the four variables above. Choose folder opens the native directory picker.

The fixed ~/ prefix means the current Markdown folder. No workspace is needed. Valid changes save automatically, and existing images stay in place. Save untitled documents as local Markdown files before pasting.

Relative advanced rules use the Markdown directory. Absolute paths are supported, including Windows folders on another drive. Existing files are never overwritten; symbolic links and directory junctions are rejected. An absent/null imageStorage preserves the legacy imageFolder behavior until you edit the new controls. Changes normally use user settings; existing explicit folder/workspace overrides keep their scope.
