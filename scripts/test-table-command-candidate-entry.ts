import {
  createTableCommandApplication,
  type TableCommand,
  type TableCommandEffect
} from '../webview/src/application/tableCommand';

const application = createTableCommandApplication();
const effectLog: TableCommandEffect[] = [];
const target = { tableId: 'candidate-table', row: 1, column: 0 } as const;

const run = (effects: readonly TableCommandEffect[]) => {
  effectLog.push(...effects);
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
  button.addEventListener('pointerdown', () => {
    run(application.dispatch({
      type: 'request',
      command: button.dataset.command as TableCommand,
      target,
      enabled: !button.disabled
    }));
  });
}

(globalThis as typeof globalThis & {
  TableCommandCandidate?: {
    instances: number;
    legacyInstances: number;
    effects(): readonly TableCommandEffect[];
    state: typeof application.getState;
    dispatch: typeof application.dispatch;
    run: typeof run;
  };
}).TableCommandCandidate = {
  instances: 1,
  legacyInstances: 0,
  effects: () => [...effectLog],
  state: application.getState,
  dispatch: application.dispatch,
  run
};
