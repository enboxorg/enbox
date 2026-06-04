import type { GenericMessage, MessagesSyncDiffEntry } from '@enbox/dwn-sdk-js';

import type { PushResult } from './types/sync.js';

import { SyncPullAbortedError } from './sync-messages.js';

export type ReconcileDirection = 'pull' | 'push';

export type ReconcileTarget = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  permissionGrantIds?: string[];
};

export type ReconcileOutcome = {
  aborted?: boolean;
  changed: boolean;
  didPull: boolean;
  didPush: boolean;
  localRoot?: string;
  remoteRoot?: string;
  postLocalRoot?: string;
  postRemoteRoot?: string;
  converged?: boolean;
  pushResult?: PushResult;
};

type ReconcileDeps = {
  getLocalRoot: (
    did: string,
    delegateDid?: string,
    protocol?: string,
    permissionGrantIds?: string[],
  ) => Promise<string>;
  getRemoteRoot: (
    did: string,
    dwnUrl: string,
    delegateDid?: string,
    protocol?: string,
    permissionGrantIds?: string[],
  ) => Promise<string>;
  diffWithRemote: (target: ReconcileTarget) => Promise<{ onlyRemote: MessagesSyncDiffEntry[]; onlyLocal: string[] }>;
  pullMessages: (params: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: string[];
    messageCids: string[];
    prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[];
    shouldContinue?: () => boolean;
  }) => Promise<void>;
  pushMessages: (params: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: string[];
    messageCids: string[];
  }) => Promise<PushResult>;
  shouldContinue?: () => boolean;
};

export function partitionRemoteEntries(entries: MessagesSyncDiffEntry[]): {
  prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[];
  needsFetchCids: string[];
} {
  const prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[] = [];
  const needsFetchCids: string[] = [];

  for (const entry of entries) {
    if (!entry.message) {
      needsFetchCids.push(entry.messageCid);
    } else if (
      entry.message.descriptor.interface === 'Records' &&
      entry.message.descriptor.method === 'Write' &&
      (entry.message.descriptor as any).dataCid &&
      !entry.encodedData
    ) {
      needsFetchCids.push(entry.messageCid);
    } else {
      prefetched.push(entry as MessagesSyncDiffEntry & { message: GenericMessage });
    }
  }

  return { prefetched, needsFetchCids };
}

export class SyncLinkReconciler {
  private readonly _deps: ReconcileDeps;

  constructor(deps: ReconcileDeps) {
    this._deps = deps;
  }

  public async reconcile(target: ReconcileTarget, options?: {
    direction?: ReconcileDirection;
    verifyConvergence?: boolean;
  }): Promise<ReconcileOutcome> {
    const { did, dwnUrl, delegateDid, protocol, permissionGrantIds } = target;
    const direction = options?.direction;
    const verifyConvergence = options?.verifyConvergence ?? false;
    const shouldContinue = this._deps.shouldContinue;

    const localRoot = await this._deps.getLocalRoot(did, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) { return { aborted: true, changed: false, didPull: false, didPush: false }; }

    const remoteRoot = await this._deps.getRemoteRoot(did, dwnUrl, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) { return { aborted: true, changed: false, didPull: false, didPush: false }; }

    let didPull = false;
    let didPush = false;
    let pushResult: PushResult | undefined;

    if (localRoot !== remoteRoot) {
      const diff = await this._deps.diffWithRemote(target);
      if (shouldContinue && !shouldContinue()) { return { aborted: true, changed: true, didPull: false, didPush: false, localRoot, remoteRoot }; }

      if ((!direction || direction === 'pull') && diff.onlyRemote.length > 0) {
        const { prefetched, needsFetchCids } = partitionRemoteEntries(diff.onlyRemote);
        try {
          await this._deps.pullMessages({
            did,
            dwnUrl,
            delegateDid,
            protocol,
            permissionGrantIds,
            messageCids: needsFetchCids,
            prefetched,
            shouldContinue,
          });
        } catch (error) {
          if (error instanceof SyncPullAbortedError) {
            return { aborted: true, changed: true, didPull: false, didPush: false, localRoot, remoteRoot };
          }
          throw error;
        }
        if (shouldContinue && !shouldContinue()) { return { aborted: true, changed: true, didPull: true, didPush: false, localRoot, remoteRoot }; }
        didPull = true;
      }

      if ((!direction || direction === 'push') && diff.onlyLocal.length > 0) {
        pushResult = await this._deps.pushMessages({
          did, dwnUrl, delegateDid, protocol, permissionGrantIds, messageCids: diff.onlyLocal,
        });
        if (shouldContinue && !shouldContinue()) {
          return { aborted: true, changed: true, didPull, didPush: true, localRoot, remoteRoot, pushResult };
        }
        didPush = true;
      }
    }

    if (!verifyConvergence) {
      return {
        changed: localRoot !== remoteRoot,
        didPull,
        didPush,
        localRoot,
        remoteRoot,
        pushResult,
      };
    }

    const postLocalRoot = await this._deps.getLocalRoot(did, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) {
      return { aborted: true, changed: localRoot !== remoteRoot, didPull, didPush, localRoot, remoteRoot, pushResult };
    }

    const postRemoteRoot = await this._deps.getRemoteRoot(did, dwnUrl, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) {
      return { aborted: true, changed: localRoot !== remoteRoot, didPull, didPush, localRoot, remoteRoot, pushResult };
    }

    return {
      changed   : localRoot !== remoteRoot,
      didPull,
      didPush,
      localRoot,
      remoteRoot,
      postLocalRoot,
      postRemoteRoot,
      converged : postLocalRoot === postRemoteRoot,
      pushResult,
    };
  }
}
