import type { DidPersistenceProofOptions } from '../src/proofs/did-persistence-proof.js';
import type { LabProofReport } from '../src/proof-result.js';

import { describe, expect, it } from 'bun:test';

import { createProofReport } from '../src/proof-result.js';
import {
  didRuntimeProofInternals,
  PKARR_RELAY_IMAGE,
  runDidRuntimeProof,
} from '../src/proofs/did-runtime/did-runtime-proof.js';

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

function result(stdout = '', exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, stderr, stdout };
}

describe('P0 real Pkarr persistence proof', () => {
  it('should pin the established Pkarr artifact and exact testnet command', async () => {
    const commands: string[][] = [];
    let relayStarts = 0;
    let resourcePresent = true;
    const runner = async (command: string[]): Promise<CommandResult> => {
      commands.push(command);
      const joined = command.join(' ');
      if (joined.startsWith('docker version')) {
        return result('{"Server":{"Version":"proof"}}');
      }
      if (joined.startsWith('docker image inspect')) {
        return result(JSON.stringify({
          Architecture : 'amd64',
          Id           : 'sha256:image-config',
          Os           : 'linux',
          RepoDigests  : [PKARR_RELAY_IMAGE],
        }));
      }
      if (joined.startsWith('docker network create')) {
        return result('network-id');
      }
      if (joined.startsWith('docker run')) {
        relayStarts += 1;
        resourcePresent = true;
        return result(`relay-container-${relayStarts}`);
      }
      if (joined.startsWith('docker port')) {
        return result(`127.0.0.1:${41_000 + relayStarts}`);
      }
      if (joined.includes('--format {{json .Config}}')) {
        return result(JSON.stringify({
          Cmd    : ['pkarr-relay', '--testnet'],
          Image  : PKARR_RELAY_IMAGE,
          Labels : {
            'org.enbox.lab.ownership-id' : '33333333-3333-4333-8333-333333333333',
            'org.enbox.lab.proof-run-id' : '11111111-1111-4111-8111-111111111111',
          },
        }));
      }
      if (joined.startsWith('docker network inspect') && joined.includes('--format {{json .}}')) {
        return result(JSON.stringify({
          Internal : false,
          Labels   : {
            'org.enbox.lab.ownership-id' : '33333333-3333-4333-8333-333333333333',
            'org.enbox.lab.proof-run-id' : '11111111-1111-4111-8111-111111111111',
          },
          Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        }));
      }
      if (joined.startsWith('docker rm --force')) {
        resourcePresent = false;
        return result('removed');
      }
      if (joined.startsWith('docker network rm')) {
        return result('removed');
      }
      if (joined.startsWith('docker inspect') || joined.startsWith('docker network inspect')) {
        return resourcePresent ? result('{}') : result('', 1, 'No such object');
      }
      return result('', 1, `unexpected command: ${joined}`);
    };
    const uuids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const runPersistenceProof = async (options: DidPersistenceProofOptions): Promise<LabProofReport> => {
      expect(options.upstreamBaseUrl).toBe('http://127.0.0.1:41001/');
      expect(options.advertisedDwnEndpoint).toBe('http://localhost:43210');
      expect(options.journalLocation).toEndWith('accepted-publications.sqlite');
      expect(await options.recreateUpstream()).toBe('http://127.0.0.1:41002/');
      return createProofReport({
        checks: [
          {
            id      : 'A07-signed-packet-restoration',
            status  : 'pass',
            summary : 'restored',
          },
          {
            id      : 'A09-network-only-cache-bypass',
            status  : 'unsupported',
            summary : 'not established',
          },
        ],
        proof     : 'synthetic-persistence-proof',
        startedAt : new Date('2026-09-20T12:00:00.000Z'),
      });
    };

    const report = await runDidRuntimeProof({
      allocatePort : async (): Promise<number> => 43_210,
      now          : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      randomUuid   : (): string => uuids.shift()!,
      runCommand   : runner,
      runPersistenceProof,
      waitForRelay : async (): Promise<void> => {},
    });

    expect(report.status).toBe('unsupported');
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'A06-pinned-private-testnet',
      status : 'pass',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'A07-signerless-container-replay',
      status : 'pass',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'A09-retention-soak',
      status : 'unsupported',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'proof-resource-cleanup',
      status : 'pass',
    }));

    const dockerRuns = commands.filter((command): boolean => command[0] === 'docker' && command[1] === 'run');
    expect(dockerRuns).toHaveLength(2);
    for (const command of dockerRuns) {
      expect(command).toContain(PKARR_RELAY_IMAGE);
      expect(command.slice(-2)).toEqual(['pkarr-relay', '--testnet']);
      expect(command).toContain('org.enbox.lab.ownership-id=33333333-3333-4333-8333-333333333333');
      expect(command).toContain('org.enbox.lab.proof-run-id=11111111-1111-4111-8111-111111111111');
    }
    const networkCreate = commands.find((command): boolean => command[0] === 'docker' && command[1] === 'network' && command[2] === 'create');
    expect(networkCreate).toContain('com.docker.network.bridge.enable_ip_masquerade=false');
    expect(networkCreate).toContain('org.enbox.lab.ownership-id=33333333-3333-4333-8333-333333333333');
  });

  it('should keep the Docker-unavailable result explicit', async () => {
    let persistenceInvoked = false;
    const report = await runDidRuntimeProof({
      now                 : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      randomUuid          : (): string => crypto.randomUUID(),
      runCommand          : async (): Promise<CommandResult> => result('', 1, 'permission denied'),
      runPersistenceProof : async (): Promise<LabProofReport> => {
        persistenceInvoked = true;
        throw new Error('must not run');
      },
    });

    expect(persistenceInvoked).toBe(false);
    expect(report.status).toBe('unsupported');
    expect(report.checks).toEqual([expect.objectContaining({
      id     : 'A04-docker-engine',
      status : 'unsupported',
    })]);
  });

  it('should parse only a valid loopback port mapping', () => {
    expect(didRuntimeProofInternals.mappedRelayPort('127.0.0.1:49153\n')).toBe(49_153);
    expect((): number => didRuntimeProofInternals.mappedRelayPort('0.0.0.0:49153')).toThrow('Unable to parse');
  });
});
