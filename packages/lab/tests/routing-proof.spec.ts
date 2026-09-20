import { describe, expect, it } from 'bun:test';

import { routingProofInternals, runRoutingProof } from '../src/proofs/routing/routing-proof.js';

describe('P0 routing proof', () => {
  it('should require HTTP and WebSocket reconnect observations', () => {
    const observation = {
      addresses         : ['4:127.0.0.1'],
      http              : { pass: true, url: 'http://localhost:41000/probe' },
      websocketAttempts : [
        { pass: true, url: 'ws://localhost:41000/socket' },
        { pass: true, url: 'ws://localhost:41000/socket' },
      ],
    };

    expect(routingProofInternals.endpointPassed(observation)).toBe(true);
    observation.websocketAttempts[1] = { pass: false, url: 'ws://localhost:41000/socket' };
    expect(routingProofInternals.endpointPassed(observation)).toBe(false);
  });

  it('should select resources by immutable ownership and lab IDs', () => {
    expect(routingProofInternals.labelArguments('run-1', {
      labId   : 'lab-1',
      ownerId : 'owner-1',
    }, 'gateway')).toEqual([
      '--label', 'org.enbox.lab.actor-id=gateway',
      '--label', 'org.enbox.lab.display-name=Routing Proof Lab',
      '--label', 'org.enbox.lab.lab-id=lab-1',
      '--label', 'org.enbox.lab.ownership-id=owner-1',
      '--label', 'org.enbox.lab.proof-run-id=run-1',
    ]);
  });

  it('should report an unavailable Docker daemon as unsupported', async () => {
    const report = await runRoutingProof({
      now        : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      randomUuid : (): string => '11111111-1111-4111-8111-111111111111',
      runCommand : async (): Promise<{ exitCode: number; stderr: string; stdout: string }> => ({
        exitCode : 1,
        stderr   : 'permission denied',
        stdout   : '',
      }),
      workspaceRoot: process.cwd(),
    });

    expect(report).toMatchObject({
      proof  : 'p0-addressing-ownership',
      status : 'unsupported',
    });
    expect(report.checks).toEqual([expect.objectContaining({
      id     : 'A04-docker-engine',
      status : 'unsupported',
    })]);
  });
});
