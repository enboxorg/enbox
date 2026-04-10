import * as jose from 'jose';
import log from 'loglevel';

/**
 * Built-in "open auth" handler for DWN servers that want registration
 * without any user authentication (open-to-all).
 *
 * Implements the provider-auth-v0 authorize / token / refresh endpoints
 * locally on the DWN server. The authorize endpoint immediately returns
 * an authorization code (no user interaction), the token endpoint exchanges
 * it for a JWT registration token, and the refresh endpoint issues a new token.
 *
 * This is the simplest possible auth backend — suitable for free/public DWN
 * providers. Providers who want real authentication (passkey, OIDC, etc.)
 * host their own auth service and point `providerAuth.authorizeUrl` /
 * `tokenUrl` to it instead.
 *
 * The JWTs issued here are verified by {@link JwtProviderAuthPlugin} using
 * the same shared secret (`DWN_PROVIDER_AUTH_JWT_SECRET`).
 */
/**
 * Maximum number of pending authorization codes held in memory.
 * When the limit is reached, new authorize requests are rejected with 503.
 */
const MAX_PENDING_CODES = 10_000;

/** Interval (ms) at which expired authorization codes are purged. */
const CLEANUP_INTERVAL_MS = 60_000;

export class OpenAuthHandler {
  readonly #secret: Uint8Array;
  readonly #issuer: string;
  /** Pending authorization codes. Maps code → { redirectUri, expiresAt }. */
  readonly #pendingCodes: Map<string, { redirectUri: string; expiresAt: number }>;
  /** Registration token TTL in seconds. Default: 1 year. */
  readonly #tokenTtlSeconds: number;
  /** Periodic cleanup timer for expired codes. */
  readonly #cleanupTimer: ReturnType<typeof setInterval>;

  private constructor(secret: Uint8Array, issuer: string, tokenTtlSeconds: number) {
    this.#secret = secret;
    this.#issuer = issuer;
    this.#pendingCodes = new Map();
    this.#tokenTtlSeconds = tokenTtlSeconds;

    // Periodically purge expired codes so memory does not grow unbounded
    // even when no new authorize requests arrive.
    this.#cleanupTimer = setInterval(() => this.#cleanExpiredCodes(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is still running.
    if (this.#cleanupTimer.unref) {
      this.#cleanupTimer.unref();
    }
  }

  /**
   * Create an {@link OpenAuthHandler}.
   *
   * @param secret - HMAC shared secret (same as `DWN_PROVIDER_AUTH_JWT_SECRET`).
   * @param issuer - JWT issuer claim (typically the DWN server's base URL).
   * @param tokenTtlSeconds - Registration token lifetime in seconds. Default: 1 year.
   */
  public static create(secret: string, issuer: string, tokenTtlSeconds = 365 * 24 * 60 * 60): OpenAuthHandler {
    return new OpenAuthHandler(
      new TextEncoder().encode(secret),
      issuer,
      tokenTtlSeconds,
    );
  }

  /**
   * Handle `GET /provider-auth/authorize`.
   *
   * In open-auth mode this immediately generates a code and redirects back
   * to the `redirect_uri` with `code` and `state` query parameters.
   * No user interaction is required.
   */
  public handleAuthorize(url: URL): Response {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');

    if (!redirectUri) {
      return Response.json(
        { error: 'missing redirect_uri parameter' },
        { status: 400 },
      );
    }

    // Reject new codes when the map is at capacity to prevent memory exhaustion.
    if (this.#pendingCodes.size >= MAX_PENDING_CODES) {
      log.warn(`OpenAuthHandler: pending codes map is full (${MAX_PENDING_CODES}), rejecting authorize request`);
      return Response.json(
        { error: 'server is busy, try again later' },
        { status: 503 },
      );
    }

    // Generate a random authorization code.
    const code = crypto.randomUUID();

    // Store the code with a 10-minute expiry.
    this.#pendingCodes.set(code, {
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // Periodically clean up expired codes (simple inline sweep).
    this.#cleanExpiredCodes();

    // Build redirect URL.
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) {
      redirect.searchParams.set('state', state);
    }

