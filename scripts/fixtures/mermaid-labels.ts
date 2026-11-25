const longEdge = 'VERY_LONG_RELATIONSHIP_LABEL_THAT_NEEDS_TO_WRAP_BEFORE_THE_SETTLEMENT_RECORD_IS_PUBLISHED';
const prose = 'Validate the incoming payment before publishing the settlement record';
const chinese = '读取配置后核对环境变量并生成生产发布审计记录';
const sentenceWithIdentifier = 'Run VERY_LONG_TEXT before publishing the settlement record';
const hardBreak = 'First line<br/>Second line';
const continuous = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const mermaidLabelSamples = [
  {
    source: `flowchart TD
    A[Start] --> B(VERY_LONG_TEXT)
    A --> C(VERY-LONG-TEXT)
    A -->|${longEdge}| D[WWWWWWWWWWWWW]
    D --> E[lowercase_identifier_that_also_needs_to_wrap]
    F["${sentenceWithIdentifier}"]
    G["${continuous}"]`,
    labels: ['Start', 'VERY_LONG_TEXT', 'VERY-LONG-TEXT', longEdge, 'WWWWWWWWWWWWW', 'lowercase_identifier_that_also_needs_to_wrap', sentenceWithIdentifier, continuous],
    centered: ['Start'],
    singleLine: ['VERY_LONG_TEXT', 'VERY-LONG-TEXT', 'WWWWWWWWWWWWW'],
    wrapped: [longEdge, sentenceWithIdentifier, continuous],
    intactWords: ['VERY_LONG_TEXT']
  },
  {
    source: `erDiagram
    "very long text" ||--o{ VERY_LONG_TEXT : "  "
    VERY_LONG_TEXT ||--o{ VERY-LONG-TEXT : ${longEdge}`,
    labels: ['VERY_LONG_TEXT', 'VERY-LONG-TEXT', longEdge],
    singleLine: ['VERY_LONG_TEXT', 'VERY-LONG-TEXT']
  },
  {
    source: `stateDiagram-v2
    state "STATE_WITH_A_LONG_UNBROKEN_LABEL" as editing
    [*] --> editing : ${longEdge}`,
    labels: ['STATE_WITH_A_LONG_UNBROKEN_LABEL', longEdge]
  },
  {
    source: `---
config:
  layout: dagre
  flowchart:
    wrappingWidth: 80
---
flowchart LR
  A[EXPLICIT_WRAP_WIDTH] --> B["${hardBreak}"]`,
    labels: ['EXPLICIT_WRAP_WIDTH', 'First lineSecond line'],
    centered: ['EXPLICIT_WRAP_WIDTH', 'First lineSecond line'],
    width: 80
  },
  {
    source: `flowchart TD
    A["${prose}"] --> B["${chinese}"]
    B --> C["${hardBreak}"]`,
    labels: [prose, chinese, 'First lineSecond line'],
    wrapped: [prose, chinese, 'First lineSecond line']
  }
] as const;
