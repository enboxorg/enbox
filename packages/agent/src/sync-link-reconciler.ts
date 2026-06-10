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
  hasActionableDiffs?: boolean;
  ignoredLocalCids?: string[];
  localRoot?: string;
  remoteRoot?: string;
  postLocalRoot?: string;
  postRemoteRoot?: string;
  converged?: boolean;
  admittedCids?: string[];
  pushResult?: PushResult;
};

type PushMessageFilterResult = {
  ignoredCids: string[];
  messageCids: string[];
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
  admitRemoteMessages: (params: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: string[];
    messageCids: string[];
    prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[];
    shouldContinue?: () => boolean;
  }) => Promise<string[]>;
  pushMessages: (params: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: string[];
    messageCids: string[];
  }) => Promise<PushResult>;
  filterPushMessageCids?: (params: {
    did: string;
    dwnUrl: string;
    messageCids: string[];
  }) => Promise<PushMessageFilterResult>;
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
    } else if (needsIndividualFetchForData(entry)) {
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
    let hasActionableDiffs = false;
    const ignoredLocalCids: string[] = [];
    const admittedCids: string[] = [];
    let pushResult: PushResult | undefined;

    if (localRoot !== remoteRoot) {
      const diff = await this._deps.diffWithRemote(target);
      if (shouldContinue && !shouldContinue()) { return { aborted: true, changed: true, didPull: false, didPush: false, localRoot, remoteRoot }; }

      if ((!direction || direction === 'pull') && diff.onlyRemote.length > 0) {
        hasActionableDiffs = true;
        const { prefetched, needsFetchCids } = partitionRemoteEntries(diff.onlyRemote);
        try {
          admittedCids.push(...await this._deps.admitRemoteMessages({
            did,
            dwnUrl,
            delegateDid,
            protocol,
            permissionGrantIds,
            messageCids: needsFetchCids,
            prefetched,
            shouldContinue,
          }));
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
        const filterResult = await this.filterPushMessageCids(did, dwnUrl, diff.onlyLocal);
        ignoredLocalCids.push(...filterResult.ignoredCids);
        if (filterResult.messageCids.length === 0) {
          if (shouldContinue && !shouldContinue()) {
            return { aborted: true, changed: true, didPull, didPush: false, hasActionableDiffs, ignoredLocalCids, localRoot, remoteRoot };
          }
        } else {
          hasActionableDiffs = true;
          pushResult = await this._deps.pushMessages({
            did, dwnUrl, delegateDid, protocol, permissionGrantIds, messageCids: filterResult.messageCids,
          });
          if (shouldContinue && !shouldContinue()) {
            return { aborted: true, changed: true, didPull, didPush: true, hasActionableDiffs, ignoredLocalCids, localRoot, remoteRoot, pushResult };
          }
          didPush = true;
        }
      }
    }

    if (!verifyConvergence) {
      return {
        changed: localRoot !== remoteRoot,
        didPull,
        didPush,
        hasActionableDiffs,
        ignoredLocalCids,
        localRoot,
        remoteRoot,
        admittedCids,
        pushResult,
      };
    }

    const postLocalRoot = await this._deps.getLocalRoot(did, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) {
      return {
        aborted: true, changed: localRoot !== remoteRoot, didPull, didPush, hasActionableDiffs, ignoredLocalCids, localRoot, remoteRoot, pushResult,
      };
    }

    const postRemoteRoot = await this._deps.getRemoteRoot(did, dwnUrl, delegateDid, protocol, permissionGrantIds);
    if (shouldContinue && !shouldContinue()) {
      return {
        aborted: true, changed: localRoot !== remoteRoot, didPull, didPush, hasActionableDiffs, ignoredLocalCids, localRoot, remoteRoot, pushResult,
      };
    }

    return {
      changed   : localRoot !== remoteRoot,
      didPull,
      didPush,
      hasActionableDiffs,
      ignoredLocalCids,
      localRoot,
      remoteRoot,
      postLocalRoot,
      postRemoteRoot,
      converged : postLocalRoot === postRemoteRoot,
      admittedCids,
      pushResult,
    };
  }

  private async filterPushMessageCids(did: string, dwnUrl: string, messageCids: string[]): Promise<PushMessageFilterResult> {
    if (this._deps.filterPushMessageCids === undefined) {
      return { ignoredCids: [], messageCids };
    }

    return this._deps.filterPushMessageCids({ did, dwnUrl, messageCids });
  }
}

function needsIndividualFetchForData(entry: MessagesSyncDiffEntry): boolean {
  const message = entry.message;
  if (message === undefined) {
    return false;
  }

  const { descriptor } = message;
  if (descriptor.interface !== 'Records' || descriptor.method !== 'Write') {
    return false;
  }

  return typeof (descriptor as { dataCid?: unknown }).dataCid === 'string' && entry.encodedData === undefined;
}
