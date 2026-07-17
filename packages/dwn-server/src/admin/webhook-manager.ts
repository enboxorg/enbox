import type { Dialect } from '@enbox/dwn-sql-store';
import type { AdminWebhook, AdminWebhookInput } from './types.js';

import { createHmac } from 'node:crypto';
import log from 'loglevel';
import { sleep } from '@enbox/common';
import { Kysely, sql } from 'kysely';

/**
 * Payload delivered to webhook endpoints.
 */
export type WebhookPayload = {
  /** Unique delivery ID. */
  id : string;
  /** ISO-8601 timestamp. */
  timestamp : string;
  /** Event type (e.g. `tenant.suspend`, `quota.warning`). */
  event : string;
  /** Optional target (e.g. tenant DID). */
  target? : string;
  /** Additional event data. */
  data? : Record<string, unknown>;
};

/**
 * Manages webhook registrations and event delivery.
 *
 * Webhooks are stored in a SQL table and fire asynchronously when matching
 * events occur. Delivery includes retry logic and optional HMAC-SHA256 signatures.
 *
 * @see https://github.com/enboxorg/enbox/issues/395
 */
export class WebhookManager {
  static readonly #tableName = 'adminWebhooks';
  static readonly #maxRetries = 3;
  static readonly #retryDelaysMs = [1000, 5000, 15000];

  readonly #db: Kysely<WebhookDatabase>;

  private constructor(dialect: Dialect) {
    this.#db = new Kysely<WebhookDatabase>({ dialect });
  }

  /**
   * Creates and initializes a `WebhookManager` instance.
   */
  public static async create(dialect: Dialect): Promise<WebhookManager> {
    const manager = new WebhookManager(dialect);
    await manager.#initialize();
    return manager;
  }

  /**
   * Verifies that the required table exists. Throws a clear error directing
   * the caller to run server migrations first.
   */
  async #initialize(): Promise<void> {
    try {
      await sql`SELECT 1 FROM ${sql.table(WebhookManager.#tableName)} LIMIT 0`.execute(this.#db);
    } catch {
      throw new Error(
        `WebhookManager: table '${WebhookManager.#tableName}' does not exist. Run server migrations before starting.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Registers a new webhook. Returns the created webhook (without secret echoed).
   */
  public async register(input: AdminWebhookInput): Promise<AdminWebhook> {
    const webhook: AdminWebhook = {
      id        : crypto.randomUUID(),
      url       : input.url,
      events    : input.events,
      createdAt : new Date().toISOString(),
    };

    await this.#db
      .insertInto(WebhookManager.#tableName)
      .values({
        id        : webhook.id,
        url       : webhook.url,
        events    : JSON.stringify(webhook.events),
        secret    : input.secret ?? null,
        createdAt : webhook.createdAt,
      })
      .execute();

    return webhook;
  }

  /**
   * Lists all registered webhooks. Secrets are redacted.
   */
  public async list(): Promise<AdminWebhook[]> {
    const rows = await this.#db
      .selectFrom(WebhookManager.#tableName)
      .select(['id', 'url', 'events', 'secret', 'createdAt'])
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row): AdminWebhook => ({
      id        : row.id,
      url       : row.url,
      events    : JSON.parse(row.events),
      secret    : row.secret ? '***' : undefined,
      createdAt : row.createdAt,
    }));
  }

  /**
   * Deletes a webhook by ID. Returns `true` if found and deleted.
   */
  public async delete(id: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom(WebhookManager.#tableName)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return Number(result.numDeletedRows) > 0;
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  /**
   * Fires matching webhooks for a given event. Non-blocking — delivery happens
   * asynchronously and errors are logged but never propagated.
   */
  public fire(event: string, target?: string, data?: Record<string, unknown>): void {
    // Fire-and-forget.
    this.#dispatchAll(event, target, data).catch((err): void => {
      log.error('Webhook dispatch error:', err);
    });
  }

  async #dispatchAll(event: string, target?: string, data?: Record<string, unknown>): Promise<void> {
    const rows = await this.#db
      .selectFrom(WebhookManager.#tableName)
      .select(['id', 'url', 'events', 'secret'])
      .execute();

    const payload: WebhookPayload = {
      id        : crypto.randomUUID(),
      timestamp : new Date().toISOString(),
      event,
      target,
      data,
    };

    const body = JSON.stringify(payload);

    for (const row of rows) {
      const patterns: string[] = JSON.parse(row.events);
      if (this.#matchesEvent(event, patterns)) {
        this.#deliver(row.url, body, row.secret).catch((err): void => {
          log.warn(`Webhook delivery failed for ${row.url}:`, err);
        });
      }
    }
  }

  /**
   * Checks if an event matches any of the subscription patterns.
   * Supports wildcard patterns like `tenant.*`.
   */
  #matchesEvent(event: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === '*') {
        return true;
      }
      if (pattern === event) {
        return true;
      }
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        if (event.startsWith(prefix + '.') || event === prefix) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Delivers a webhook payload with retry logic and optional HMAC signature.
   */
  async #deliver(url: string, body: string, secret: string | null): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (secret) {
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      headers['x-webhook-signature'] = `sha256=${signature}`;
    }

    for (let attempt = 0; attempt <= WebhookManager.#maxRetries; attempt++) {
      try {
        const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          return;
        }
        log.warn(`Webhook ${url} returned ${response.status} (attempt ${attempt + 1})`);
      } catch (err) {
        log.warn(`Webhook ${url} fetch error (attempt ${attempt + 1}):`, err);
      }

      // Wait before retry (skip wait on last attempt).
      if (attempt < WebhookManager.#maxRetries) {
        await sleep(WebhookManager.#retryDelaysMs[attempt]);
      }
    }

    log.error(`Webhook delivery to ${url} failed after ${WebhookManager.#maxRetries + 1} attempts`);
  }

  /**
   * Closes the underlying database connection.
   */
  public async close(): Promise<void> {
    await this.#db.destroy();
  }
}

// ---------------------------------------------------------------------------
// Kysely type definitions
// ---------------------------------------------------------------------------

interface WebhookRow {
  id : string;
  url : string;
  events : string; // JSON-serialized string[]
  secret : string | null;
  createdAt : string;
}

interface WebhookDatabase {
  adminWebhooks : WebhookRow;
}
