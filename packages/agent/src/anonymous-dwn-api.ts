import type { DidResolver, DidUrlDereferencer } from '@enbox/dids';
import type { DwnRpcRequest, EnboxRpc } from '@enbox/dwn-clients';

import type {
  DateSort,
  GenericMessage,
  Pagination,
  ProtocolsQueryFilter,
  ProtocolsQueryReply,
  RecordsCountMessage,
  RecordsCountReply,
  RecordsFilter,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsSubscribeReply,
  SubscriptionListener,
} from '@enbox/dwn-sdk-js';

import { ProtocolsQuery, RecordsCount, RecordsQuery, RecordsRead, RecordsSubscribe } from '@enbox/dwn-sdk-js';

import { verifyRemoteDwnResponse } from './remote-dwn-response.js';
import { getDwnServiceEndpointUrls, resolveDwnSubscriptionUrl } from './utils.js';

/**
 * Parameters for constructing an {@link AnonymousDwnApi}.
 */
export type AnonymousDwnApiParams = {
  /** Resolver used for target DWN discovery and returned-message authentication. */
  didResolver: DidResolver & DidUrlDereferencer;
  /** An RPC client for sending messages to remote DWNs. */
  rpcClient: EnboxRpc;
};

/**
 * Parameters for an anonymous records query.
 * Mirrors the DWN SDK's `RecordsQueryOptions` without `signer` or delegation fields.
 */
export type AnonymousRecordsQueryParams = {
  filter: RecordsFilter;
  dateSort?: DateSort;
  pagination?: Pagination;
  messageTimestamp?: string;
};

/**
 * Parameters for an anonymous records read.
 */
export type AnonymousRecordsReadParams = {
  filter: RecordsFilter;
  messageTimestamp?: string;
};

/**
 * Parameters for an anonymous records subscribe.
 */
export type AnonymousRecordsSubscribeParams = {
  filter: RecordsFilter;
  dateSort?: DateSort;
  pagination?: Pagination;
  messageTimestamp?: string;
};

/**
 * Parameters for an anonymous records count.
 */
export type AnonymousRecordsCountParams = {
  filter: RecordsFilter;
  messageTimestamp?: string;
};

/**
 * Parameters for an anonymous protocols query.
 */
export type AnonymousProtocolsQueryParams = {
  filter?: ProtocolsQueryFilter;
  messageTimestamp?: string;
};

/**
 * A lightweight DWN API that creates **unsigned** (anonymous) DWN messages and
 * sends them to remote DWNs via RPC.
 *
 * This class does not require a vault, agent DID, signing keys, or any identity
 * infrastructure. It leverages the DWN SDK's native support for optional
 * `signer` on read-path operations (RecordsQuery, RecordsRead, RecordsSubscribe,
 * RecordsCount, ProtocolsQuery).
 *
 * Anonymous queries return only published records. Anonymous reads succeed for
 * published records and for protocol records with `{ who: 'anyone', can: ['read'] }`.
 *
 * @example
 * ```ts
 * const resolver = new UniversalResolver({ didResolvers: [DidDht, DidJwk] });
 * const rpcClient = new EnboxRpcClient();
 * const anonymousDwn = new AnonymousDwnApi({ didResolver: resolver, rpcClient });
 *
 * const reply = await anonymousDwn.recordsQuery('did:dht:alice...', {
 *   filter: { protocol: 'https://blog.example/posts', protocolPath: 'post' },
 * });
 * ```
 */
export class AnonymousDwnApi {
  private readonly _didResolver: DidResolver & DidUrlDereferencer;
  private readonly _rpcClient: EnboxRpc;

  constructor({ didResolver, rpcClient }: AnonymousDwnApiParams) {
    this._didResolver = didResolver;
    this._rpcClient = rpcClient;
  }

  /**
   * Send an anonymous (unsigned) `RecordsQuery` to a remote DWN.
   *
   * Only published records are returned by the remote DWN.
   *
   * @param target - The DID whose DWN will be queried.
   * @param params - Query parameters (filter, sort, pagination).
   * @returns The raw `RecordsQueryReply` from the remote DWN.
   */
  public async recordsQuery(target: string, params: AnonymousRecordsQueryParams): Promise<RecordsQueryReply> {
    const recordsQuery = await RecordsQuery.create({
      filter           : params.filter,
      dateSort         : params.dateSort,
      pagination       : params.pagination,
      messageTimestamp : params.messageTimestamp,
      // No signer — creates an unsigned message.
    });

    return await this.sendRequest<RecordsQueryReply>(target, recordsQuery.message);
  }

