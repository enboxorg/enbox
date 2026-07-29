/**
 * Application-level protocol readiness across owner and delegated sessions.
 *
 * The owner path delegates exact signed-message publication and endpoint
 * convergence to `@enbox/agent`. The delegate path validates the wallet-owned
 * configuration, imports that exact signed artifact locally, and never authors
 * or publishes a replacement.
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnResponseStatus, EnboxPlatformAgent, ProtocolEndpointFailure } from '@enbox/agent';

import { Message } from '@enbox/dwn-sdk-js';
import {
  ensureOwnerProtocolReady,
  ProtocolPreparationError,
  type ProtocolPreparationStage,
} from '@enbox/agent';

import type { DwnApi } from './dwn-api.js';
import type { RecordCodecMap } from './record-codec.js';
import type { TypedProtocol } from './protocol-types.js';
import type { ApplicationManifest, ApplicationManifestProtocol } from './application-manifest.js';
import type { TypedEnbox, VerifyInstalledResult } from './typed-enbox.js';

import { DwnResponseError } from './dwn-response-error.js';

/** Explicit remote-publication policy for application readiness. */
export type ProtocolReadinessPublication = 'local-only' | 'required';

/** Stage at which application protocol readiness failed. */
export type ProtocolReadinessStage = ProtocolPreparationStage | 'local-import';

/** Suggested recovery for an operational readiness failure. */
export type ProtocolReadinessRecovery = 'reconnect' | 'retry';

/** Machine-readable failure observed at one advertised DWN endpoint. */
export type ProtocolReadinessEndpointFailure = ProtocolEndpointFailure;

/** Options accepted by {@link ProtocolReadinessApi.ensureReady}. */
export type EnsureProtocolsReadyOptions = {
  /** Typed protocols registered by the application. */
  application: ApplicationManifest;

  /** Required explicit choice between hosted publication and a local-only flow. */
  publication: ProtocolReadinessPublication;

  /**
   * Owner identity to prepare. Defaults to the connected DID and must be an
   * identity whose signing keys are available to the agent. Ignored for delegates.
   */
  targetDid?: string;
};

/** Structured, actionable failure from protocol readiness orchestration. */
export class ProtocolReadinessError extends Error {
  public readonly cause?: unknown;
  public readonly endpointFailures: readonly ProtocolReadinessEndpointFailure[];
  public readonly protocol: string;
  public readonly recovery: ProtocolReadinessRecovery;
  public readonly stage: ProtocolReadinessStage;
  public readonly status?: Readonly<DwnResponseStatus['status']>;
  public readonly targetDid: string;

  constructor(options: {
    cause?: unknown;
    detail: string;
    endpointFailures?: readonly ProtocolReadinessEndpointFailure[];
    protocol: string;
    recovery: ProtocolReadinessRecovery;
    stage: ProtocolReadinessStage;
    status?: DwnResponseStatus['status'];
    targetDid: string;
  }) {
    super(
      `Protocol readiness failed for '${options.protocol}' during ${options.stage} ` +
      `against '${options.targetDid}': ${options.detail}`,
    );
    this.name = 'ProtocolReadinessError';
    this.cause = options.cause;
    this.endpointFailures = (options.endpointFailures ?? []).map((failure) => ({
      ...failure,
      status: failure.status === undefined ? undefined : { ...failure.status },
    }));
    this.protocol = options.protocol;
    this.recovery = options.recovery;
    this.stage = options.stage;
    this.status = options.status === undefined ? undefined : { ...options.status };
    this.targetDid = options.targetDid;
  }
}

type TypedProtocolAccessor = <
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
>(protocol: TypedProtocol<D, C>) => TypedEnbox<D, C>;

type ProtocolReadinessApiOptions = {
  agent: EnboxPlatformAgent;
  connectedDid: string;
  delegateDid?: string;
  dwn: DwnApi;
  signal: AbortSignal;
  using: TypedProtocolAccessor;
};

/**
 * High-level protocol lifecycle API exposed as `enbox.protocols`.
 *
 * This surface intentionally requires a publication policy on every call.
 * Low-level `typed.configure()` remains local-only and unchanged.
 */
export class ProtocolReadinessApi {
  private readonly agent: EnboxPlatformAgent;
  private readonly connectedDid: string;
  private readonly delegateDid?: string;
  private readonly dwn: DwnApi;
  private readonly signal: AbortSignal;
  private readonly using: TypedProtocolAccessor;

