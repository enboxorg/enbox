import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { describe, expect, it } from 'bun:test';
import { Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { admitClosure } from '../src/sync-admit-closure.js';
import { fetchRemoteMessages } from '../src/sync-messages.js';

async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject): void => {
        timer = setTimeout(() => reject(new Error('HTTP response cleanup did not complete promptly.')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function streamingDwn(message: GenericMessage): {
  client: HttpDwnRpcClient;
  dwnUrl: string;
  released: Promise<void>;
  close: () => Promise<void>;
} {
  const aborted = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let closeBody = (): void => {};
  const server = Bun.serve({
    hostname : '127.0.0.1',
    port     : 0,
    fetch(request): Response {
      if (new URL(request.url).pathname.endsWith('/info')) {
        return Response.json({
          maxFileSize              : 1_000_000,
          registrationRequirements : [],
          server                   : 'test',
          sdkVersion               : 'test',
          url                      : server.url.href,
          version                  : 'test',
          webSocketSupport         : false,
        });
      }
      const envelope = request.headers.get('dwn-request');
      if (envelope === null) { return new Response('Missing RPC envelope', { status: 400 }); }
      const { id } = JSON.parse(envelope) as { id: string };
      request.signal.addEventListener('abort', (): void => { aborted.resolve(); }, { once: true });
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(1_024));
          timer = setInterval(() => { controller.enqueue(new Uint8Array(1_024)); }, 10);
          closeBody = (): void => { clearInterval(timer); controller.close(); };
        },
        cancel(): void {
          clearInterval(timer);
          cancelled.resolve();
        },
      });
      return new Response(body, { headers: {
        'content-type' : 'application/octet-stream',
        'dwn-response' : JSON.stringify({ jsonrpc : '2.0', id, result  : { reply: {
          status: { code: 200, detail: 'OK' }, entry: { message },
        } } }),
      } });
    },
  });
  return {
    client   : new HttpDwnRpcClient(undefined, { maxRetries: 0 }),
    dwnUrl   : server.url.href,
    released : Promise.all([aborted.promise, cancelled.promise]).then((): void => {}),
    close    : async (): Promise<void> => {
      try { closeBody(); } catch { /* The response may already be cancelled. */ }
      await server.stop(true);
    },
  };
}

describe('sync HTTP response cleanup', (): void => {
  it('closes a real remote response when its message does not match the requested CID', async (): Promise<void> => {
    const requested = await TestDataGenerator.generateRecordsWrite();
    const returned = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array(1_000_000) });
    const server = streamingDwn(returned.message);
    const agent = {
      processDwnRequest : async () => ({ message: { descriptor: { interface: 'Messages', method: 'Read' } } }),
      rpc               : server.client,
    } as unknown as EnboxPlatformAgent;
    try {
      const entries = await promptly(fetchRemoteMessages({
        did         : requested.author.did,
        dwnUrl      : server.dwnUrl,
        messageCids : [await Message.getCid(requested.message)],
        agent,
      }));
      expect(entries).toEqual([]);
      await promptly(server.released);
    } finally {
      await server.close();
    }
  });

  it('closes a real remote response when closure admission leaves its capped body unused', async (): Promise<void> => {
    const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array(1_000_000) });
    const rootCid = await Message.getCid(write.message);
    const server = streamingDwn(write.message);
    const agent = {
      processDwnRequest : async () => ({ message: { descriptor: { interface: 'Messages', method: 'Read' } } }),
      rpc               : server.client,
      dwn               : {
        // Local admission may reject a message before reading its body.
        applyReplicatedMessage: async (): Promise<ReplicationApplyResult> => ({ kind: 'Invalid', reason: 'protocol authorization denied' }),
      },
    } as unknown as EnboxPlatformAgent;
    try {
      const outcome = await promptly(admitClosure(rootCid, {
        did    : write.author.did,
        dwnUrl : server.dwnUrl,
        agent,
      }));
      expect(outcome).toMatchObject({ kind: 'failed', rootCid, reason: 'invalid' });
      await promptly(server.released);
    } finally {
      await server.close();
    }
  });
});
