import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { DwnMessage, DwnResponseStatus, EnboxPlatformAgent } from '@enbox/agent';

import { DwnInterface } from '@enbox/agent';

import type { ApplicationManifest } from './application-manifest.js';
import type { RecordCodecMap } from './record-codec.js';
import type { TypedEnbox } from './typed-enbox.js';
import type { TypedModule } from './module-types.js';

import { installedModuleDefinitionsEqual } from './module-definition-utils.js';
import { resolveTypedModuleGraph } from './define-module.js';
import { DwnResponseError, requireDwnSuccess } from './dwn-response-error.js';
import {
  preloadModuleDefinitions,
  resolveModuleGraph,
  validateImportedModuleContracts,
} from '@enbox/dwn-sdk-js';

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
  const impl = new DefaultModuleReadinessApi(options);
  return {
    ensureReady: (ensureOptions: EnsureModulesReadyOptions): Promise<void> => impl.ensureReady(ensureOptions),
  };
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
    const requestedModules = options.application.modules.map(entry => entry.module);
    const requestedModuleUris = new Set(requestedModules.map(module => module.definition.module));
    const localConfigurations = new Map<string, DwnMessage[DwnInterface.ModulesConfigure]>();
    const shouldPublish = this.delegateDid === undefined && options.publish !== false;
    for (const moduleArtifact of requestedModules) {
      // Complete each dependency-aware install before advancing; a failure stops later writes.
      const configuration = await this.configureRequestedModule(moduleArtifact, shouldPublish); // NOSONAR: S9382 — ordered installs.
      if (configuration !== undefined) {
        localConfigurations.set(moduleArtifact.definition.module, configuration);
      }
    }
    if (!shouldPublish) {
      return;
    }

    const targetDid = options.targetDid ?? this.connectedDid;
    const selectedDefinitions = new Map([...localConfigurations].map(([uri, message]) => [uri, message.descriptor.definition]));
    const existingProviderUris = new Set<string>();
    const loadLocalDefinition = async (uri: string): Promise<ModuleDefinition | undefined> => {
      let message = localConfigurations.get(uri);
      if (message === undefined) {
        message = await this.queryLocalConfiguration(uri);
        if (message !== undefined) {
          localConfigurations.set(uri, message);
        }
      }
      return message?.descriptor.definition;
    };
    const selectProviderDefinition = async (uri: string): Promise<ModuleDefinition | undefined> => {
      const previous = selectedDefinitions.get(uri);
      if (previous !== undefined) {
        return previous;
      }
      const hosted = await this.queryHostedDefinition(targetDid, uri);
      if (hosted !== undefined) {
        existingProviderUris.add(uri);
      }
      const definition = hosted ?? await loadLocalDefinition(uri);
      if (definition !== undefined) {
        selectedDefinitions.set(uri, definition);
      }
      return definition;
    };

    // Select and validate the entire target graph before publishing any metadata.
    // Existing target providers win; missing providers use actual local metadata,
    // including dependencies added after the application's artifact was authored.
    for (const module of requestedModules) {
      try {
        const definition = selectedDefinitions.get(module.definition.module)!;
        const definitions = await preloadModuleDefinitions(definition, selectProviderDefinition); // NOSONAR: S9382 — shared provider selection cache.
        const graph = resolveModuleGraph(definition, uri => definitions.get(uri));
        validateImportedModuleContracts(resolveTypedModuleGraph(module), graph);
      } catch (cause: unknown) {
        throw new ModuleReadinessError({ cause, operation: 'query', module: module.definition.module, targetDid });
      }
    }
    // New providers retain the contracts of their actual local policy when an
    // existing target dependency is reused. Stale packaged provider paths do not
    // participate in this check.
    for (const [uri, definition] of selectedDefinitions) {
      if (existingProviderUris.has(uri) || requestedModuleUris.has(uri)) {
        continue;
      }
      try {
        const localDefinitions = await preloadModuleDefinitions(definition, loadLocalDefinition); // NOSONAR: S9382 — ordered provider checks.
        const localGraph = resolveModuleGraph(definition, target => localDefinitions.get(target));
        const targetGraph = resolveModuleGraph(definition, target => selectedDefinitions.get(target));
        validateImportedModuleContracts(localGraph, targetGraph);
      } catch (cause: unknown) {
        throw new ModuleReadinessError({ cause, operation: 'query', module: uri, targetDid });
      }
    }

    const publishedModuleUris = new Set<string>();
    const publish = async (uri: string): Promise<void> => {
      if (publishedModuleUris.has(uri) || existingProviderUris.has(uri)) {
        return;
      }
      const definition = selectedDefinitions.get(uri)!;
      for (const dependency of Object.values(definition.uses ?? {})) {
        await publish(dependency); // NOSONAR: S9382 — publish prerequisites before their dependent.
      }
      let operation: ModuleReadinessOperation = 'publish';
      try {
        // A different owned tenant receives freshly derived target key metadata.
        const message = targetDid === this.connectedDid
          ? localConfigurations.get(uri)!
          : await this.createTargetConfiguration(targetDid, definition);
        const { reply } = await this.agent.sendDwnRequest({
          author      : targetDid,
          messageType : DwnInterface.ModulesConfigure,
          rawMessage  : message,
          target      : targetDid,
        });
        if (reply.status.code !== 409) {
          requireDwnSuccess(`Publish module '${uri}'`, reply);
        }
        operation = 'query';
        const installed = await this.queryHostedDefinition(targetDid, uri);
        if (!installedModuleDefinitionsEqual(installed, message.descriptor.definition)) {
          operation = 'publish';
          throw new Error('The hosted DWN retained a different active module definition.');
        }
        publishedModuleUris.add(uri);
      } catch (cause: unknown) {
        throw new ModuleReadinessError({ cause, operation, module: uri, targetDid });
      }
    };
    for (const module of requestedModules) {
      await publish(module.definition.module); // NOSONAR: S9382 — shared dependency writes must finish before reuse.
    }
  }

  /** Install one requested module and retain its signed configuration only when publication is requested. */
  private async configureRequestedModule(
    moduleArtifact: TypedModule,
    shouldPublish: boolean,
  ): Promise<DwnMessage[DwnInterface.ModulesConfigure] | undefined> {
    const moduleUri = moduleArtifact.definition.module;
    try {
      const configuration = await this.using(moduleArtifact).configure();
      requireDwnSuccess(`Configure module '${moduleUri}'`, configuration);
      if (!shouldPublish) {
        return undefined;
      }
      if (configuration.module === undefined) {
        throw new Error(`Configure module '${moduleUri}' returned no signed message.`);
      }
      return configuration.module.toJSON();
    } catch (cause: unknown) {
      throw new ModuleReadinessError({ cause, operation: 'install', module: moduleUri, targetDid: this.connectedDid });
    }
  }

  private async queryLocalConfiguration(module: string): Promise<DwnMessage[DwnInterface.ModulesConfigure] | undefined> {
    const { reply } = await this.agent.processDwnRequest({
      author        : this.connectedDid,
      messageParams : { filter: { module } },
      messageType   : DwnInterface.ModulesQuery,
      target        : this.connectedDid,
    });
    requireDwnSuccess(`Query local provider '${module}'`, reply);
    return reply.entries?.[0];
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
