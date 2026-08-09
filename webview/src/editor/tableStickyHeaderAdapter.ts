export type TableWidgetLayoutRegistration = {
  request(): void;
  dispose(): void;
};

export type TableWidgetLayoutScheduler = {
  register(task: () => void): TableWidgetLayoutRegistration;
};

/** Editor-internal lifecycle seam. DOM and scheduling details stay in the concrete adapter. */
export type TableStickyHeaderAdapter = {
  mount(): void;
  update(): void;
  invalidate(): void;
  refreshContent(): void;
  unmount(): void;
  dispose(): void;
};
