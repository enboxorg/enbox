import type { DwnApi } from '../src/dwn-api.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const PROTOCOL_URI = 'https://example.com/protocols/auto-configure';

const definition: ProtocolDefinition = {
  protocol  : PROTOCOL_URI,
  published : true,
  types     : {
    note: { schema: `${PROTOCOL_URI}/schemas/note`, dataFormats: ['application/json'] },
  },
  structure: {
    note: { $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
  },
};

const codecs = { note: recordCodecs.json<unknown>() };

type FakeStatus = { code: number; detail: string };

/**
 * A minimal owner-session DwnApi stand-in for the auto-configuration path:
 * `_ensureReady()` touches only `isDelegate`, `protocols.query`, and
 * `protocols.configure`; the subsequent typed query touches `records.query`.
 * Statuses are consumed per call, falling back to success once a plan runs dry.
 */
function makeFakeDwn(plan: { configureStatuses?: FakeStatus[]; queryStatuses?: FakeStatus[] }): {
  dwn: DwnApi;
  counts: { configure: number; query: number };
} {
  const counts = { configure: 0, query: 0 };
  const dwn = {
    get isDelegate(): boolean { return false; },
    get connectedDid(): string { return 'did:example:owner'; },
    get protocols(): unknown {
      return {
        query: async (): Promise<unknown> => {
          const status = plan.queryStatuses?.[counts.query] ?? { code: 200, detail: 'OK' };
          counts.query += 1;
          return { status, protocols: [] };
        },
        configure: async (): Promise<unknown> => {
          const status = plan.configureStatuses?.[counts.configure] ?? { code: 202, detail: 'Accepted' };
          counts.configure += 1;
          return { status };
        },
      };
    },
    get records(): unknown {
      return {
        query: async (): Promise<unknown> => ({ status: { code: 200, detail: 'OK' }, records: [] }),
      };
    },
  } as unknown as DwnApi;

  return { dwn, counts };
}

describe('TypedEnbox automatic protocol configuration', () => {
  it('should reject a non-successful owner configure response with the typed DWN error', async () => {
    const fake = makeFakeDwn({ configureStatuses: [{ code: 500, detail: 'Internal Server Error' }] });
    const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, codecs));

    await expect(typed.records.query('note')).rejects.toThrow(DwnResponseError);
    expect(fake.counts.configure).toBe(1);
  });

  it('should retry auto-configuration after a failed configure attempt', async () => {
    const fake = makeFakeDwn({
      configureStatuses: [
        { code: 500, detail: 'Internal Server Error' },
        { code: 202, detail: 'Accepted' },
      ],
    });
    const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, codecs));

    await expect(typed.records.query('note')).rejects.toThrow(DwnResponseError);

    const result = await typed.records.query('note');
    expect(result.records).toEqual([]);
    expect(fake.counts.configure).toBe(2);
  });

  it('should share one attempt across concurrent callers and retry a transient query failure', async () => {
    const fake = makeFakeDwn({ queryStatuses: [{ code: 503, detail: 'Service Unavailable' }] });
    const typed = new TypedEnbox(fake.dwn, defineProtocol(definition, codecs));

    const results = await Promise.allSettled([
      typed.records.query('note'),
      typed.records.query('note'),
    ]);
    expect(results.map((result): string => result.status)).toEqual(['rejected', 'rejected']);
    expect(fake.counts.query).toBe(1);

    const retried = await typed.records.query('note');
    expect(retried.records).toEqual([]);
    expect(fake.counts.configure).toBe(1);
  });
});
