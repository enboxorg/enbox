import type { DwnApi } from '../src/dwn-api.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const PROTOCOL_URI = 'https://example.com/protocols/auto-configure';

const definition = {
  protocol  : PROTOCOL_URI,
  published : true,
  types     : {
    note: { schema: `${PROTOCOL_URI}/schemas/note`, dataFormats: ['application/json'] },
  },
  structure: {
    note: { $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
  },
} as const satisfies ProtocolDefinition;

const protocol = defineProtocol(definition, { note: recordCodecs.json<unknown>() });

type FakeStatus = { code: number; detail: string };

function createOwnerDwn(configureStatuses: FakeStatus[]): {
  configureCount: () => number;
  dwn: DwnApi;
} {
  let configureCount = 0;
  const dwn = {
    connectedDid : 'did:example:owner',
    isDelegate   : false,
    protocols    : {
      configure: async (): Promise<unknown> => {
        const status = configureStatuses[configureCount] ?? { code: 202, detail: 'Accepted' };
        configureCount += 1;
        return { status };
      },
      query: async (): Promise<unknown> => ({
        status    : { code: 200, detail: 'OK' },
        protocols : [],
      }),
    },
    records: {
      query: async (): Promise<unknown> => ({
        status  : { code: 200, detail: 'OK' },
        records : [],
      }),
    },
  } as unknown as DwnApi;

  return { configureCount: (): number => configureCount, dwn };
}

function createTransientDelegateDwn(): {
  counts: () => { imports: number; localQueries: number; remoteQueries: number };
  dwn: DwnApi;
  } {
  let imported = false;
  let imports = 0;
  let localQueries = 0;
  let remoteQueries = 0;
  const walletProtocol = {
    definition,
    toJSON: (): Record<string, never> => ({}),
  };
  const dwn = {
    connectedDid                : 'did:example:owner',
    isDelegate                  : true,
    importProtocolConfiguration : async (): Promise<unknown> => {
      imported = true;
      imports += 1;
      return { status: { code: 202, detail: 'Accepted' } };
    },
    protocols: {
      query: async (request: { from?: string }): Promise<unknown> => {
        if (request.from !== undefined) {
          remoteQueries += 1;
          return remoteQueries === 1
            ? { status: { code: 503, detail: 'Service Unavailable' }, protocols: [] }
            : { status: { code: 200, detail: 'OK' }, protocols: [walletProtocol] };
        }

        localQueries += 1;
        return {
          status    : { code: 200, detail: 'OK' },
          protocols : imported ? [{ definition }] : [],
        };
      },
    },
    records: {
      query: async (): Promise<unknown> => ({
        status  : { code: 200, detail: 'OK' },
        records : [],
      }),
    },
  } as unknown as DwnApi;

  return {
    counts: (): { imports: number; localQueries: number; remoteQueries: number } => ({
      imports,
      localQueries,
      remoteQueries,
    }),
    dwn,
  };
}

describe('TypedEnbox automatic protocol configuration', () => {
  it('should reject a non-successful owner configure response with the typed DWN error', async () => {
    const fake = createOwnerDwn([{ code: 500, detail: 'Internal Server Error' }]);
    const typed = new TypedEnbox(fake.dwn, protocol);

    await expect(typed.records.query('note')).rejects.toMatchObject({
      name   : DwnResponseError.name,
      status : { code: 500, detail: 'Internal Server Error' },
    });
    expect(fake.configureCount()).toBe(1);
    expect(typed.isConfigured).toBe(false);
  });

  it('should retry owner auto-configuration after a failed configure attempt', async () => {
    const fake = createOwnerDwn([
      { code: 500, detail: 'Internal Server Error' },
      { code: 202, detail: 'Accepted' },
    ]);
    const typed = new TypedEnbox(fake.dwn, protocol);

    await expect(typed.records.query('note')).rejects.toBeInstanceOf(DwnResponseError);

    const result = await typed.records.query('note');
    expect(result.records).toEqual([]);
    expect(fake.configureCount()).toBe(2);
    expect(typed.isConfigured).toBe(true);
  });

  it('should share a delegate attempt and retry after a transient wallet query failure', async () => {
    const fake = createTransientDelegateDwn();
    const typed = new TypedEnbox(fake.dwn, protocol);

    const results = await Promise.allSettled([
      typed.records.query('note'),
      typed.records.query('note'),
    ]);
    expect(results.map((result): string => result.status)).toEqual(['rejected', 'rejected']);
    expect(fake.counts()).toEqual({ imports: 0, localQueries: 1, remoteQueries: 1 });

    const retried = await typed.records.query('note');
    expect(retried.records).toEqual([]);
    expect(fake.counts()).toEqual({ imports: 1, localQueries: 3, remoteQueries: 2 });
    expect(typed.isConfigured).toBe(true);
  });
});
