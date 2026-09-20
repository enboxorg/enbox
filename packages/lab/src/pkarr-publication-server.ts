import type { Server } from 'bun';

import type { PkarrFetch, PkarrRestoreResult } from './pkarr-publication-adapter.js';

import { PkarrPublicationJournal } from './pkarr-publication-journal.js';
import { PKARR_PACKET_MAX_BYTES, PkarrPublicationAdapter } from './pkarr-publication-adapter.js';

/** BEP44 recommends re-announcing mutable items once per hour. */
export const PKARR_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export type PkarrPublicationServerOptions = {
  fetch?: PkarrFetch;
  hostname?: string;
  journalLocation: string;
  maintenanceIntervalMs?: number;
  port?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  upstreamBaseUrl: string;
};

export type PkarrPublicationServer = {
  endpoint: string;
  restoreResults: PkarrRestoreResult[];
  stop(): Promise<void>;
};

/** Starts the durable adapter only after all retained packets have been restored upstream. */
export async function startPkarrPublicationServer(options: PkarrPublicationServerOptions): Promise<PkarrPublicationServer> {
  const upstreamBaseUrl = new URL(options.upstreamBaseUrl).href;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? PKARR_MAINTENANCE_INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? requestTimeoutMs + 5_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError('Pkarr upstream request timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new RangeError('Pkarr publication server shutdown timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs <= 0) {
    throw new RangeError('Pkarr maintenance interval must be a positive safe integer.');
  }
  const journal = new PkarrPublicationJournal(options.journalLocation);
  const adapter = new PkarrPublicationAdapter({
    fetch: options.fetch,
    journal,
    requestTimeoutMs,
    upstreamBaseUrl,
  });

  let restoreResults: PkarrRestoreResult[];
  try {
    await adapter.probeUpstream();
    restoreResults = await adapter.restore();
    const failure = restoreResults.find((result): boolean => result.status === 'failed');
    if (failure !== undefined) {
      throw new Error(`Pkarr restoration failed for '${failure.identifier}': ${failure.detail ?? 'unknown failure'}`);
    }
  } catch (error: unknown) {
    journal.close();
    throw error;
  }

  const hostname = options.hostname ?? '127.0.0.1';
  let server: Server<undefined>;
  try {
    adapter.startMaintenance(maintenanceIntervalMs);
    server = Bun.serve({
      fetch: async (request): Promise<Response> => {
        const url = new URL(request.url);
        if (url.pathname === '/__lab/health') {
          const maintenanceError = adapter.lastError;
          return Response.json({
            acceptedPublications : journal.list().length,
            maintenanceError     : maintenanceError ?? null,
            status               : maintenanceError === undefined ? 'ready' : 'degraded',
          }, { status: maintenanceError === undefined ? 200 : 503 });
        }
        return adapter.handle(request);
      },
      hostname,
      maxRequestBodySize : PKARR_PACKET_MAX_BYTES,
      port               : options.port ?? 0,
    });
  } catch (error: unknown) {
    adapter.stopMaintenance();
    journal.close();
    throw error;
  }

  let stopped = false;
  return {
    endpoint : `http://${hostname}:${server.port}/`,
    restoreResults,
    stop     : async (): Promise<void> => {
      if (stopped) {
        return;
      }
      stopped = true;
      adapter.beginShutdown();
      const gracefulStop = Promise.all([Promise.resolve(server.stop(false)), adapter.drain()]);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const shutdownTimeout = new Promise<false>((resolve): void => {
        timeoutId = setTimeout((): void => { resolve(false); }, shutdownTimeoutMs);
      });
      const stoppedGracefully = await Promise.race([gracefulStop.then((): true => true), shutdownTimeout]);
      clearTimeout(timeoutId);
      if (!stoppedGracefully) {
        await server.stop(true);
        await adapter.drain();
      }
      journal.close();
    },
  };
}