    log.debug(`OpenAuthHandler: issued code ${code.slice(0, 8)}… for redirect to ${redirectUri}`);

    return Response.json({
      code,
      state       : state ?? undefined,
      redirectUri : redirect.toString(),
    });
  }

  /**
   * Handle `POST /provider-auth/token`.
   *
   * Exchanges an authorization code for a JWT registration token.
   * Request body: `{ code: string, redirectUri: string }`.
   */
  public async handleToken(req: Request): Promise<Response> {
    let body: { code?: string; redirectUri?: string };
    try {
      body = await req.json() as { code?: string; redirectUri?: string };
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const { code, redirectUri } = body;
    if (!code || !redirectUri) {
      return Response.json(
        { error: 'missing code or redirectUri' },
        { status: 400 },
      );
    }

    // Validate the authorization code.
    const pending = this.#pendingCodes.get(code);
    if (!pending) {
      return Response.json({ error: 'invalid or expired code' }, { status: 400 });
    }

    if (pending.redirectUri !== redirectUri) {
      return Response.json({ error: 'redirect_uri mismatch' }, { status: 400 });
    }

    if (Date.now() > pending.expiresAt) {
      this.#pendingCodes.delete(code);
      return Response.json({ error: 'code expired' }, { status: 400 });
    }

    // Consume the code (one-time use).
    this.#pendingCodes.delete(code);

    // Generate an account ID for this session (open auth = anonymous accounts).
    const accountId = crypto.randomUUID();

    // Issue JWT registration token.
    const registrationToken = await this.#signToken(accountId, this.#tokenTtlSeconds);

    // Issue refresh token with longer TTL (2x).
    const refreshToken = await this.#signToken(accountId, this.#tokenTtlSeconds * 2, 'refresh');

    log.debug(`OpenAuthHandler: exchanged code for account ${accountId.slice(0, 8)}…`);

    return Response.json({
      registrationToken,
      refreshToken,
      expiresIn : this.#tokenTtlSeconds,
      tokenType : 'bearer',
    });
  }

  /**
   * Handle `POST /provider-auth/refresh`.
   *
   * Exchanges a refresh token for a new registration token.
   * Request body: `{ refreshToken: string }`.
   */
  public async handleRefresh(req: Request): Promise<Response> {
    let body: { refreshToken?: string };
    try {
      body = await req.json() as { refreshToken?: string };
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    if (!body.refreshToken) {
      return Response.json({ error: 'missing refreshToken' }, { status: 400 });
    }

    // Verify the refresh token.
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(body.refreshToken, this.#secret, {
        issuer: this.#issuer,
      });
      payload = result.payload;
    } catch (error) {
      return Response.json(
        { error: `invalid refresh token: ${(error as Error).message}` },
        { status: 400 },
      );
    }

    if (payload.purpose !== 'refresh') {
      return Response.json({ error: 'token is not a refresh token' }, { status: 400 });
    }

    const accountId = payload.sub ?? crypto.randomUUID();

    // Issue new tokens.
    const registrationToken = await this.#signToken(accountId, this.#tokenTtlSeconds);
    const refreshToken = await this.#signToken(accountId, this.#tokenTtlSeconds * 2, 'refresh');

    log.debug(`OpenAuthHandler: refreshed token for account ${accountId.slice(0, 8)}…`);

    return Response.json({
      registrationToken,
      refreshToken,
      expiresIn : this.#tokenTtlSeconds,
      tokenType : 'bearer',
    });
  }

  /** Sign a JWT with the shared secret. */
  async #signToken(accountId: string, ttlSeconds: number, purpose = 'registration'): Promise<string> {
    return new jose.SignJWT({ purpose })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.#issuer)
      .setAudience(this.#issuer)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.#secret);
  }

  /** Stops the periodic cleanup timer and clears all pending codes. */
  public destroy(): void {
    clearInterval(this.#cleanupTimer);
    this.#pendingCodes.clear();
  }

  /** Remove expired authorization codes from the pending map. */
  #cleanExpiredCodes(): void {
    const now = Date.now();
    for (const [code, data] of this.#pendingCodes) {
      if (now > data.expiresAt) {
        this.#pendingCodes.delete(code);
      }
    }
  }
}
