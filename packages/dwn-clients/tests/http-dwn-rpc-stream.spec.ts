import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { HttpDwnRpcClient } from '../src/http-dwn-rpc-client.js';
import { RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject): void => {
        timer = setTimeout(() => reject(new Error('HTTP response was not released promptly.')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function streamingDwn(recordsWrite: RecordsWriteMessage): {
  client: HttpDwnRpcClient;
  url: URL;
  responses: Map<string, { enqueue: (chunk: Uint8Array) => void; released: Promise<void> }>;
  close: () => Promise<void>;
  } {
  const responses = new Map<string, { enqueue: (chunk: Uint8Array) => void; released: Promise<void> }>();
  const server = Bun.serve({
    hostname : '127.0.0.1',
    port     : 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/info')) {
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

      const { id } = JSON.parse(request.headers.get('dwn-request')!) as { id: string };
      const aborted = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      request.signal.addEventListener('abort', (): void => { aborted.resolve(); }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          responses.set(path, {
            enqueue  : (chunk): void => { controller.enqueue(chunk); },
            released : Promise.all([aborted.promise, cancelled.promise]).then((): void => {}),
          });
        },
        cancel(): void {
          cancelled.resolve();
        },
      });
      return new Response(body, { headers: {
        'content-type' : 'application/octet-stream',
        'dwn-response' : JSON.stringify({ jsonrpc : '2.0', id, result  : { reply: {
          status: { code: 200, detail: 'OK' }, entry: { recordsWrite },
        } } }),
      } });
    },
  });
  return {
    client : new HttpDwnRpcClient(undefined, { maxRetries: 0 }),
    url    : server.url,
    responses,
    close  : async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

describe('HttpDwnRpcClient response streams', () => {
  it('releases the HTTP response when an unread record stream is cancelled', async () => {
    const { message: recordsWrite } = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), published: true,
    });
    const { message } = await RecordsRead.create({ filter: { recordId: recordsWrite.recordId } });
    const server = streamingDwn(recordsWrite);
    try {
      const reply = await promptly(server.client.sendDwnRequest({
        dwnUrl    : server.url.href,
        targetDid : 'did:example:alice',
        message,
      }));
      await promptly(reply.entry!.data!.cancel('record is no longer needed'));
      await expect(promptly(server.responses.get('/')!.released)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('cancels one response without aborting another request that shares the caller signal', async () => {
    const { message: recordsWrite } = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), published: true,
    });
    const { message } = await RecordsRead.create({ filter: { recordId: recordsWrite.recordId } });
    const server = streamingDwn(recordsWrite);
    const controller = new AbortController();
    try {
      const request = { targetDid: 'did:example:alice', message, signal: controller.signal };
      const first = await promptly(server.client.sendDwnRequest({ ...request, dwnUrl: new URL('/first', server.url).href }));
      const second = await promptly(server.client.sendDwnRequest({ ...request, dwnUrl: new URL('/second', server.url).href }));
      const firstReader = first.entry!.data!.getReader();
      const secondReader = second.entry!.data!.getReader();
      try {
        expect((await promptly(firstReader.read())).value).toEqual(new Uint8Array([1, 2, 3]));
        expect((await promptly(secondReader.read())).value).toEqual(new Uint8Array([1, 2, 3]));
        await promptly(firstReader.cancel('first record is no longer needed'));
        await promptly(server.responses.get('/first')!.released);
        expect(controller.signal.aborted).toBe(false);

        const laterBytes = new Uint8Array([4, 5, 6]);
        server.responses.get('/second')!.enqueue(laterBytes);
        expect(await promptly(secondReader.read())).toEqual({ value: laterBytes, done: false });
        controller.abort();
        await promptly(server.responses.get('/second')!.released);
      } finally {
        firstReader.releaseLock();
        secondReader.releaseLock();
      }
    } finally {
      controller.abort();
      await server.close();
    }
  });
});
