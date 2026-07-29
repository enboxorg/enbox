import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnMessage, DwnResponseStatus, EnboxPlatformAgent } from '@enbox/agent';

import { DwnInterface } from '@enbox/agent';

import type { ApplicationManifest } from './application-manifest.js';
import type { RecordCodecMap } from './record-codec.js';
import type { TypedEnbox } from './typed-enbox.js';
import type { TypedProtocol } from './protocol-types.js';

import { installedProtocolDefinitionsEqual } from './protocol-definition-utils.js';
import { DwnResponseError, requireDwnSuccess } from './dwn-response-error.js';

type ProtocolReadinessOperation = 'install' | 'publish' | 'query';

/** Options accepted by {@link ProtocolReadinessApi.ensureReady}. */
export type EnsureProtocolsReadyOptions = {
  /** Typed protocols registered by the application. */
  application: ApplicationManifest;

  /** Agent-managed DID to publish to. The local install stays on the connected DID. Ignored for delegates. */
  targetDid?: string;
};

/** A failure to install, publish, or verify one application protocol. */
export class ProtocolReadinessError extends Error {
  public readonly operation: ProtocolReadinessOperation;
  public readonly protocol: string;
  public readonly status?: Readonly<DwnResponseStatus['status']>;
  public readonly targetDid: string;

  public constructor(options: {
    cause?: unknown;
    operation: ProtocolReadinessOperation;
    protocol: string;
    targetDid: string;
  }) {
    const status = options.cause instanceof DwnResponseError ? options.cause.status : undefined;
    const detail = options.cause instanceof Error ? options.cause.message : 'Unknown failure';
    super(
      `Protocol readiness failed to ${options.operation} '${options.protocol}' ` +
      `for '${options.targetDid}': ${detail}`,
      { cause: options.cause },
    );
    this.name = 'ProtocolReadinessError';
    this.operation = options.operation;
    this.protocol = options.protocol;
    this.status = status === undefined ? undefined : { ...status };
    this.targetDid = options.targetDid;
  }
}

/** Hosted protocol readiness exposed as `enbox.protocols`. */
export interface ProtocolReadinessApi {
  /** Installs application protocols locally and publishes owner configurations remotely. */
  ensureReady(options: EnsureProtocolsReadyOptions): Promise<void>;
}

type TypedProtocolAccessor = <
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
>(protocol: TypedProtocol<D, C>) => TypedEnbox<D, C>;

type CreateProtocolReadinessApiOptions = {
  agent: EnboxPlatformAgent;
  connectedDid: string;
  delegateDid?: string;
  using: TypedProtocolAccessor;
};

/** @internal Creates the session-bound implementation exposed by {@link ProtocolReadinessApi}. */
export function createProtocolReadinessApi(options: CreateProtocolReadinessApiOptions): ProtocolReadinessApi {
  return new DefaultProtocolReadinessApi(options);
}

class DefaultProtocolReadinessApi implements ProtocolReadinessApi {
  private readonly agent: EnboxPlatformAgent;
  private readonly connectedDid: string;
  private readonly delegateDid?: string;
  private readonly using: TypedProtocolAccessor;

  public constructor(options: CreateProtocolReadinessApiOptions) {
    this.agent = options.agent;
    this.connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.using = options.using;
  }

  public async ensureReady(options: EnsureProtocolsReadyOptions): Promise<void> {
    for (const { protocol } of options.application.protocols) {
      const typed = this.using(protocol);
      let failureTargetDid = this.connectedDid;
      let operation: ProtocolReadinessOperation = 'install';

      try {
        const configured = await typed.configure();
        if (this.delegateDid !== undefined) {
          continue;
        }

        requireDwnSuccess(`Configure protocol '${typed.protocol}'`, configured);
        if (configured.protocol === undefined) {
          throw new Error(`Configure protocol '${typed.protocol}' returned no signed message.`);
        }

        const targetDid = options.targetDid ?? this.connectedDid;
        failureTargetDid = targetDid;
        const message = targetDid === this.connectedDid
          ? configured.protocol.toJSON()
          : await this.createTargetConfiguration(targetDid, typed.definition);

        operation = 'publish';
        const { reply } = await this.agent.sendDwnRequest({
          author              : targetDid,
          messageType         : DwnInterface.ProtocolsConfigure,
          rawMessage          : message,
          remoteEndpointsOnly : true,
          target              : targetDid,
        });
        if (reply.status.code !== 409) {
          requireDwnSuccess(`Publish protocol '${typed.protocol}'`, reply);
        }

        operation = 'query';
        const installed = await this.queryHostedDefinition(targetDid, typed.protocol);
        if (!installedProtocolDefinitionsEqual(installed, message.descriptor.definition)) {
          operation = 'publish';
          throw new Error('The hosted DWN retained a different active protocol definition.');
        }
      } catch (cause: unknown) {
        throw new ProtocolReadinessError({
          cause,
          operation,
          protocol  : typed.protocol,
          targetDid : failureTargetDid,
        });
      }
    }
  }

  private async createTargetConfiguration(
    targetDid: string,
    definition: ProtocolDefinition,
  ): Promise<DwnMessage[DwnInterface.ProtocolsConfigure]> {
    const { message, reply } = await this.agent.processDwnRequest({
      author        : targetDid,
      messageParams : { definition },
      messageType   : DwnInterface.ProtocolsConfigure,
      store         : false,
      target        : targetDid,
    });
    requireDwnSuccess(`Configure protocol '${definition.protocol}'`, reply);
    if (message === undefined) {
      throw new Error(`Configure protocol '${definition.protocol}' returned no signed message.`);
    }
    return message;
  }

  private async queryHostedDefinition(
    targetDid: string,
    protocol: string,
  ): Promise<ProtocolDefinition | undefined> {
    const { reply } = await this.agent.sendDwnRequest({
      author              : targetDid,
      messageParams       : { filter: { protocol } },
      messageType         : DwnInterface.ProtocolsQuery,
      remoteEndpointsOnly : true,
      target              : targetDid,
    });
    requireDwnSuccess(`Query hosted protocol '${protocol}'`, reply);
    return reply.entries?.[0]?.descriptor.definition;
  }
}
