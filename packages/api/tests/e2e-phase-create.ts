/**
 * E2E Phase A — Create agent, write profile, push-sync.
 *
 * Outputs a JSON result line: __RESULT__{"did":"...","recoveryPhrase":"..."}
 *
 * Env vars:
 *   E2E_DWN_URL     — Remote DWN endpoint
 *   E2E_PERSONA     — JSON-encoded persona data
 *   E2E_PASSWORD    — Agent password
 *   E2E_ADMIN_TOKEN — (Optional) DWN admin token for tenant registration
 */

import { EnboxUserAgent } from '@enbox/agent';
import { ProfileProtocol, SocialGraphProtocol } from '@enbox/protocols';

import { Enbox, repository } from '../src/index.js';

const DWN_URL = process.env.E2E_DWN_URL!;
const persona = JSON.parse(process.env.E2E_PERSONA!);
const password = process.env.E2E_PASSWORD!;
const adminToken = process.env.E2E_ADMIN_TOKEN;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [CREATE] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Register a DID as a tenant on the remote DWN via the admin API.
 * Silently succeeds if no admin token is set or the DID is already registered.
 */
async function registerTenant(dwnUrl: string, did: string): Promise<void> {
  if (!adminToken) { return; }

  const resp = await fetch(`${dwnUrl}/admin/api/tenants`, {
    method  : 'POST',
    headers : {
      'Authorization' : `Bearer ${adminToken}`,
      'Content-Type'  : 'application/json',
    },
    body   : JSON.stringify({ did }),
    signal : AbortSignal.timeout(10_000),
  });

  if (resp.status === 200 || resp.status === 201 || resp.status === 409) {
    log(`Registered tenant: ${did.slice(0, 32)}...`);
  } else {
    const text = await resp.text();
    log(`Warning: tenant registration returned ${resp.status}: ${text}`);
  }
}

async function main(): Promise<void> {
  log('Connecting to create new agent + identity...');

  // Create the agent, initialize the vault, and start it.
  const agent = await EnboxUserAgent.create();
  const recoveryPhrase = await agent.initialize({ password, dwnEndpoints: [DWN_URL] });
  await agent.start({ password });

  if (!recoveryPhrase) {
    throw new Error('No recovery phrase returned');
  }

  // Create a new identity with the specified DWN endpoints.
  const identity = await agent.identity.create({
    didMethod  : 'dht',
    didOptions : { services: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: [DWN_URL] }] },
    metadata   : { name: 'E2E Test Identity' },
  });
  const did = identity.did.uri;

  log(`Identity created: ${did}`);

  // Construct the Enbox instance.
  const web5 = new Enbox({ agent, connectedDid: did });

  // Install Social Graph (prerequisite for Profile)
  const social = web5.using(SocialGraphProtocol);
  const sgResult = await social.configure();
  if (sgResult.status.code !== 202 && sgResult.status.code !== 200) {
    throw new Error(`Failed to configure Social Graph: ${sgResult.status.code}`);
  }
  log('Social Graph protocol installed');

  // Install Profile protocol and write persona
  const profile = web5.using(ProfileProtocol);
  const repo = repository(profile);
  await repo.configure();
  log('Profile protocol installed');

  const writeResult = await repo.profile.set({ data: persona });
  if (writeResult.status.code !== 202 && writeResult.status.code !== 200) {
    throw new Error(`Failed to write profile: ${writeResult.status.code}`);
  }
  log(`Profile written: ${persona.displayName}`);

  // Verify local read-back
  const localProfile = await repo.profile.get();
  if (!localProfile) {
    throw new Error('Failed to read profile back locally');
  }
  const localData = await localProfile.data.json();
  if (localData.displayName !== persona.displayName) {
    throw new Error(`Local read-back mismatch: "${localData.displayName}" !== "${persona.displayName}"`);
  }
  log('Local read-back verified');

  // Register both DIDs as tenants on the remote DWN (required when the server
  // has a registrationStoreUrl configured but no self-service registration flow).
  await registerTenant(DWN_URL, agent.agentDid.uri);
  await registerTenant(DWN_URL, did);

  // Push sync to remote DWN with retries.
  // Register BOTH the agent DID and the identity DID for the sync engine.
  // Identity metadata, portable DID, and encrypted keys are stored under the
  // agent DID's tenant — these must be pushed so recovery can pull them back.
  log('Syncing to remote DWN...');
  await agent.sync.registerIdentity({ did: agent.agentDid.uri });
  await agent.sync.registerIdentity({ did });

  // Push sync multiple times to handle ordering dependencies.
  // The remote DWN rejects messages that depend on protocols not yet installed
  // (e.g. Profile requires Social Graph). Repeated pushes will retry the failed
  // messages after their dependencies have been processed.
  for (let round = 1; round <= 3; round++) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await agent.sync.sync('push');
        log(`Push sync round ${round} completed`);
        break;
      } catch (err: any) {
        const isRateLimit = err.message?.includes('rate limit') || err.message?.includes('RateLimit');
        if (attempt < 5 && isRateLimit) {
          const delay = attempt * 2;
          log(`Rate limited, retrying in ${delay}s (attempt ${attempt}/5)...`);
          await sleep(delay * 1000);
        } else {
          throw err;
        }
      }
    }
    if (round < 3) {
      await sleep(1000);
    }
  }

  // Output result for the coordinator
  console.log(`__RESULT__${JSON.stringify({ did, recoveryPhrase })}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Phase A FAILED:', err);
    process.exit(1);
  });