  /**
   * Send an anonymous (unsigned) `RecordsRead` to a remote DWN.
   *
   * Succeeds for published records and for protocol records with
   * `{ who: 'anyone', can: ['read'] }` rules.
   *
   * @param target - The DID whose DWN will be read from.
   * @param params - Read parameters (filter).
   * @returns The raw `RecordsReadReply` from the remote DWN.
   */
  public async recordsRead(target: string, params: AnonymousRecordsReadParams): Promise<RecordsReadReply> {
    const recordsRead = await RecordsRead.create({
      filter           : params.filter,
      messageTimestamp : params.messageTimestamp,
      // No signer — creates an unsigned message.
    });

    return await this.sendRequest<RecordsReadReply>(target, recordsRead.message);
  }

  /**
   * Send an anonymous (unsigned) `RecordsSubscribe` to a remote DWN.
   *
   * Only published record events are received.
   *
   * @param target - The DID whose DWN to subscribe to.
   * @param params - Subscribe parameters (filter).
   * @param handler - Callback for incoming subscription messages (events and EOSE).
   * @returns The raw `RecordsSubscribeReply` from the remote DWN.
   */
  public async recordsSubscribe(
    target: string,
    params: AnonymousRecordsSubscribeParams,
    handler: SubscriptionListener,
  ): Promise<RecordsSubscribeReply> {
    const recordsSubscribe = await RecordsSubscribe.create({
      filter           : params.filter,
      dateSort         : params.dateSort,
      pagination       : params.pagination,
      messageTimestamp : params.messageTimestamp,
      // No signer — creates an unsigned message.
    });

    return await this.sendRequest<RecordsSubscribeReply>(target, recordsSubscribe.message, undefined, handler);
  }

  /**
   * Send an anonymous (unsigned) `RecordsCount` to a remote DWN.
   *
   * Only published records are counted.
   *
   * @param target - The DID whose DWN to count records in.
   * @param params - Count parameters (filter).
   * @returns The raw `RecordsCountReply` from the remote DWN.
   */
  public async recordsCount(target: string, params: AnonymousRecordsCountParams): Promise<RecordsCountReply> {
    const recordsCount = await RecordsCount.create({
      filter           : params.filter,
      messageTimestamp : params.messageTimestamp,
      // No signer — creates an unsigned message.
    });

    return await this.sendRequest<RecordsCountReply>(target, recordsCount.message as RecordsCountMessage);
  }

  /**
   * Send an anonymous (unsigned) `ProtocolsQuery` to a remote DWN.
   *
   * Only published protocol definitions are returned.
   *
   * @param target - The DID whose DWN to query protocols from.
   * @param params - Optional query parameters (protocol filter).
   * @returns The raw `ProtocolsQueryReply` from the remote DWN.
   */
  public async protocolsQuery(target: string, params?: AnonymousProtocolsQueryParams): Promise<ProtocolsQueryReply> {
    const protocolsQuery = await ProtocolsQuery.create({
      filter           : params?.filter,
      messageTimestamp : params?.messageTimestamp,
      // No signer — creates an unsigned message.
    });

    return await this.sendRequest<ProtocolsQueryReply>(target, protocolsQuery.message);
  }

  /**
   * Resolve the target DID's DWN service endpoints and send an unsigned
   * message to the first one that responds.
   *
   * Follows the same retry-over-endpoints pattern as `AgentDwnApi.sendDwnRpcRequest()`.
   */
  private async sendRequest<TReply>(
    target: string,
    message: GenericMessage,
    data?: Blob,
    subscriptionHandler?: SubscriptionListener,
  ): Promise<TReply> {
    const dwnEndpointUrls = await getDwnServiceEndpointUrls(target, this._didResolver);
    const errorMessages: { url: string; message: string }[] = [];

    for (const endpointUrl of dwnEndpointUrls) {
      try {
        const dwnUrl = subscriptionHandler === undefined
          ? endpointUrl
          : await resolveDwnSubscriptionUrl(endpointUrl, this._rpcClient);

        const reply = await this._rpcClient.sendDwnRequest({
          dwnUrl,
          targetDid    : target,
          message,
          data,
          subscription : subscriptionHandler === undefined ? undefined : {
            handler: subscriptionHandler,
          },
        } as DwnRpcRequest);

        await verifyRemoteDwnResponse({
          didResolver : this._didResolver,
          message,
          reply,
          targetDid   : target,
        });

        return reply as TReply;
      } catch (error: unknown) {
        errorMessages.push({
          url     : endpointUrl,
          message : (error instanceof Error) ? error.message : 'Unknown error',
        });
      }
    }

    throw new Error(`AnonymousDwnApi: Failed to send request to '${target}': ${JSON.stringify(errorMessages)}`);
  }
}
