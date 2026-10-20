import type { ElkLayoutArguments, ElkNode } from 'elkjs/lib/elk-api';

export type ElkLayoutRequest = { readonly id: number; readonly graph: ElkNode; readonly options?: ElkLayoutArguments };
export type ElkLayoutResponse = { readonly id: number } & (
  | { readonly graph: ElkNode; readonly error?: never }
  | { readonly error: string; readonly graph?: never }
);

/** Official elk-worker.min.js protocol. Registration precedes all layouts. */
export type NativeElkWorkerRequest =
  | { readonly id: 0; readonly cmd: 'register'; readonly algorithms: readonly string[] }
  | { readonly id: number; readonly cmd: 'layout'; readonly graph: ElkNode;
      readonly layoutOptions: NonNullable<ElkLayoutArguments['layoutOptions']>;
      readonly options: { readonly logging: boolean; readonly measureExecutionTime: boolean } };
export type NativeElkWorkerResponse = { readonly id: number; readonly data?: ElkNode; readonly error?: unknown };
