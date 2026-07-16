# 文档行级 Diff 策略调研

日期：2026-07-17

## 实施记录

项目采用固定版本 `vscode-diff@3.0.1` 作为 `DefaultLinesDiffComputer` 的最小、零依赖分发，而不是引入完整 Monaco。颜色只按 VS Code Quick Diff 的范围语义分类。由于当前 gutter 仍在浏览器主线程同步计算，单次预算收紧为 50ms；超时结果不渲染，现有 1MB / 1200 行上限继续作为外层保护。若未来需要扩大文件上限，再单独迁移到 worker，而不修改颜色判定规则。

## 结论

推荐停止继续修补现有自研 LCS/空行配对规则，改为采用 **VS Code Advanced Quick Diff 的端到端语义**：Advanced Diff 只负责产出“基线范围 ↔ 当前范围”的 change；随后统一按范围是否为空分类红、蓝、绿。这个方案已经覆盖当前问题的关键难点：重复空行只是弱锚点，较长非空行是强锚点，修改行可以直接配对，并且有成熟的超时和大文件降级。

不建议引入整个 Monaco。更合适的是从 VS Code 的 MIT 源码中提取 `DefaultLinesDiffComputer` 所需的最小算法模块，固定一个上游版本并保留来源说明；本项目继续使用 CodeMirror 和现有 gutter，只替换 diff 核心及分类入口。

## 成熟实现的做法

### VS Code / Monaco（主推荐）

VS Code 的 [`DefaultLinesDiffComputer`](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts) 对总行数小于 1700 的输入使用带权动态规划：相同空行得分 `0.1`，相同非空行得分 `1 + log(1 + 行长)`，不相同的行仍可按 `0.99` 配对为修改；大输入改用 Myers。它随后进行字符级细化和多轮可读性清理，而不是在最终红绿结果上补特殊规则。其 [`LinesDiff`](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/diff/linesDiffComputer.ts) 还显式返回 `hitTimeout`。

Quick Diff 的分类非常简单且稳定：[`getChangeType`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/common/quickDiff.ts#L115-L129) 中原范围为空是 Add，当前范围为空是 Delete，两边均非空就是 Modify。装饰层再分别绘制新增、删除和修改，删除定位在当前文档的 gap，而不是伪造一条当前行。Quick Diff 本身使用 [`200ms ThrottledDelayer`、worker、Advanced 算法和 1000ms 上限](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/quickDiffModel.ts)。Monaco 公共 API 还提供 `maxComputationTime`（默认 5000ms）和 `maxFileSize`（默认 50MB）作为更外层保护。[Monaco Diff Editor API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.IDiffEditorOptions.html)

这套带权策略正好解释当前截图：长文本行会被稳定对齐；它前面的两个空行仍是删除，按回车产生的空行是长文本行之后的新增，不应把长文本行改判为蓝色或移动删除 gap。

### CodeMirror Merge

[`@codemirror/merge`](https://codemirror.net/docs/ref/#merge) 与本项目技术栈最接近，提供 `Chunk.build/updateA/updateB`、`precise` 标记、`scanLimit`（Merge 默认 500）和超时降级。其 [`Chunk` 源码](https://github.com/codemirror/merge/blob/main/src/chunk.ts) 会在编辑后只重算变更周围约 1000 字符；Unified View 还能显示删除块。

但它是字符优先的通用 Merge 模型，“修改行”属于展示推断：官方 inline 策略只接受少于 10 行、两边行数相同、删除不跨换行且变化量不过大的 chunk。[Unified View 源码](https://github.com/codemirror/merge/blob/main/src/unified.ts) 直接套用会使“清空一行但保留换行”等场景仍可能显示为删加。因此可借鉴其增量更新和降级设计，不宜用它取代 VS Code Quick Diff 的红蓝绿语义。

### Git、jsdiff、diff-match-patch

Git 的 patch 本质只有 `+`、`-` 和上下文；Myers、minimal、patience、histogram 改善的是公共子序列及 hunk 可读性，并不定义蓝色 Modify。[Git diff algorithms](https://git-scm.com/docs/diff-algorithm-option.html) Git 还明确说明 word diff 是先做行 diff，再在 hunk 内做词级变化。[git-diff](https://git-scm.com/docs/git-diff.html) 因此它不能单独解决当前分类。

[`jsdiff`](https://github.com/kpdecker/jsdiff) 提供 Myers、`newlineIsToken`、timeout 和 `maxEditLength`，但行模式仍只返回 add/remove/common，蓝色配对仍要自研。Google [`diff-match-patch`](https://github.com/google/diff-match-patch) 是字符级 Myers 加清理，行模式通过把每行编码成字符实现，且仓库已归档；同样缺少 Quick Diff 的行范围分类和增量模型。

## 推荐落地架构

1. `AdvancedDiffEngine`：输入基线/当前文本，输出 VS Code 风格 `LineRangeMapping[]`、字符级 `innerChanges`、`hitTimeout`；不要在这里产生颜色。
2. `QuickDiffClassifier`：唯一分类入口。原范围空 → 绿；当前范围空 → 红色 gap；两边非空 → 当前范围全部蓝色。一个连续删除 hunk 只产生一个三角，悬停展示该原范围完整内容。
3. `GutterAdapter`：把 change 映射到现有 CodeMirror 行、Live Mermaid/公式块和 overview ruler；渲染层不得重新配对行。
4. 性能策略与 VS Code 对齐：编辑后 200ms 节流；在 worker 中计算；单次 1000ms 上限；超时则标记结果不精确并采用粗粒度 hunk，不能继续运行更昂贵的补救算法。超大文件再设置硬上限或仅在可见请求时计算。
5. 删除现有按窗口、空行、相邻位置不断叠加的判定补丁。迁移前建立固定语料：重复空行、连续修改、多行替换、清空但保留行、拆/并行、文首/文尾、Mermaid/公式块、超时降级；同一语料同时验证 change 范围和最终颜色。

## 语义边界

纯快照 diff 无法证明用户的历史操作。例如两行内容被完全替换，与“删两行再插两行”可能得到相同快照。成熟方案对此采用一致的展示约定，而不是宣称恢复真实意图：Advanced Quick Diff 在一个 change 两侧均非空时显示 Modify。若将来必须表达真实编辑动作，应额外记录 CodeMirror transaction 日志；这属于另一层 provenance 功能，不应混入快照 diff 算法。
