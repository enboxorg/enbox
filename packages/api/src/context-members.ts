import type { RecordView } from './record-view.js';

import { projectRecordView } from './record-view.js';

/** Immutable state of one owned context's current membership. */
export type ContextMemberViewState<Member> = Readonly<{
  members: readonly Member[];
}> & Readonly<
  | { status: 'loading' | 'ready' | 'stale'; error?: never }
  | { status: 'error'; error: Error }
>;

/** Closeable materialized view of one owned context's current membership. */
export interface ContextMemberView<Member> {
  getState: () => ContextMemberViewState<Member>;
  subscribe(listener: (state: ContextMemberViewState<Member>) => void): () => void;
  close(): Promise<void>;
}

/** @internal Rename a generic records collection at the membership boundary. */
export function projectContextMemberView<Member>(
  view: RecordView<Member>,
): ContextMemberView<Member> {
  return projectRecordView(view, (state): ContextMemberViewState<Member> => Object.freeze({
    ...(state.status === 'error' ? { error: state.error } : {}),
    members : state.records,
    status  : state.status,
  }) as ContextMemberViewState<Member>);
}
