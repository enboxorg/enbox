/**
 * E2E Phase B — Recover agent from seed phrase, pull-sync, verify profile.
 *
 * The recovery flow:
 * 1. Initialize agent with the original seed phrase (deterministic agent DID)
 * 2. Pull-sync from remote DWN to recover identity + key + protocol records
 * 3. Look up the recovered identity
 * 4. Read the profile record and verify it matches
 *
 * Outputs a JSON result line: __RESULT__{"did":"...","verified":true}
 *
 * Env vars:
 *   E2E_DWN_URL         — Remote DWN endpoint
 *   E2E_PERSONA         — JSON-encoded persona data (expected values)
 *   E2E_PASSWORD        — New agent password (different from Phase A)
 *   E2E_RECOVERY_PHRASE — 12-word seed phrase from Phase A
 *   E2E_ORIGINAL_DID    — Identity DID from Phase A (for comparison)
 */

import { DwnApi } from '../src/dwn-api.js';
import { EnboxUserAgent } from '@enbox/agent';
import { ProfileProtocol } from '@enbox/protocols';
import { repository, TypedEnbox } from '../src/index.js';

const DWN_URL = process.env.E2E_DWN_URL!;
const persona = JSON.parse(process.env.E2E_PERSONA!);
const password = process.env.E2E_PASSWORD!;
const recoveryPhrase = process.env.E2E_RECOVERY_PHRASE!;
const originalDid = process.env.E2E_ORIGINAL_DID!;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [RECOVER] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  log('Recovering agent from seed phrase...');

  // Create agent and recover the deterministic agent DID from the seed phrase
  const agent = await EnboxUserAgent.create();

  // Initialize with the original seed phrase — deterministically re-derives the agent DID
  await agent.initialize({
    password,
    recoveryPhrase,
    dwnEndpoints: [DWN_URL],
  });

  await agent.start({ password });

  log(`Agent DID recovered: ${agent.agentDid.uri}`);

  // The agent DID is recovered, but the identity records are on the remote DWN.
  // Pull-sync to retrieve identity, key, and protocol records.
  log('Pulling agent records from remote DWN...');

  // Register the agent DID for sync (identity records are stored under the agent DID's tenant)
  await agent.sync.registerIdentity({ did: agent.agentDid.uri, options: { protocols: 'all' } });

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await agent.sync.sync('pull');
      log('Pull sync completed (agent records)');
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

  await sleep(2000);

  // Now check if the identity was recovered via sync
  const identities = await agent.identity.list();
  log(`Found ${identities.length} identities after sync`);

  if (identities.length === 0) {
    throw new Error('No identities found after recovery + sync. The identity records may not have synced.');
  }

  const identity = identities[0];
  const recoveredDid = identity.did.uri;
  log(`Recovered identity DID: ${recoveredDid}`);

  if (recoveredDid !== originalDid) {
    throw new Error(`DID mismatch!\n  Original:  ${originalDid}\n  Recovered: ${recoveredDid}`);
  }
  log('Identity DID matches original');

  // Now sync the identity DID's records (profile, protocols, etc.)
  log('Pulling identity records from remote DWN...');

  try {
    await agent.sync.registerIdentity({ did: recoveredDid, options: { protocols: 'all' } });
  } catch {
    // May already be registered if agent DID === identity DID; ignore
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await agent.sync.sync('pull');
      log('Pull sync completed (identity records)');
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

  await sleep(2000);

  // Verify recovered profile data
  log('Verifying recovered profile data...');

  const dwnApi = new DwnApi({ agent, connectedDid: recoveredDid });
  const profile = new TypedEnbox(dwnApi, ProfileProtocol);
  const repo = repository(profile);

  // The protocol was synced from the remote but TypedEnbox needs configure()
  // to be called to mark itself ready. This is a local-only operation since
  // the ProtocolsConfigure record already exists in the local DWN.
  await repo.configure();

  const recoveredProfile = await repo.profile.get();

  if (!recoveredProfile) {
    throw new Error('Profile not found after recovery + sync');
  }

  const recoveredData = await recoveredProfile.data.json();

  const checks: Array<[string, unknown, unknown]> = [
    ['displayName', recoveredData.displayName, persona.displayName],
    ['bio', recoveredData.bio, persona.bio],
    ['tagline', recoveredData.tagline, persona.tagline],
    ['location', recoveredData.location, persona.location],
    ['website', recoveredData.website, persona.website],
  ];

  let allPassed = true;
  for (const [field, actual, expected] of checks) {
    if (actual === expected) {
      log(`  ${field}: PASS`);
    } else {
      log(`  ${field}: FAIL (expected "${expected}", got "${actual}")`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    throw new Error('Profile verification failed');
  }

  log('All profile fields verified successfully');

  // Output result for the coordinator
  console.log(`__RESULT__${JSON.stringify({ did: recoveredDid, verified: true })}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Phase B FAILED:', err);
    process.exit(1);
  });
