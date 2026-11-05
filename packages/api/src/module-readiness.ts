import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { DwnMessage, DwnResponseStatus, EnboxPlatformAgent } from '@enbox/agent';

import { DwnInterface } from '@enbox/agent';

import type { ApplicationManifest } from './application-manifest.js';
import type { RecordCodecMap } from './record-codec.js';
import type { TypedEnbox } from './typed-enbox.js';
import type { TypedModule } from './module-types.js';

import { installedModuleDefinitionsEqual } from './module-definition-utils.js';
import { DwnResponseError, requireDwnSuccess } from './dwn-response-error.js';

type ModuleReadinessOperation = 'install' | 'publish' | 'query';

/** Options accepted by {@link ModuleReadinessApi.ensureReady}. */
export type EnsureModulesReadyOptions = {
  /** Typed modules registered by the application. */
  application: ApplicationManifest;

  /** Publish and verify owner configurations at the hosted DWN. Defaults to `true`; ignored for delegates. */
  publish?: boolean;

  /** Agent-managed DID to publish to. The local install stays on the connected DID. Ignored for delegates. */
  targetDid?: string;
};

/** A failure to install, publish, or verify one application module. */
export class ModuleReadinessError extends Error {
  public readonly operation: ModuleReadinessOperation;
  public readonly module: string;
  public readonly status?: Readonly<DwnResponseStatus['status']>;
  public readonly targetDid: string;

  public constructor(options: {
    cause?: unknown;
    operation: ModuleReadinessOperation;
    module: string;
    targetDid: string;
  }) {
    const status = options.cause instanceof DwnResponseError ? options.cause.status : undefined;
    const detail = options.cause instanceof Error ? options.cause.message : 'Unknown failure';
    super(
      `Module readiness failed to ${options.operation} '${options.module}' ` +
      `for '${options.targetDid}': ${detail}`,
      { cause: options.cause },
    );
    this.name = 'ModuleReadinessError';
    this.operation = options.operation;
    this.module = options.module;
    this.status = status === undefined ? undefined : { ...status };
    this.targetDid = options.targetDid;
  }
}

/** Module installation and optional hosted publication exposed as `enbox.modules`. */
export interface ModuleReadinessApi {
  /** Makes application modules ready for the current session. */
  ensureReady(options: EnsureModulesReadyOptions): Promise<void>;
}

type TypedModuleAccessor = <
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(module: TypedModule<D, C>) => TypedEnbox<D, C>;

type CreateModuleReadinessApiOptions = {
  agent: EnboxPlatformAgent;
  connectedDid: string;
  delegateDid?: string;
  using: TypedModuleAccessor;
};

/** @internal Creates the session-bound implementation exposed by {@link ModuleReadinessApi}. */
export function createModuleReadinessApi(options: CreateModuleReadinessApiOptions): ModuleReadinessApi {
  return new DefaultModuleReadinessApi(options);
}

class DefaultModuleReadinessApi implements ModuleReadinessApi {
  private readonly agent: EnboxPlatformAgent;
  private readonly connectedDid: string;
  private readonly delegateDid?: string;
  private readonly using: TypedModuleAccessor;

  public constructor(options: CreateModuleReadinessApiOptions) {
    this.agent = options.agent;
    this.connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.using = options.using;
  }

  public async ensureReady(options: EnsureModulesReadyOptions): Promise<void> {
    for (const { module } of options.application.modules) {
      const typed = this.using(module);
      let failureTargetDid = this.connectedDid;
      let operation: ModuleReadinessOperation = 'install';

      try {
        const configured = await typed.configure();
        if (this.delegateDid !== undefined) {
          continue;
        }

        requireDwnSuccess(`Configure module '${typed.module}'`, configured);
        if (options.publish === false) {
          continue;
        }
        if (configured.module === undefined) {
          throw new Error(`Configure module '${typed.module}' returned no signed message.`);
        }

        const targetDid = options.targetDid ?? this.connectedDid;
        failureTargetDid = targetDid;
        const message = targetDid === this.connectedDid
          ? configured.module.toJSON()
          : await this.createTargetConfiguration(targetDid, typed.definition);

        operation = 'publish';
        const { reply } = await this.agent.sendDwnRequest({
          author      : targetDid,
          messageType : DwnInterface.ModulesConfigure,
          rawMessage  : message,
          target      : targetDid,
        });
        if (reply.status.code !== 409) {
          requireDwnSuccess(`Publish module '${typed.module}'`, reply);
        }

        operation = 'query';
        const installed = await this.queryHostedDefinition(targetDid, typed.module);
        if (!installedModuleDefinitionsEqual(installed, message.descriptor.definition)) {
          operation = 'publish';
          throw new Error('The hosted DWN retained a different active module definition.');
        }
      } catch (cause: unknown) {
        throw new ModuleReadinessError({
          cause,
          operation,
          module    : typed.module,
          targetDid : failureTargetDid,
        });
      }
    }
  }

  private async createTargetConfiguration(
    targetDid: string,
    definition: ModuleDefinition,
  ): Promise<DwnMessage[DwnInterface.ModulesConfigure]> {
    const { message, reply } = await this.agent.processDwnRequest({
      author        : targetDid,
      messageParams : { definition },
      messageType   : DwnInterface.ModulesConfigure,
      store         : false,
      target        : targetDid,
    });
    requireDwnSuccess(`Configure module '${definition.module}'`, reply);
    if (message === undefined) {
      throw new Error(`Configure module '${definition.module}' returned no signed message.`);
    }
    return message;
  }

  private async queryHostedDefinition(
    targetDid: string,
    module: string,
  ): Promise<ModuleDefinition | undefined> {
    const { reply } = await this.agent.sendDwnRequest({
      author        : targetDid,
      messageParams : { filter: { module } },
      messageType   : DwnInterface.ModulesQuery,
      target        : targetDid,
    });
    requireDwnSuccess(`Query hosted module '${module}'`, reply);
    return reply.entries?.[0]?.descriptor.definition;
  }
}
