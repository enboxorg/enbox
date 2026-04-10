import { randomBytes } from 'crypto';

/**
 * A lightweight in-memory session entry.
 */
type SessionEntry = {
  /** Opaque session token (hex string). */
  token : string;
  /** Timestamp (ms) when the session was created. */
  createdAt : number;
  /** Timestamp (ms) when the session expires. */
  expiresAt : number;
};

/**
 * Manages short-lived sessions for admin passkey authentication.
 *
 * Sessions are opaque hex tokens stored in an in-memory `Map`. They are
 * validated in {@link validateAdminAuth} as an alternative to the static
 * bearer token. Expired sessions are lazily pruned on every create/validate
 * call and periodically via a cleanup interval.
 *
 * Future: migrate to DID/DWN-based auth (see https://github.com/enboxorg/enbox/issues/546).
 */
export class AdminSessionManager {
  /** Default session time-to-live: 24 hours (in seconds). */
  static readonly #DEFAULT_TTL_SECONDS = 86400;
  /** Cleanup runs every 10 minutes. */
  static readonly #CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

  readonly #sessions: Map<string, SessionEntry> = new Map();
  readonly #ttlMs: number;
  #cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor(ttlSeconds?: number) {
    this.#ttlMs = (ttlSeconds ?? AdminSessionManager.#DEFAULT_TTL_SECONDS) * 1000;
    this.#startCleanup();
  }

  /**
   * Creates a new session and returns the opaque token.
   */
  public create(): string {
    this.#prune();

    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.#sessions.set(token, {
      token,
      createdAt : now,
      expiresAt : now + this.#ttlMs,
    });

    return token;
  }

  /**
   * Validates a session token. Returns `true` if the token is valid and not expired.
   */
  public validate(token: string): boolean {
    const entry = this.#sessions.get(token);
    if (!entry) {
      return false;
    }

    if (Date.now() >= entry.expiresAt) {
      this.#sessions.delete(token);
      return false;
    }

    return true;
  }

  /**
   * Revokes a session token.
   */
  public revoke(token: string): void {
    this.#sessions.delete(token);
  }

  /**
   * Returns the number of active (non-expired) sessions.
   */
  public get size(): number {
    return this.#sessions.size;
  }

  /**
   * Stops the periodic cleanup timer.
   */
  public destroy(): void {
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = undefined;
    }
    this.#sessions.clear();
  }

  /**
   * Removes all expired sessions.
   */
  #prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.#sessions) {
      if (now >= entry.expiresAt) {
        this.#sessions.delete(token);
      }
    }
  }

  #startCleanup(): void {
    this.#cleanupInterval = setInterval((): void => {
      this.#prune();
    }, AdminSessionManager.#CLEANUP_INTERVAL_MS);
  }
}
