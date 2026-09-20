import { join } from 'node:path';
import { PkarrPublicationJournal } from '../src/pkarr-publication-journal.js';
import { startPkarrPublicationServer } from '../src/pkarr-publication-server.js';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

describe('Pkarr publication server', () => {
  it('should expose readiness only after an empty journal is restored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const server = await startPkarrPublicationServer({
      fetch           : async (): Promise<Response> => new Response(undefined, { status: 204 }),
      journalLocation : join(directory, 'journal.sqlite'),
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    try {
      const response = await fetch(new URL('__lab/health', server.endpoint));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ acceptedPublications: 0, maintenanceError: null, status: 'ready' });
      expect(server.restoreResults).toEqual([]);
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should abort and drain an in-flight publication before closing the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const journalLocation = join(directory, 'journal.sqlite');
    let markPutStarted = (): void => {};
    const putStarted = new Promise<void>((resolve): void => { markPutStarted = resolve; });
    const server = await startPkarrPublicationServer({
      fetch: async (_input, init): Promise<Response> => {
        if (init?.method !== 'PUT') {
          return new Response(undefined, { status: 404 });
        }
        markPutStarted();
        return await new Promise<Response>((_resolve, reject): void => {
          init.signal?.addEventListener('abort', (): void => { reject(init.signal?.reason); }, { once: true });
        });
      },
      journalLocation,
      requestTimeoutMs  : 1_000,
      shutdownTimeoutMs : 2_000,
      upstreamBaseUrl   : 'http://pkarr:15411/',
    });
    const packet = new Uint8Array(80);
    new DataView(packet.buffer).setBigUint64(64, 1n);
    const publication = fetch(new URL('key-one', server.endpoint), {
      body   : new Blob([packet as BlobPart]),
      method : 'PUT',
    }).catch((error: unknown): unknown => error);

    await putStarted;
    await server.stop();
    await publication;

    const reopened = new PkarrPublicationJournal(journalLocation);
    try {
      expect(reopened.list()).toEqual([]);
    } finally {
      reopened.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
