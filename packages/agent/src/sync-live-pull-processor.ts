import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { GenericMessage, MessageEvent, ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncEchoSuppressor } from './sync-echo-suppressor.js';
import type { SyncLinkController } from './sync-link-controller.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { AdmitClosureDeps, AdmitOutcome, SyncFreshEntry } from './sync-admit-closure.js';
import type {
  DeadLetterEntry,
  NonEmptyStringArray,
  ReplicationLinkState,
  SyncEvent,
  SyncEventScope,
} from './types/sync.js';

import { Encoder, Message } from '@enbox/dwn-sdk-js';

import { admitClosure } from './sync-admit-closure.js';
import { classifySyncEventScope } from './sync-scope-acceptance.js';
import { isRecordsWrite } from './utils.js';
import { isTerminalSyncAuthorizationFailure } from './sync-runtime-errors.js';
import { SyncCheckpoint } from './sync-checkpoint.js';
import { syncTargetFromLink } from './sync-target-resolver.js';
import { dataStreamFromBytes, fetchRemoteMessages, syncMessageDescriptor } from './sync-messages.js';

export type SyncLivePullContext = {
  controller: SyncLinkController;
  delegateDid?: string;
  did: string;
  dwnUrl: string;
  eventScope: SyncEventScope;
  isStale: () => boolean;
  link: ReplicationLinkState;
  linkKey: string;
  permissionGrantIds?: NonEmptyStringArray;
};

export interface SyncLivePullProcessorOperations {
  emitCheckpointAdvance(link: ReplicationLinkState): void;
  emitEvent(event: SyncEvent): void;
  getAgent(): EnboxPlatformAgent;
  getPermissionsApi(): PermissionsApi;
  persistCheckpoint(link: ReplicationLinkState): Promise<void>;
  recordDeadLetter(entry: Omit<DeadLetterEntry, 'failedAt'>): Promise<void>;
  reportError(message: string, error: unknown): void;
  trackAppliedCids(messageCids: string[], target: SyncTarget): Promise<void>;
  transitionToPaused(linkKey: string, link: ReplicationLinkState): Promise<void>;
  transitionToRepairing(controller: SyncLinkController): Promise<void>;
  warn(message: string): void;
}

export type SyncLivePullProcessorParams = {
  admit?: SyncLivePullAdmit;
  echoSuppressor: SyncEchoSuppressor;
  fetchMessages?: SyncLivePullFetchMessages;
  maxInFlightDeliveries?: number;
  operations: SyncLivePullProcessorOperations;
};

export type SyncLivePullAdmit = (rootCid: string, deps: AdmitClosureDeps) => Promise<AdmitOutcome>;
export type SyncLivePullFetchMessages = typeof fetchRemoteMessages;

type LivePullProcessResult =
  | { admitted: false; messageCid: string }
  | { admitted: true; appliedCids: string[]; messageCid: string; freshEntries: SyncFreshEntry[] };

type LivePullDataStreamFactory = () => Promise<ReadableStream<Uint8Array> | undefined>;

type LivePullRecordsWriteEvent = MessageEvent & {
  message: GenericMessage & {
    descriptor: GenericMessage['descriptor'] & { dataCid?: string };
  };
};

const DEFAULT_MAX_IN_FLIGHT_DELIVERIES = 100;

/**
 * Processes live remote subscription deliveries without depending on a
 * persistence backend. Durable checkpoint and engine transitions are supplied
 * as operations; per-link ordering remains owned by SyncLinkController.
 */
export class SyncLivePullProcessor {
  private readonly _admit: SyncLivePullAdmit;
  private readonly _echoSuppressor: SyncEchoSuppressor;
  private readonly _fetchMessages: SyncLivePullFetchMessages;
  private readonly _maxInFlightDeliveries: number;
  private readonly _operations: SyncLivePullProcessorOperations;

  public constructor({
    admit = admitClosure,
    echoSuppressor,
    fetchMessages = fetchRemoteMessages,
    maxInFlightDeliveries = DEFAULT_MAX_IN_FLIGHT_DELIVERIES,
    operations,
  }: SyncLivePullProcessorParams) {
    this._admit = admit;
    this._echoSuppressor = echoSuppressor;
    this._fetchMessages = fetchMessages;
    this._maxInFlightDeliveries = maxInFlightDeliveries;
    this._operations = operations;
  }

