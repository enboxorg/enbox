/**
 * E2E Identity Lifecycle Test
 *
 * Validates the full identity lifecycle against a live DWN server:
 *
 * 1. Create a new agent + identity via Web5.connect()
 * 2. Install the Profile protocol and write randomly generated persona data
 * 3. Push-sync the profile to the remote DWN
 * 4. Destroy the local agent data (simulate device loss)
 * 5. Recover the agent from the seed phrase via Web5.connect()
 * 6. Pull-sync from the remote DWN
 * 7. Verify the recovered profile data matches the original
 *
 * The test runs Phases 1-3 and 4-6 in separate subprocesses to guarantee
 * LevelDB locks are fully released between the "destroy" and "recover" steps.
 *
 * Usage:
 *   TEST_DWN_URL=https://dev.aws.dwn.enbox.id bun run tests/e2e-identity-lifecycle.ts
 *
 * Env vars:
 *   TEST_DWN_URL         — DWN server to test against (default: http://localhost:3000)
 *   TEST_DWN_ADMIN_TOKEN — (Optional) Admin token for DWN servers with tenant registration
 *   DID_DHT_GATEWAY_URI  — (Optional) DHT gateway for DID publishing/resolution.
 *                          For local DWN: set to http://localhost:7527.
 *                          For remote DWN: leave unset to use the production gateway.
 *
 * Requires:
 *   - A running DWN server (local or remote)
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DWN_URL = process.env.TEST_DWN_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.TEST_DWN_ADMIN_TOKEN || '';
const AGENT_DATA_PATH = path.join(process.cwd(), 'DATA', 'AGENT');
const TEST_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(phase: string, message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[${timestamp}] [${phase}] ${message}`);
}

/**
 * Run a phase script as a subprocess and capture its JSON output from the
 * last line of stdout. All other stdout/stderr lines are forwarded live.
 */
async function runPhase(scriptPath: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['bun', 'run', scriptPath], {
    env   : { ...process.env, ...env },
    cwd   : process.cwd(),
    stdio : ['inherit', 'pipe', 'inherit'],
  });

  const allLines: string[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      allLines.push(line);
      console.log(line);
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    allLines.push(buffer);
    console.log(buffer);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Phase script exited with code ${exitCode}`);
  }

  // Find the __RESULT__ line (search from the end)
  const resultLine = allLines.reverse().find(l => l.startsWith('__RESULT__'));
  if (resultLine) {
    return JSON.parse(resultLine.slice('__RESULT__'.length));
  }

  return {};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('SETUP', `DWN server: ${DWN_URL}`);
  log('SETUP', `Agent data path: ${AGENT_DATA_PATH}`);

  // Generate test persona
  const id = randomUUID().slice(0, 8);
  const persona = JSON.stringify({
    displayName : `Test User ${id}`,
    bio         : `Automated E2E test identity created at ${new Date().toISOString()}`,
    tagline     : `Tagline ${id}`,
    location    : `City-${id}, Country-${id}`,
    website     : `https://example.com/${id}`,
  });

  // Ensure clean slate
  if (fs.existsSync(AGENT_DATA_PATH)) {
    fs.rmSync(AGENT_DATA_PATH, { recursive: true, force: true });
    log('SETUP', 'Cleaned existing agent data');
  }

  // =========================================================================
  // Phase A: Create, write profile, sync push (subprocess)
  // =========================================================================

  log('MAIN', 'Starting Phase A: create + sync push...');

  const phaseAResult = await runPhase(
    path.join(import.meta.dir, 'e2e-phase-create.ts'),
    {
      E2E_DWN_URL     : DWN_URL,
      E2E_PERSONA     : persona,
      E2E_PASSWORD    : 'e2e-test-password-phase1',
      E2E_ADMIN_TOKEN : ADMIN_TOKEN,
    },
  );

  const recoveryPhrase = phaseAResult.recoveryPhrase as string;
  const originalDid = phaseAResult.did as string;

  if (!recoveryPhrase || !originalDid) {
    throw new Error(`Phase A did not return expected results: ${JSON.stringify(phaseAResult)}`);
  }

  log('MAIN', `Phase A complete. DID: ${originalDid}`);

  // =========================================================================
  // Destroy local data (between subprocesses = guaranteed lock-free)
  // =========================================================================

  log('MAIN', 'Destroying local agent data...');
  if (fs.existsSync(AGENT_DATA_PATH)) {
    fs.rmSync(AGENT_DATA_PATH, { recursive: true, force: true });
  }
  log('MAIN', 'Local agent data destroyed');

  // =========================================================================
  // Phase B: Recover from seed, sync pull, verify (subprocess)
  // =========================================================================

  log('MAIN', 'Starting Phase B: recover + sync pull + verify...');

  const phaseBResult = await runPhase(
    path.join(import.meta.dir, 'e2e-phase-recover.ts'),
    {
      E2E_DWN_URL          : DWN_URL,
      E2E_PERSONA          : persona,
      E2E_PASSWORD         : 'e2e-test-password-phase2-new',
      E2E_RECOVERY_PHRASE  : recoveryPhrase,
      E2E_ORIGINAL_DID     : originalDid,
    },
  );

  const verified = phaseBResult.verified as boolean;
  const recoveredDid = phaseBResult.did as string;

  if (!verified) {
    throw new Error('Phase B: profile verification failed');
  }

  // =========================================================================
  // Final cleanup
  // =========================================================================

  if (fs.existsSync(AGENT_DATA_PATH)) {
    fs.rmSync(AGENT_DATA_PATH, { recursive: true, force: true });
  }

  log('DONE', '========================================');
  log('DONE', 'E2E Identity Lifecycle Test PASSED');
  log('DONE', `  DID:      ${originalDid}`);
  log('DONE', `  Persona:  ${JSON.parse(persona).displayName}`);
  log('DONE', `  DWN:      ${DWN_URL}`);
  log('DONE', '========================================');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const timeout = setTimeout(() => {
  console.error(`\nE2E test timed out after ${TEST_TIMEOUT / 1000}s`);
  process.exit(1);
}, TEST_TIMEOUT);

run()
  .then(() => {
    clearTimeout(timeout);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timeout);
    console.error('\nE2E Identity Lifecycle Test FAILED');
    console.error(err);
    process.exit(1);
  });
