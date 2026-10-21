import assert from 'node:assert/strict';

/** Computed SVG fills are RGB, so this checks the colors the reader actually sees. */
export function assertReadableMermaidTasks(tasks: Array<{ background: string; foreground: string; outside: boolean }>, context: string) {
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
  };
  assert.ok(tasks.some(task => !task.outside), `${context}: fixture must include text inside a task bar`);
  for (const task of tasks.filter(task => !task.outside)) {
    const [high, low] = [luminance(task.background), luminance(task.foreground)].sort((a, b) => b - a);
    const ratio = (high! + 0.05) / (low! + 0.05);
    assert.ok(ratio >= 4.5, `${context}: unreadable task label (${ratio.toFixed(2)}:1): ${JSON.stringify(task)}`);
  }
}
