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
import { fetchRemoteMessages, syncMessageDescriptor, SyncPullAbortedError } from './sync-messages.js';

export type SyncLivePullContext = {
  controller?: SyncLinkController;
  delegateDid?: string;
  did: string;
  dwnUrl: string;
  eventScope: SyncEventScope;
  isStale: () => boolean;
  link?: ReplicationLinkState;
  linkKey: string;
  permissionGrantIds?: NonEmptyStringArray;
};

export interface SyncLivePullProcessorOperations {
  clearFailedMessage(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void>;
  emitCheckpointAdvance(link: ReplicationLinkState): void;
  emitEvent(event: SyncEvent): void;
  getAgent(): EnboxPlatformAgent;
  getPermissionsApi(): PermissionsApi;
  persistCheckpoint(link: ReplicationLinkState): Promise<void>;
  recordDeadLetter(entry: Omit<DeadLetterEntry, 'failedAt'>): Promise<void>;
  reportError(message: string, error: unknown): void;
  scheduleReconcile(controller: SyncLinkController, reason: string): void;
  setConnectivityOnline(): void;
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

type PullDelivery = {
  controller?: SyncLinkController;
  ordinal: number;
};

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
    message: SubscriptionMessage,
  ): Promise<void> {
    if (context.isStale()) {
      return;
    }

    if (message.type === 'eose') {
      await this.handleEose(context, message);
      return;
    }
    if (message.type === 'error') {
      await this.handleSubscriptionError(context, message);
      return;
    }
    if (message.type === 'event') {
      await this.handleEvent(context, message);
    }
  }

