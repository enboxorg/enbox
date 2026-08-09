/**
 * Identity import flows.
 *
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { BearerIdentity } from '@enbox/agent';
import type { FlowContext } from './lifecycle.js';
import type { ImportFromPortableOptions } from '../types.js';

import { registerWithDwnEndpoints } from '../registration.js';
import { assertFlowActive, commitFlowSession, finalizeSession, refreshDwnRoutingForConnection, registerSyncScopeForIdentity, resolveIdentityDids, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';
import {
  DwnEndpointResolutionErrorCode,
  extractDwnServiceEndpointUrls,
  isDwnEndpointResolutionError,
} from '@enbox/dids';

/**
 * Import an identity from a PortableIdentity JSON object.
 *
 * The portable identity contains the DID's private keys and metadata,
 * allowing it to be used on this device.
 */
export async function importFromPortable(
  ctx: FlowContext,
  options: ImportFromPortableOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  assertFlowActive(ctx);

  if (userAgent.identity.supportsAuthoritativeDidImport !== true) {
    throw new Error(
      '[@enbox/auth] Portable import requires an agent with authoritative DID import support.'
    );
  }

  const requiredDwnEndpoints = ctx.registration !== undefined || sync !== 'off';
  const externalConnectedDid = options.portableIdentity.metadata.connectedDid;
  const connectedRouting = externalConnectedDid === undefined
    ? undefined
    : await refreshDwnRoutingForConnection({
      userAgent,
      didUri   : externalConnectedDid,
      required : requiredDwnEndpoints,
    });
  assertFlowActive(ctx);

  // AgentIdentityApi is the authoritative import boundary: it resolves the portable DID once,
  // validates keys against that document, and commits DID + identity stores atomically. A delegate
  // still needs the separate owner resolution above because its portable DID is not connectedDid.
  const identity = await runFlowMutation(ctx, () => userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  }));

  try {
    const { connectedDid, delegateDid } = resolveIdentityDids(identity);
    const dwnEndpoints = delegateDid === undefined
      ? getImportedDwnEndpoints(identity, requiredDwnEndpoints)
      : connectedRouting?.dwnEndpoints;

    // Register the connected DID only at the endpoints advertised by its fresh document.
    if (ctx.registration) {
      if (dwnEndpoints === undefined) {
        throw new Error(`[@enbox/auth] No DWN endpoints are available for registration of '${connectedDid}'.`);
      }
      await registerWithDwnEndpoints(
        {
          userAgent,
          targets      : [{ did: connectedDid, dwnEndpoints }],
          secretStore  : userAgent.secrets,
          storage,
          assertActive : ctx.assertActive,
          runMutation  : ctx.runMutation,
        },
        ctx.registration,
      );
      assertFlowActive(ctx);
    }

    return await commitFlowSession(ctx, async (): Promise<AuthSession> => {
      // Register sync. For delegates, derive scope from grants (not 'all').
      if (delegateDid) {
        await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid });
      } else if (sync !== 'off') {
        await registerSyncScopeForIdentity({ userAgent, connectedDid, identitySyncProtocols });
      }

      await startSyncIfEnabled(userAgent, sync);

      // Persist session info and build the AuthSession for the manager to publish.
      return finalizeSession({
        userAgent,
        emitter,
        storage,
        connectedDid,
        delegateDid,
        signal               : ctx.sessionSignal,
        identityName         : identity.metadata.name,
        identityConnectedDid : identity.metadata.connectedDid,
      });
    });
  } catch (error: unknown) {
    return await rollbackImportedIdentity(ctx, identity, error);
  }
}

/** Read endpoints from the authoritative document returned by core import without resolving twice. */
function getImportedDwnEndpoints(identity: BearerIdentity, required: boolean): string[] | undefined {
  try {
    return extractDwnServiceEndpointUrls(identity.did.document);
  } catch (error: unknown) {
    if (
      !required
      && isDwnEndpointResolutionError(error)
      && error.code !== DwnEndpointResolutionErrorCode.DidResolutionFailed
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Compensate in consistency-preserving order and never hide a partial rollback. */
async function rollbackImportedIdentity(
  ctx: FlowContext,
  identity: BearerIdentity,
  importCause: unknown,
): Promise<never> {
  try {
    await runFlowMutation(ctx, async (): Promise<void> => {
      // Metadata must disappear first. If it cannot, retain the DID and keys so the durable identity
      // remains usable instead of leaving metadata that points at deleted control material.
      await ctx.userAgent.identity.delete({ didUri: identity.did.uri });
      await ctx.userAgent.did.delete({
        didUri    : identity.did.uri,
        tenant    : identity.metadata.tenant,
        deleteKey : true,
      });
    });
  } catch (rollbackCause: unknown) {
    throw new AggregateError(
      [importCause, rollbackCause],
      `[@enbox/auth] Portable import failed and rollback was incomplete for '${identity.did.uri}'.`
    );
  }
  throw importCause;
}
