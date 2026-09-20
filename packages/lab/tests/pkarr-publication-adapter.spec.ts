import { join } from 'node:path';
import { PkarrPublicationAdapter } from '../src/pkarr-publication-adapter.js';
import { PkarrPublicationJournal } from '../src/pkarr-publication-journal.js';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

function packet(sequence: bigint, fill = 1): Uint8Array {
  const value = new Uint8Array(80).fill(fill);
  new DataView(value.buffer).setBigUint64(64, sequence);
  return value;
}

function publicationRequest(identifier: string, body: Uint8Array): Request {
  return new Request(`http://did.lab.localhost/${identifier}`, {
    body   : new Blob([body as BlobPart]),
    method : 'PUT',
  });
}

describe('PkarrPublicationAdapter', () => {
  let directory: string | undefined;
  let journal: PkarrPublicationJournal | undefined;

  afterEach(async () => {
    journal?.close();
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  async function createJournal(): Promise<PkarrPublicationJournal> {
    directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-'));
    journal = new PkarrPublicationJournal(join(directory, 'journal.sqlite'));
    return journal;
  }

  it('should persist an upstream-accepted packet before acknowledging success', async () => {
    const store = await createJournal();
    const requests: Request[] = [];
    const adapter = new PkarrPublicationAdapter({
      fetch: async (input, init): Promise<Response> => {
        requests.push(new Request(input, init));
        return new Response('accepted', { status: 204 });
      },
      journal         : store,
      now             : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const body = packet(42n);
    const response = await adapter.handle(publicationRequest('key-one', body));

    expect(response.status).toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://pkarr:15411/key-one');
    expect(store.get('key-one')).toMatchObject({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      sequence   : 42n,
    });
    expect(store.get('key-one')?.packet).toEqual(body);
  });

  it('should not persist a packet rejected by the upstream relay', async () => {
    const store = await createJournal();
    const adapter = new PkarrPublicationAdapter({
      fetch           : async (): Promise<Response> => new Response('rejected', { status: 400 }),
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const response = await adapter.handle(publicationRequest('key-one', packet(1n)));

    expect(response.status).toBe(400);
    expect(store.get('key-one')).toBeUndefined();
  });

  it('should reject an oversized packet before forwarding it upstream', async () => {
    const store = await createJournal();
    let forwarded = false;
    const adapter = new PkarrPublicationAdapter({
      fetch: async (): Promise<Response> => {
        forwarded = true;
        return new Response(undefined, { status: 204 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const response = await adapter.handle(publicationRequest('key-one', new Uint8Array(1_073)));

    expect(response.status).toBe(413);
    expect(forwarded).toBe(false);
  });

  it('should report an unknown outcome when durable storage fails after upstream acceptance', async () => {
    const adapter = new PkarrPublicationAdapter({
      fetch   : async (): Promise<Response> => new Response(undefined, { status: 204 }),
      journal : {
        get  : (): undefined => undefined,
        list : (): [] => [],
        set  : (): never => { throw new Error('disk full'); },
      },
      upstreamBaseUrl: 'http://pkarr:15411/',
    });

    const response = await adapter.handle(publicationRequest('key-one', packet(1n)));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      detail  : 'disk full',
      outcome : 'unknown',
    });
  });

  it('should reject stale and conflicting packets before forwarding after upstream recreation', async () => {
    const store = await createJournal();
    store.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(10n, 1),
      sequence   : 10n,
    });
    let forwarded = 0;
    const adapter = new PkarrPublicationAdapter({
      fetch: async (): Promise<Response> => {
        forwarded += 1;
        return new Response(undefined, { status: 204 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://new-pkarr:15411/',
    });

    const stale = await adapter.handle(publicationRequest('key-one', packet(9n)));
    const conflict = await adapter.handle(publicationRequest('key-one', packet(10n, 2)));

    expect(stale.status).toBe(409);
    expect(conflict.status).toBe(409);
    expect(forwarded).toBe(0);
    expect(store.get('key-one')?.packet).toEqual(packet(10n, 1));
  });

  it('should forward an identical retry to refresh its upstream lifetime', async () => {
    const store = await createJournal();
    const body = packet(10n, 1);
    store.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : body,
      sequence   : 10n,
    });
    let forwarded = 0;
    const adapter = new PkarrPublicationAdapter({
      fetch: async (): Promise<Response> => {
        forwarded += 1;
        return new Response(undefined, { status: 204 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const response = await adapter.handle(publicationRequest('key-one', body));

    expect(response.status).toBe(204);
    expect(forwarded).toBe(1);
    expect(store.get('key-one')?.packet).toEqual(body);
  });

  it('should preserve the newest of concurrent accepted versions', async () => {
    const store = await createJournal();
    store.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(1n),
      sequence   : 1n,
    });
    const forwardedSequences: bigint[] = [];
    const adapter = new PkarrPublicationAdapter({
      fetch: async (_input, init): Promise<Response> => {
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        forwardedSequences.push(new DataView(body.buffer).getBigUint64(64));
        return new Response(undefined, { status: 204 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const responses = await Promise.all([
      adapter.handle(publicationRequest('key-one', packet(2n))),
      adapter.handle(publicationRequest('key-one', packet(3n))),
    ]);

    expect(responses.some((response): boolean => response.status === 204)).toBe(true);
    expect(store.get('key-one')?.sequence).toBe(3n);
    expect(forwardedSequences.at(-1)).toBe(3n);
  });

  it('should serialize publication and replay for the same key using the latest durable packet', async () => {
    const store = await createJournal();
    store.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(1n),
      sequence   : 1n,
    });
    const bodies: Uint8Array[] = [];
    let enterFirstRequest = (): void => {};
    const firstRequestEntered = new Promise<void>((resolve): void => { enterFirstRequest = resolve; });
    let releaseFirstRequest = (): void => {};
    const firstRequestRelease = new Promise<void>((resolve): void => { releaseFirstRequest = resolve; });
    const adapter = new PkarrPublicationAdapter({
      fetch: async (_input, init): Promise<Response> => {
        bodies.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
        if (bodies.length === 1) {
          enterFirstRequest();
          await firstRequestRelease;
        }
        return new Response(undefined, { status: 204 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const publish = adapter.handle(publicationRequest('key-one', packet(2n)));
    await firstRequestEntered;
    const restore = adapter.restore();
    releaseFirstRequest();
    const [publishResponse, restoreResults] = await Promise.all([publish, restore]);

    expect(publishResponse.status).toBe(204);
    expect(restoreResults).toEqual([{ identifier: 'key-one', sequence: '2', status: 'restored' }]);
    expect(bodies).toEqual([packet(2n), packet(2n)]);
  });

  it('should proxy reads without serving journal contents', async () => {
    const store = await createJournal();
    store.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(1n),
      sequence   : 1n,
    });
    const adapter = new PkarrPublicationAdapter({
      fetch: async (_input, init): Promise<Response> => {
        expect(init?.method).toBe('GET');
        return new Response('network packet', { status: 200 });
      },
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const response = await adapter.handle(new Request('http://did.lab.localhost/key-one'));

    expect(await response.text()).toBe('network packet');
  });

  it('should retain ordinary upstream failures as degraded-state evidence', async () => {
    const store = await createJournal();
    const adapter = new PkarrPublicationAdapter({
      fetch           : async (): Promise<Response> => new Response('unavailable', { status: 503 }),
      journal         : store,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    const response = await adapter.handle(new Request('http://did.lab.localhost/key-one'));

    expect(response.status).toBe(503);
    expect(adapter.lastError).toBe('upstream returned 503');
  });

  it('should retain maintenance failures as degraded-state evidence', async () => {
    const adapter = new PkarrPublicationAdapter({
      fetch   : async (): Promise<Response> => new Response(undefined, { status: 404 }),
      journal : {
        get  : (): undefined => undefined,
        list : (): never => { throw new Error('journal unavailable'); },
        set  : (): void => {},
      },
      upstreamBaseUrl: 'http://pkarr:15411/',
    });

    adapter.startMaintenance(1);
    try {
      await Bun.sleep(10);
      expect(adapter.lastMaintenanceError).toBe('journal unavailable');
    } finally {
      adapter.stopMaintenance();
    }
  });
});
