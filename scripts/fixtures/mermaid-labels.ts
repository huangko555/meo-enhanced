const longEdge = 'VERY_LONG_RELATIONSHIP_LABEL_THAT_NEEDS_TO_WRAP';

export const mermaidLabelSamples = [
  {
    source: `flowchart TD
    A[very long text] --> B(VERY_LONG_TEXT)
    A --> C(VERY-LONG-TEXT)
    A -->|${longEdge}| D[WWWWWWWWWWWWW]
    D --> E[lowercase_identifier_that_also_needs_to_wrap]`,
    labels: ['VERY_LONG_TEXT', 'VERY-LONG-TEXT', longEdge, 'WWWWWWWWWWWWW', 'lowercase_identifier_that_also_needs_to_wrap']
  },
  {
    source: `erDiagram
    "very long text" ||--o{ VERY_LONG_TEXT : "  "
    VERY_LONG_TEXT ||--o{ VERY-LONG-TEXT : ${longEdge}`,
    labels: ['VERY_LONG_TEXT', 'VERY-LONG-TEXT', longEdge]
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
flowchart TD
  A[EXPLICIT_WRAP_WIDTH] --> B[very long text very long text]`,
    labels: ['EXPLICIT_WRAP_WIDTH'],
    width: 80
  }
] as const;
