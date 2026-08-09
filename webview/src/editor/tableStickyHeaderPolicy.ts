export type TableStickyHeaderGeometry = {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly height: number;
};

export type TableStickyHeaderLayoutInput = {
  readonly scroller: TableStickyHeaderGeometry;
  readonly table: TableStickyHeaderGeometry & {
    readonly bottom: number;
    readonly width: number;
  };
  readonly header: {
    readonly top: number;
    readonly height: number;
  };
  readonly controlsVisible: boolean;
};

export type TableStickyHeaderLayout =
  | {
    readonly visible: false;
    readonly reason:
      | 'table-too-short'
      | 'before-threshold'
      | 'insufficient-content'
      | 'outside-horizontal-viewport';
  }
  | {
    readonly visible: true;
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly headerHeight: number;
    readonly tableWidth: number;
    readonly translateX: number;
    readonly controlsHeight: number;
  };

export type TableStickyHeaderPolicy = {
  layout(input: TableStickyHeaderLayoutInput): TableStickyHeaderLayout;
};

const minimumTableViewportRatio = 0.5;
const toolbarHeight = 24;
const separatorDepth = 3;

export const tableStickyHeaderPolicy: TableStickyHeaderPolicy = {
  layout(input) {
    const controlsHeight = input.controlsVisible ? toolbarHeight : 0;
    const stickyHeaderTop = input.scroller.top + controlsHeight;
    if (input.table.height < input.scroller.height * minimumTableViewportRatio) {
      return { visible: false, reason: 'table-too-short' };
    }
    if (input.header.top > stickyHeaderTop) {
      return { visible: false, reason: 'before-threshold' };
    }
    const enoughContentRemains = (
      input.table.bottom >= stickyHeaderTop + input.header.height + separatorDepth
    );
    if (!enoughContentRemains) {
      return { visible: false, reason: 'insufficient-content' };
    }

    const visibleLeft = Math.max(input.table.left, input.scroller.left);
    const visibleRight = Math.min(input.table.right, input.scroller.right);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    if (visibleWidth <= 0) {
      return { visible: false, reason: 'outside-horizontal-viewport' };
    }

    return {
      visible: true,
      top: Math.round(input.scroller.top),
      left: Math.round(visibleLeft),
      width: Math.round(visibleWidth),
      height: Math.ceil(controlsHeight + input.header.height + separatorDepth),
      headerHeight: Math.ceil(input.header.height),
      tableWidth: input.table.width,
      translateX: input.table.left - visibleLeft,
      controlsHeight
    };
  }
};