  /** Route one remote subscription delivery through its typed handler. */
  public async handleMessage(
    context: SyncLivePullContext,
    message: DwnSubscriptionMessage,
  ): Promise<void> {
    if (context.isStale()) {
      return;
    }

    // Transport lifecycle belongs to the socket: a lost connection detaches
    // the stream and marks this link offline; a verified resubscription
    // restores it. Terminal recovery failures arrive separately as `error`
    // messages and drive repair for this link only.
    if (message.type === 'disconnected' || message.type === 'reconnecting') {
      this.markLinkOffline(context);
      return;
    }
    if (message.type === 'reconnected') {
      this.markLinkOnline(context);
      return;
    }
    if (message.type === 'error') {
      await this.handleSubscriptionError(context, message);
      return;
    }

    // The transport invokes subscription handlers without awaiting them.
    // Claim a place in the controller's pull queue before doing any async
    // work so event and EOSE processing exactly follows feed arrival order.
    const queued = context.controller.enqueueDirection('pull', async (): Promise<void> => {
      if (context.isStale()) {
        return;
      }
      try {
        if (message.type === 'eose') {
          await this.handleEose(context, message);
        } else if (message.type === 'event') {
          await this.handleEvent(context, message);
        }
      } catch (error: unknown) {
        await this.handleProcessingError(context, error);
      }
    });

    if (context.controller.getPendingDirectionCount('pull') > this._maxInFlightDeliveries) {
      this._operations.warn(
        `SyncLivePullProcessor: Pull queue overflow for ${context.did} -> ${context.dwnUrl}, transitioning to repairing`,
      );
      await this._operations.transitionToRepairing(context.controller);
      return;
    }

    await queued;
  }