  /** @internal Constructed by {@link import('./enbox.js').Enbox}. */
  constructor(options: ProtocolReadinessApiOptions) {
    this.agent = options.agent;
    this.connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.dwn = options.dwn;
    this.signal = options.signal;
    this.using = options.using;
  }

  /**
   * Makes every protocol in an application manifest ready for this session.
   *
   * Owner sessions install/repair locally and, with `publication: 'required'`,
   * publish the exact owner-signed, key-injected configuration to every
   * reachable remote DWN endpoint. Delegate sessions instead validate and
   * import the wallet-owned signed configuration; they never publish.
   *
   * Protocols are processed in `uses` dependency order. The promise resolves
   * only after all protocols satisfy their local and requested remote
   * postconditions.
   */
  public async ensureReady(options: EnsureProtocolsReadyOptions): Promise<void> {
    assertPublicationPolicy(options.publication);
    this.signal.throwIfAborted();
    const registrations = orderProtocolsByUsesDependencies(options.application.protocols);
    for (const { protocol } of registrations) {
      this.signal.throwIfAborted();
      const typed = this.using(protocol);
      try {
        if (this.delegateDid !== undefined) {
          await this.ensureDelegateReady(typed);
        } else {
          await this.ensureOwnerReady(typed, options);
        }
      } catch (cause: unknown) {
        this.signal.throwIfAborted();
        throw cause;
      }
      this.signal.throwIfAborted();
    }
  }

  private async ensureOwnerReady(
    typed: TypedEnbox,
    options: EnsureProtocolsReadyOptions,
  ): Promise<void> {
    const readinessDid = options.targetDid ?? this.connectedDid;
    try {
      await ensureOwnerProtocolReady({
        agent              : this.agent,
        ownerDid           : readinessDid,
        protocolDefinition : typed.definition,
        publication        : options.publication,
        signal             : this.signal,
      });

      if (readinessDid === this.connectedDid) {
        this.signal.throwIfAborted();
        typed.markConfiguredFromReadiness();
      }
    } catch (cause: unknown) {
      if (cause instanceof ProtocolPreparationError) {
        const endpointFailures = cause.endpointFailures;
        const endpointStatus = endpointFailures.find((failure) => failure.status !== undefined)?.status;
        const status = cause.status ?? endpointStatus;
        throw readinessError({
          cause,
          detail    : cause.message,
          endpointFailures,
          protocol  : cause.protocol,
          stage     : cause.stage,
          status    : status === undefined ? undefined : { ...status },
          targetDid : cause.targetDid,
        });
      }
      throw readinessError({
        cause,
        detail    : cause instanceof Error ? cause.message : String(cause),
        protocol  : typed.protocol,
        stage     : 'local-configure',
        targetDid : readinessDid,
      });
    }
  }

  private async ensureDelegateReady(typed: TypedEnbox): Promise<void> {
    const protocol = typed.protocol;
    let verification: VerifyInstalledResult;
    try {
      verification = await typed.verifyInstalled();
    } catch (cause: unknown) {
      const status = statusFromCause(cause);
      throw readinessError({
        cause,
        detail    : cause instanceof Error ? cause.message : String(cause),
        protocol,
        recovery  : recoveryForStatus(status, 'retry'),
        stage     : 'remote-query',
        status,
        targetDid : this.connectedDid,
      });
    }
    this.signal.throwIfAborted();

    // Preserve the existing class identity so ConnectionStore and applications
    // can route stale wallet state directly into a reapproval ceremony.
    if (verification.error !== undefined) {
      throw verification.error;
    }
    if (verification.status !== 'up-to-date') {
      throw readinessError({
        detail    : verification.reason ?? 'The wallet-owned configuration is not ready.',
        protocol,
        recovery  : 'reconnect',
        stage     : 'remote-query',
        targetDid : this.connectedDid,
      });
    }

    const remoteProtocol = verification.protocol;
    if (remoteProtocol === undefined) {
      throw readinessError({
        detail    : 'The verified wallet configuration did not include its signed artifact.',
        protocol,
        recovery  : 'reconnect',
        stage     : 'remote-query',
        targetDid : this.connectedDid,
      });
    }

    const walletMessage = await this.runDelegateStage(
      protocol,
      'remote-query',
      'reconnect',
      async () => remoteProtocol.toJSON(),
    );
    const imported = await this.runDelegateStage(
      protocol,
      'local-import',
      'retry',
      async () => this.dwn.importProtocolConfiguration(walletMessage),
    );
    if (!isSuccessfulStatus(imported.status)) {
      throw readinessError({
        detail    : imported.status.detail,
        protocol,
        recovery  : recoveryForStatus(imported.status, 'retry'),
        stage     : 'local-import',
        status    : imported.status,
        targetDid : this.connectedDid,
      });
    }

    await this.runDelegateStage(protocol, 'local-verify', 'retry', async () => {
      const local = await this.dwn.protocols.query({ filter: { protocol } });
      this.signal.throwIfAborted();
      if (local.status.code !== 200 || local.protocols[0] === undefined) {
        throw readinessError({
          detail: local.status.code === 200
            ? 'The imported wallet configuration is not installed locally.'
            : local.status.detail,
          protocol,
          recovery  : recoveryForStatus(local.status, 'retry'),
          stage     : 'local-verify',
          status    : local.status,
          targetDid : this.connectedDid,
        });
      }

      const [walletCid, localCid] = await Promise.all([
        Message.getCid(walletMessage),
        Message.getCid(local.protocols[0].toJSON()),
      ]);
      this.signal.throwIfAborted();
      if (walletCid !== localCid) {
        throw readinessError({
          detail    : 'The local DWN retained a different protocol configuration after wallet import.',
          protocol,
          recovery  : 'reconnect',
          stage     : 'local-verify',
          targetDid : this.connectedDid,
        });
      }
    });
    this.signal.throwIfAborted();
    typed.markConfiguredFromReadiness();
  }