  /** Persist a validated catch-up boundary and mark the pull path online. */
  public async handleEose(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'eose' }>,
  ): Promise<void> {
    const { controller, did, dwnUrl, link, isStale } = context;
    if (link !== undefined) {
      if (link.status !== 'live' && link.status !== 'initializing') {
        return;
      }

      if (!SyncCheckpoint.validateTokenDomain(link.pull, message.cursor)) {
        this._operations.warn(
          `SyncLivePullProcessor: Token domain mismatch on EOSE for ${did} -> ${dwnUrl}, transitioning to repairing`,
        );
        if (!isStale() && controller !== undefined) {
          await this._operations.transitionToRepairing(controller);
        }
        return;
      }

      SyncCheckpoint.setReceivedToken(link.pull, message.cursor);
      controller?.drainCommittedPull();
      if (isStale()) { return; }
      await this._operations.persistCheckpoint(link);
      if (isStale()) { return; }
    }

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
      if (link !== undefined && !isStale()) {
        await this._operations.transitionToPaused(linkKey, link);
      }
      return;
    }

    this._operations.warn(
      `SyncLivePullProcessor: subscription error for ${did} -> ${dwnUrl}: ${message.error.code}`,
    );
    if (context.controller !== undefined && !isStale()) {
      await this._operations.transitionToRepairing(context.controller);
    }
  }

  /** Apply, acknowledge, or defer one live remote event in delivery order. */
  public async handleEvent(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<void> {
    if (await this.shouldSkipEvent(context, message) || context.isStale()) {
      return;
    }

    const delivery = this.startDelivery(context, message.cursor);
    try {
      const messageCid = await Message.getCid(message.event.message);
      if (this._echoSuppressor.hasRecentlyPushed(context.did, messageCid, context.dwnUrl)) {
        await this.commitDelivery(context, message.cursor, delivery);
        return;
      }

      const result = await this.processEvent(context, message, messageCid);
      if (result === undefined) { return; }

      if (result.admitted) {
        if (context.link === undefined) {
          this._echoSuppressor.trackPulled(context.did, result.messageCid, context.dwnUrl);
          await this._operations.clearFailedMessage(context.did, result.messageCid, context.dwnUrl);
        } else {
          await this._operations.trackAppliedCids(
            result.appliedCids,
            syncTargetFromLink(context.link),
          );
        }
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
      await this.commitDelivery(context, message.cursor, delivery);
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
    if (link === undefined) {
      this._operations.setConnectivityOnline();
      return;
    }

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

  private async shouldSkipEvent(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<boolean> {
    const { did, dwnUrl, link, isStale } = context;
    if (link !== undefined && link.status !== 'live' && link.status !== 'initializing') {
      return true;
    }

    if (link !== undefined && !SyncCheckpoint.validateTokenDomain(link.pull, message.cursor)) {
      this._operations.warn(
        `SyncLivePullProcessor: Token domain mismatch for ${did} -> ${dwnUrl}, transitioning to repairing`,
      );
      if (!isStale() && context.controller !== undefined) {
        await this._operations.transitionToRepairing(context.controller);
      }
      return true;
    }

    if (link !== undefined) {
      const classification = classifySyncEventScope(message.event, link.scope);
      if (classification === 'out-of-scope') {
        await this.skipOutOfScopeEvent(link, message.cursor, isStale);
        return true;
      }
      if (classification === 'unknown') {
        this._operations.warn(
          `SyncLivePullProcessor: Unable to classify scoped pull event for ${did} -> ${dwnUrl}, transitioning to repair`,
        );
        if (!isStale() && context.controller !== undefined) {
          await this._operations.transitionToRepairing(context.controller);
        }
        return true;
      }
    }

    return false;
  }

  private async skipOutOfScopeEvent(
    link: ReplicationLinkState,
    cursor: ProgressToken,
    isStale: () => boolean,
  ): Promise<void> {
    if (isStale()) { return; }
    SyncCheckpoint.setReceivedToken(link.pull, cursor);
    SyncCheckpoint.commitContiguousToken(link.pull, cursor);
    await this._operations.persistCheckpoint(link);
  }

  private startDelivery(context: SyncLivePullContext, cursor: ProgressToken): PullDelivery {
    const deliveryController = context.controller?.isActive === true && context.link === context.controller.link
      ? context.controller
      : undefined;
    const ordinal = deliveryController?.startPullDelivery(cursor) ?? -1;
    return { controller: deliveryController, ordinal };
  }

  private async processEvent(
    context: SyncLivePullContext,
    message: Extract<SubscriptionMessage, { type: 'event' }>,
    rootCid: string,
  ): Promise<LivePullProcessResult | undefined> {
    const event = message.event;
    const dataStreamFactory = await this.createDataStreamFactory(context, event);
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
      scope              : context.link?.scope,
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
    if (context.controller !== undefined) {
      this._operations.scheduleReconcile(context.controller, `pull-${outcome.kind}`);
    }
    return { admitted: false, messageCid: rootCid };
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
      category       : 'admit-failed',
      errorCode      : outcome.reason,
      errorDetail    : outcome.detail ?? 'replicated message admission failed',
    });
  }

  private async createDataStreamFactory(
    context: SyncLivePullContext,
    event: MessageEvent,
  ): Promise<LivePullDataStreamFactory> {
    if (!isRecordsWrite(event)) {
      return async () => undefined;
    }

    const recordsWriteEvent = event as LivePullRecordsWriteEvent;
    const { encodedData } = recordsWriteEvent.message;
    if (encodedData) {
      delete recordsWriteEvent.message.encodedData;
      const bytes = Encoder.base64UrlToBytes(encodedData);
      return async () => SyncLivePullProcessor.dataStreamFromBytes(bytes);
    }
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

  private async commitDelivery(
    context: SyncLivePullContext,
    cursor: ProgressToken,
    delivery: PullDelivery,
  ): Promise<void> {
    const { did, dwnUrl, link, isStale } = context;
    if (
      link === undefined ||
      delivery.controller === undefined ||
      (link.status !== 'live' && link.status !== 'initializing') ||
      isStale()
    ) {
      return;
    }

    const drained = delivery.controller.commitPullDelivery(delivery.ordinal, cursor);
    if (drained > 0) {
      await this._operations.persistCheckpoint(link);
      if (isStale()) { return; }
      this._operations.emitCheckpointAdvance(link);
    }

    if (delivery.controller.pullInflightCount > this._maxInFlightDeliveries) {
      this._operations.warn(
        `SyncLivePullProcessor: Pull in-flight overflow for ${did} -> ${dwnUrl}, transitioning to repairing`,
      );
      await this._operations.transitionToRepairing(delivery.controller);
    }
  }

  private async handleProcessingError(context: SyncLivePullContext, error: unknown): Promise<void> {
    if (error instanceof SyncPullAbortedError) {
      return;
    }

    this._operations.reportError(
      `SyncLivePullProcessor: Error processing live-pull event for ${context.did}`,
      error,
    );
    if (context.controller !== undefined && !context.isStale()) {
      await this._operations.transitionToRepairing(context.controller);
    }
  }

  private static dataStreamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}