  /** Persist a validated catch-up boundary and mark the pull path online. */
  public async handleEose(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'eose' }>,
  ): Promise<void> {
    const { controller, did, dwnUrl, link, isStale } = context;
    if (link.status !== 'live' && link.status !== 'initializing') {
      return;
    }

    if (!SyncCheckpoint.validateTokenDomain(link.pull, message.cursor)) {
      this._operations.warn(
        `SyncLivePullProcessor: Token domain mismatch on EOSE for ${did} -> ${dwnUrl}, transitioning to repairing`,
      );
      if (!isStale()) {
        await this._operations.transitionToRepairing(controller);
      }
      return;
    }

    SyncCheckpoint.commitContiguousToken(link.pull, message.cursor);
    await this._operations.persistCheckpoint(link);
    if (isStale()) { return; }

    this._operations.emitCheckpointAdvance(link);
    this.markLinkOnline(context);
  }

  /** Pause terminal authorization errors and repair retryable subscription errors. */
  public async handleSubscriptionError(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'error' }>,
  ): Promise<void> {
    const { did, dwnUrl, link, linkKey, isStale } = context;
    if (isTerminalSyncAuthorizationFailure(String(message.error.code ?? ''))) {
      this._operations.warn(
        `SyncLivePullProcessor: sync authorization for ${did} -> ${dwnUrl} was revoked or expired — pausing link (reconnect to resume).`,
      );
      if (!isStale()) {
        await this._operations.transitionToPaused(linkKey, link);
      }
      return;
    }

    this._operations.warn(
      `SyncLivePullProcessor: subscription error for ${did} -> ${dwnUrl}: ${message.error.code}`,
    );
    if (!isStale()) {
      await this._operations.transitionToRepairing(context.controller);
    }
  }

  /** Apply or otherwise settle one live remote event inside its ordered pull turn. */
  public async handleEvent(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<void> {
    const { did, dwnUrl, link, isStale } = context;
    if (link.status !== 'live' && link.status !== 'initializing') {
      return;
    }

    if (!SyncCheckpoint.validateTokenDomain(link.pull, message.cursor)) {
      this._operations.warn(
        `SyncLivePullProcessor: Token domain mismatch for ${did} -> ${dwnUrl}, transitioning to repairing`,
      );
      if (!isStale()) {
        await this._operations.transitionToRepairing(context.controller);
      }
      return;
    }

    const classification = classifySyncEventScope(message.event, link.scope);
    if (classification === 'unknown') {
      this._operations.warn(
        `SyncLivePullProcessor: Unable to classify scoped pull event for ${did} -> ${dwnUrl}, transitioning to repair`,
      );
      if (!isStale()) {
        await this._operations.transitionToRepairing(context.controller);
      }
      return;
    }
    if (isStale()) {
      return;
    }

    if (classification === 'out-of-scope') {
      await this.commitEventCursor(context, message.cursor);
      return;
    }

    try {
      const messageCid = await Message.getCid(message.event.message);
      if (this._echoSuppressor.hasRecentlyPushed(context.did, messageCid, context.dwnUrl)) {
        await this.commitEventCursor(context, message.cursor);
        return;
      }

      const result = await this.processEvent(context, message, messageCid);
      if (result === undefined) { return; }

      if (result.admitted) {
        await this._operations.trackAppliedCids(
          result.appliedCids,
          syncTargetFromLink(context.link),
        );
        if (isStale()) { return; }
        // Fresh only: a Duplicate/Superseded apply (an echo of a message this
        // store already held, e.g. our own push looping back via another
        // endpoint) is not a remote change and must not signal consumers.
        // Every freshly-applied message announces — the delivered root AND
        // any fetched dependency (parent, role record, initial write) the
        // closure admitted alongside it, each with its own descriptor.
        for (const freshEntry of result.freshEntries) {
          this.emitDeliveryApplied(context, freshEntry.message, freshEntry.messageCid);
        }
      }
      await this.commitEventCursor(context, message.cursor);
    } catch (error: unknown) {
      await this.handleProcessingError(context, error);
    }
  }

  /** Announce one freshly-admitted applied message with its routing descriptor. */
  private emitDeliveryApplied(
    { did, dwnUrl, eventScope }: SyncLivePullContext,
    message: GenericMessage,
    messageCid: string,
  ): void {
    this._operations.emitEvent({
      type           : 'delivery:applied',
      tenantDid      : did,
      remoteEndpoint : dwnUrl,
      ...eventScope,
      messageCid,
      descriptor     : syncMessageDescriptor(message),
    });
  }

  private markLinkOnline({ did, dwnUrl, eventScope, link }: SyncLivePullContext): void {
    const previous = link.connectivity;
    link.connectivity = 'online';
    if (previous !== 'online') {
      this._operations.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : did,
        remoteEndpoint : dwnUrl,
        ...eventScope,
        from           : previous,
        to             : 'online',
      });
    }
  }

  private markLinkOffline({ did, dwnUrl, eventScope, link }: SyncLivePullContext): void {
    const previous = link.connectivity;
    link.connectivity = 'offline';
    if (previous !== 'offline') {
      this._operations.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : did,
        remoteEndpoint : dwnUrl,
        ...eventScope,
        from           : previous,
        to             : 'offline',
      });
    }
  }

  private async processEvent(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
    rootCid: string,
  ): Promise<LivePullProcessResult | undefined> {
    const event = message.event;
    const dataStreamFactory = await this.createDataStreamFactory(context, message);
    const prefetched: SyncMessageEntry[] = [{
      message           : event.message,
      dataStreamFactory,
      isLatestBaseState : message.isLatestBaseState,
    }];
    if (event.initialWrite !== undefined) {
      prefetched.push({ message: event.initialWrite, isLatestBaseState: false });
    }

    const outcome = await this._admit(rootCid, {
      did                : context.did,
      dwnUrl             : context.dwnUrl,
      delegateDid        : context.delegateDid,
      permissionGrantIds : context.permissionGrantIds,
      scope              : context.link.scope,
      agent              : this._operations.getAgent(),
      permissionsApi     : this._operations.getPermissionsApi(),
      prefetched,
      shouldContinue     : () => !context.isStale(),
    });
    if (context.isStale()) { return undefined; }

    if (outcome.kind === 'admitted') {
      return {
        admitted     : true,
        appliedCids  : outcome.appliedCids,
        messageCid   : rootCid,
        freshEntries : outcome.freshEntries,
      };
    }
    if (outcome.kind === 'failed') {
      await this.recordAdmissionFailure(context, rootCid, event, outcome);
      return { admitted: false, messageCid: rootCid };
    }
    await this._operations.transitionToRepairing(context.controller);
    return undefined;
  }

  private async recordAdmissionFailure(
    context: SyncLivePullContext,
    rootCid: string,
    event: MessageEvent,
    outcome: Extract<AdmitOutcome, { kind: 'failed' }>,
  ): Promise<void> {
    await this._operations.recordDeadLetter({
      messageCid     : rootCid,
      tenantDid      : context.did,
      remoteEndpoint : context.dwnUrl,
      protocol       : (event.message.descriptor as Record<string, unknown>).protocol as string | undefined,
      errorCode      : outcome.reason,
      errorDetail    : outcome.detail ?? 'replicated message admission failed',
    });
  }

  private async createDataStreamFactory(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<LivePullDataStreamFactory> {
    const event = message.event;
    if (!isRecordsWrite(event)) {
      return async () => undefined;
    }

    // DurableEventLog delivers inline record data beside the message payload,
    // as the subscription event's top-level `encodedData`. Serve it directly —
    // a network re-fetch is only needed for detached (large) payloads.
    if (message.encodedData !== undefined) {
      const bytes = Encoder.base64UrlToBytes(message.encodedData);
      return async () => dataStreamFromBytes(bytes);
    }

    const recordsWriteEvent = event as LivePullRecordsWriteEvent;
    if (recordsWriteEvent.message.descriptor.dataCid === undefined) {
      return async () => undefined;
    }

    const messageCid = await Message.getCid(event.message);
    return async () => {
      const fetched = await this._fetchMessages({
        did                : context.did,
        dwnUrl             : context.dwnUrl,
        delegateDid        : context.delegateDid,
        permissionGrantIds : context.permissionGrantIds,
        messageCids        : [messageCid],
        agent              : this._operations.getAgent(),
      });
      return fetched[0]?.dataStream;
    };
  }

  /** Commit one settled event's exact cursor after its ordered queue turn. */
  private async commitEventCursor(context: SyncLivePullContext, cursor: ProgressToken): Promise<void> {
    const { link, isStale } = context;
    if ((link.status !== 'live' && link.status !== 'initializing') || isStale()) {
      return;
    }

    SyncCheckpoint.commitContiguousToken(link.pull, cursor);
    await this._operations.persistCheckpoint(link);
    if (isStale()) { return; }
    this._operations.emitCheckpointAdvance(link);
  }

  private async handleProcessingError(context: SyncLivePullContext, error: unknown): Promise<void> {
    if (context.isStale()) {
      return;
    }

    this._operations.reportError(
      `SyncLivePullProcessor: Error processing live-pull event for ${context.did}`,
      error,
    );
    await this._operations.transitionToRepairing(context.controller);
  }
}