  private async runDelegateStage<T>(
    protocol: string,
    stage: ProtocolReadinessStage,
    recovery: ProtocolReadinessRecovery,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.signal.throwIfAborted();
    try {
      const result = await operation();
      this.signal.throwIfAborted();
      return result;
    } catch (cause: unknown) {
      this.signal.throwIfAborted();
      if (cause instanceof ProtocolReadinessError) {
        throw cause;
      }
      const status = statusFromCause(cause);
      throw readinessError({
        cause,
        detail    : cause instanceof Error ? cause.message : String(cause),
        protocol,
        recovery  : recoveryForStatus(status, recovery),
        stage,
        status,
        targetDid : this.connectedDid,
      });
    }
  }
}

function statusFromCause(cause: unknown): DwnResponseStatus['status'] | undefined {
  return cause instanceof DwnResponseError ? { ...cause.status } : undefined;
}

function recoveryForStatus(
  status: { code: number } | undefined,
  fallback: ProtocolReadinessRecovery,
): ProtocolReadinessRecovery {
  return status?.code === 401 || status?.code === 403 ? 'reconnect' : fallback;
}

function assertPublicationPolicy(value: unknown): asserts value is ProtocolReadinessPublication {
  if (value !== 'local-only' && value !== 'required') {
    throw new TypeError(
      'ProtocolReadinessApi.ensureReady: publication must be either \'local-only\' or \'required\'.',
    );
  }
}

function readinessError(options: {
  cause?: unknown;
  detail: string;
  endpointFailures?: readonly ProtocolReadinessEndpointFailure[];
  protocol: string;
  recovery?: ProtocolReadinessRecovery;
  stage: ProtocolReadinessStage;
  status?: DwnResponseStatus['status'];
  targetDid: string;
}): ProtocolReadinessError {
  return new ProtocolReadinessError({ recovery: 'retry', ...options });
}

function isSuccessfulStatus(status: { code: number }): boolean {
  return (status.code >= 200 && status.code < 300) || status.code === 409;
}

/** Stable topological order for manifest protocols that compose one another through `uses`. */
function orderProtocolsByUsesDependencies(
  registrations: readonly ApplicationManifestProtocol[],
): ApplicationManifestProtocol[] {
  const byUri = new Map(registrations.map((entry) => [entry.protocol.definition.protocol, entry]));
  const remaining = new Set(registrations);
  const prepared = new Set<string>();
  const ordered: ApplicationManifestProtocol[] = [];

  while (remaining.size > 0) {
    const ready = registrations.filter((entry) => {
      if (!remaining.has(entry)) {
        return false;
      }
      const dependencies = Object.values(entry.protocol.definition.uses ?? {})
        .filter((uri): uri is string => typeof uri === 'string' && byUri.has(uri));
      return dependencies.every((uri) => prepared.has(uri));
    });

    if (ready.length === 0) {
      // Preserve declaration order for a cycle; the DWN's protocol validation
      // will surface the invalid composition with its canonical error.
      ordered.push(...registrations.filter((entry) => remaining.has(entry)));
      break;
    }

    for (const entry of ready) {
      remaining.delete(entry);
      prepared.add(entry.protocol.definition.protocol);
      ordered.push(entry);
    }
  }

  return ordered;
}
