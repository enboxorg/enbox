import type { DidPersistenceProofOptions } from '../did-persistence-proof.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createProofReport } from '../../proof-result.js';
import { runDidPersistenceProof } from '../did-persistence-proof.js';

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type PersistenceProofRunner = (options: DidPersistenceProofOptions) => Promise<LabProofReport>;

export type DidRuntimeProofDependencies = {
  allocatePort?: () => Promise<number>;
  now?: () => Date;
  randomUuid?: () => string;
  runCommand?: (command: string[]) => Promise<CommandResult>;
  runPersistenceProof?: PersistenceProofRunner;
  waitForRelay?: (endpoint: string) => Promise<void>;
};

type RelayRuntime = {
  containerId: string;
  endpoint: string;
};

type RelayConfigInspection = {
  Cmd?: string[];
  Image?: string;
  Labels?: Record<string, string>;
};

type ImageInspection = {
  Architecture?: string;
  Id?: string;
  Os?: string;
  RepoDigests?: string[];
};

type NetworkInspection = {
  Internal?: boolean;
  Labels?: Record<string, string>;
  Options?: Record<string, string>;
};

const ACTOR_LABEL = 'org.enbox.lab.actor-id';
const DISPLAY_LABEL = 'org.enbox.lab.display-name';
const LAB_LABEL = 'org.enbox.lab.lab-id';
const OWNER_LABEL = 'org.enbox.lab.ownership-id';
const PROOF_LABEL = 'org.enbox.lab.proof-run-id';
const PROOF_DISPLAY_NAME = 'DID Persistence Proof';
const RELAY_PORT = 15411;
const RELAY_READY_ATTEMPTS = 60;
const RELAY_READY_DELAY_MS = 250;

export const PKARR_RELAY_IMAGE = 'synonymsoft/pkarr-relay@sha256:779353eb69f20be93f5c3d740a633045ef80f8a480467085da19cc8ea57251a4';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultRunCommand(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    stderr : 'pipe',
    stdout : 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function expectCommand(
  runner: NonNullable<DidRuntimeProofDependencies['runCommand']>,
  command: string[],
): Promise<CommandResult> {
  const result = await runner(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
  }
  return result;
}

function lastJsonLine<T>(output: string): T {
  const line = output.split('\n').map((entry): string => entry.trim()).filter(Boolean).at(-1);
  if (line === undefined) {
    throw new Error('command returned no JSON output');
  }
  return JSON.parse(line) as T;
}

function token(value: string): string {
  return value.replaceAll('-', '').slice(0, 12).toLowerCase();
}

async function allocateLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    try {
      const server = Bun.serve({
        fetch    : (): Response => new Response('port allocation sentinel'),
        hostname : '127.0.0.1',
        port,
      });
      server.stop(true);
      return port;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('port')) {
        throw error;
      }
    }
  }
  throw new Error('Unable to allocate an unused loopback port after 20 attempts');
}

function resourceLabelArguments(runId: string, labId: string, ownerId: string, actorId?: string): string[] {
  return [
    ...(actorId === undefined ? [] : ['--label', `${ACTOR_LABEL}=${actorId}`]),
    '--label', `${DISPLAY_LABEL}=${PROOF_DISPLAY_NAME}`,
    '--label', `${LAB_LABEL}=${labId}`,
    '--label', `${OWNER_LABEL}=${ownerId}`,
    '--label', `${PROOF_LABEL}=${runId}`,
  ];
}

function mappedRelayPort(output: string): number {
  const match = output.match(/127\.0\.0\.1:(\d+)/);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Unable to parse the relay's loopback port from '${output.trim()}'.`);
  }
  return port;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}

async function defaultWaitForRelay(endpoint: string): Promise<void> {
  let lastError = 'relay did not accept an HTTP connection';
  for (let attempt = 0; attempt < RELAY_READY_ATTEMPTS; attempt += 1) {
    try {
      await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(1_000) });
      return;
    } catch (error: unknown) {
      lastError = errorMessage(error);
      await delay(RELAY_READY_DELAY_MS);
    }
  }
  throw new Error(`Pkarr relay was not ready at ${endpoint}: ${lastError}`);
}

async function ensurePinnedImage(
  runner: NonNullable<DidRuntimeProofDependencies['runCommand']>,
): Promise<ImageInspection> {
  let inspection = await runner(['docker', 'image', 'inspect', PKARR_RELAY_IMAGE, '--format', '{{json .}}']);
  if (inspection.exitCode !== 0) {
    await expectCommand(runner, ['docker', 'pull', PKARR_RELAY_IMAGE]);
    inspection = await expectCommand(runner, ['docker', 'image', 'inspect', PKARR_RELAY_IMAGE, '--format', '{{json .}}']);
  }
  return lastJsonLine<ImageInspection>(inspection.stdout);
}

async function startRelay(params: {
  containerStarted: () => void;
  containerName: string;
  labId: string;
  networkName: string;
  ownerId: string;
  runId: string;
  runner: NonNullable<DidRuntimeProofDependencies['runCommand']>;
  waitForRelay: NonNullable<DidRuntimeProofDependencies['waitForRelay']>;
}): Promise<RelayRuntime> {
  const started = await expectCommand(params.runner, [
    'docker', 'run', '--detach',
    '--name', params.containerName,
    '--network', params.networkName,
    '--publish', `127.0.0.1::${RELAY_PORT}`,
    ...resourceLabelArguments(params.runId, params.labId, params.ownerId, 'pkarr-relay'),
    PKARR_RELAY_IMAGE,
    'pkarr-relay', '--testnet',
  ]);
  params.containerStarted();
  const port = mappedRelayPort((await expectCommand(params.runner, [
    'docker', 'port', params.containerName, `${RELAY_PORT}/tcp`,
  ])).stdout);
  const endpoint = `http://127.0.0.1:${port}/`;
  await params.waitForRelay(endpoint);
  return { containerId: started.stdout.trim(), endpoint };
}

async function removeExactContainer(
  runner: NonNullable<DidRuntimeProofDependencies['runCommand']>,
  containerName: string,
): Promise<void> {
  const result = await runner(['docker', 'rm', '--force', containerName]);
  if (result.exitCode !== 0 && !/No such|not found|does not exist/i.test(result.stderr)) {
    throw new Error(`docker rm --force ${containerName} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
  }
}

async function relayConfig(
  runner: NonNullable<DidRuntimeProofDependencies['runCommand']>,
  containerName: string,
): Promise<RelayConfigInspection> {
  const result = await expectCommand(runner, ['docker', 'inspect', containerName, '--format', '{{json .Config}}']);
  return lastJsonLine<RelayConfigInspection>(result.stdout);
}

function childCheckPassed(report: LabProofReport, id: string): boolean {
  return report.checks.some((check): boolean => check.id === id && check.status === 'pass');
}

/**
 * Runs the real Pkarr testnet boundary of the durable DID proof in an isolated Docker container.
 * The relay is recreated without retaining its state; the adapter restores from exact signed bytes.
 */
export async function runDidRuntimeProof(dependencies: DidRuntimeProofDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const allocatePort = dependencies.allocatePort ?? allocateLoopbackPort;
  const startedAt = now();
  const randomUuid = dependencies.randomUuid ?? ((): string => crypto.randomUUID());
  const runner = dependencies.runCommand ?? defaultRunCommand;
  const persistenceProof = dependencies.runPersistenceProof ?? runDidPersistenceProof;
  const waitForRelay = dependencies.waitForRelay ?? defaultWaitForRelay;
  const runId = randomUuid();
  const labId = randomUuid();
  const ownerId = randomUuid();
  const runToken = token(runId);
  const containerName = `enbox-did-${runToken}-pkarr`;
  const networkName = `enbox-did-${runToken}`;
  const checks: LabCheck[] = [];
  let containerCreated = false;
  let journalDirectory: string | undefined;
  let networkCreated = false;

  const dockerVersion = await runner(['docker', 'version', '--format', '{{json .}}']);
  if (dockerVersion.exitCode !== 0) {
    return createProofReport({
      checks: [{
        details : { error: dockerVersion.stderr || dockerVersion.stdout },
        id      : 'A04-docker-engine',
        status  : 'unsupported',
        summary : 'Docker Engine is unavailable, so the real private Pkarr testnet proof did not run',
      }],
      finishedAt : now(),
      proof      : 'p0-did-runtime-persistence',
      startedAt,
    });
  }

  try {
    const imageInspection = await ensurePinnedImage(runner);
    journalDirectory = await mkdtemp(join(tmpdir(), `enbox-lab-did-${runToken}-`));
    await expectCommand(runner, [
      'docker', 'network', 'create',
      '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
      ...resourceLabelArguments(runId, labId, ownerId),
      networkName,
    ]);
    networkCreated = true;

    const firstRelay = await startRelay({
      containerStarted: (): void => { containerCreated = true; },
      containerName,
      labId,
      networkName,
      ownerId,
      runId,
      runner,
      waitForRelay,
    });
    let secondRelay: RelayRuntime | undefined;
    const advertisedActorPort = await allocatePort();

    const persistenceReport = await persistenceProof({
      advertisedDwnEndpoint : `http://localhost:${advertisedActorPort}`,
      journalLocation       : join(journalDirectory, 'accepted-publications.sqlite'),
      recreateUpstream      : async (): Promise<string> => {
        await removeExactContainer(runner, containerName);
        containerCreated = false;
        secondRelay = await startRelay({
          containerStarted: (): void => { containerCreated = true; },
          containerName,
          labId,
          networkName,
          ownerId,
          runId,
          runner,
          waitForRelay,
        });
        return secondRelay.endpoint;
      },
      upstreamBaseUrl: firstRelay.endpoint,
    });

    const config = await relayConfig(runner, containerName);
    const networkInspection = lastJsonLine<NetworkInspection>((await expectCommand(runner, [
      'docker', 'network', 'inspect', networkName, '--format', '{{json .}}',
    ])).stdout);
    const digestRecorded = imageInspection.RepoDigests?.includes(PKARR_RELAY_IMAGE) === true;
    const masqueradingDisabled = networkInspection.Options?.['com.docker.network.bridge.enable_ip_masquerade'] === 'false';
    const pinnedTestnet = config.Image === PKARR_RELAY_IMAGE && JSON.stringify(config.Cmd) === JSON.stringify(['pkarr-relay', '--testnet']) &&
      config.Labels?.[OWNER_LABEL] === ownerId && config.Labels?.[PROOF_LABEL] === runId && masqueradingDisabled &&
      networkInspection.Labels?.[OWNER_LABEL] === ownerId && networkInspection.Labels?.[PROOF_LABEL] === runId;
    checks.push({
      details: {
        command               : JSON.stringify(config.Cmd ?? []),
        containerImage        : config.Image ?? '',
        dockerVersion         : dockerVersion.stdout,
        imageArchitecture     : imageInspection.Architecture ?? '',
        imageDigest           : PKARR_RELAY_IMAGE,
        imageDigestRecorded   : digestRecorded,
        imageId               : imageInspection.Id ?? '',
        imageOs               : imageInspection.Os ?? '',
        advertisedDwnEndpoint : `http://localhost:${advertisedActorPort}`,
        egressMasquerading    : !masqueradingDisabled,
        labId,
        ownerId,
        runId,
      },
      id      : 'A06-pinned-private-testnet',
      status  : pinnedTestnet && digestRecorded ? 'pass' : 'fail',
      summary : pinnedTestnet && digestRecorded
        ? 'The digest-pinned Pkarr relay ran in testnet mode on a private Docker network'
        : 'The running relay did not match the pinned private-testnet contract',
    });
    checks.push(...persistenceReport.checks);
    checks.push({
      details : { advertisedDwnEndpoint: `http://localhost:${advertisedActorPort}` },
      id      : 'A11-advertised-endpoint-route',
      status  : 'unsupported',
      summary : 'The DID carries the selected localhost-port form, but this persistence proof does not start or exercise that DWN route',
    });

    const signerlessReplay = secondRelay !== undefined && firstRelay.containerId !== secondRelay.containerId &&
      childCheckPassed(persistenceReport, 'A07-signed-packet-restoration');
    checks.push({
      details: {
        firstContainerId  : firstRelay.containerId,
        replaySignerInput : false,
        secondContainerId : secondRelay?.containerId ?? '',
      },
      id      : 'A07-signerless-container-replay',
      status  : signerlessReplay ? 'pass' : 'fail',
      summary : signerlessReplay
        ? 'A new upstream container accepted journal replay without a DID signer or publisher callback'
        : 'The proof did not establish signerless replay into a distinct upstream container',
    });
    checks.push({
      details : { measuredBeyondRetention: false, requiredDuration: 'longer than the pinned upstream retention window' },
      id      : 'A09-retention-soak',
      status  : 'unsupported',
      summary : 'This executable proof does not run beyond upstream retention; the locked-wallet retention soak remains a P4 gate',
    });
  } catch (error: unknown) {
    const logs = containerCreated
      ? await runner(['docker', 'logs', containerName])
      : { exitCode: 1, stderr: '', stdout: '' };
    checks.push({
      details: {
        error     : errorMessage(error),
        relayLogs : logs.stderr || logs.stdout,
      },
      id      : 'did-runtime-proof-execution',
      status  : 'fail',
      summary : 'The real Docker DID persistence proof stopped before completing its observations',
    });
  } finally {
    const cleanupErrors: string[] = [];
    if (containerCreated) {
      try {
        await removeExactContainer(runner, containerName);
      } catch (error: unknown) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (networkCreated) {
      const result = await runner(['docker', 'network', 'rm', networkName]);
      if (result.exitCode !== 0 && !/No such|not found|does not exist/i.test(result.stderr)) {
        cleanupErrors.push(`docker network rm ${networkName}: ${result.stderr || result.stdout}`);
      }
    }
    if (journalDirectory !== undefined) {
      try {
        await rm(journalDirectory, { force: true, recursive: true });
      } catch (error: unknown) {
        cleanupErrors.push(errorMessage(error));
      }
    }

    const [containerInspection, networkInspection] = await Promise.all([
      runner(['docker', 'inspect', containerName]),
      runner(['docker', 'network', 'inspect', networkName]),
    ]);
    const cleanupPassed = cleanupErrors.length === 0 && containerInspection.exitCode !== 0 && networkInspection.exitCode !== 0 &&
      (journalDirectory === undefined || !existsSync(journalDirectory));
    checks.push({
      details: {
        containerName,
        errors           : JSON.stringify(cleanupErrors),
        journalDirectory : journalDirectory ?? '',
        networkName,
        ownerId,
        runId,
      },
      id      : 'proof-resource-cleanup',
      status  : cleanupPassed ? 'pass' : 'fail',
      summary : cleanupPassed
        ? 'The proof removed its exact randomly named container, network, and journal directory'
        : 'One or more exact proof resources remained after cleanup',
    });
  }

  return createProofReport({
    checks,
    finishedAt : now(),
    proof      : 'p0-did-runtime-persistence',
    startedAt,
  });
}

export const didRuntimeProofInternals = {
  mappedRelayPort,
  resourceLabelArguments,
};
