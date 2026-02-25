import type { ProviderAuthPlugin, ProviderAuthValidationResult } from './provider-auth-plugin.js';

import * as jose from 'jose';
import log from 'loglevel';

/**
 * Options for creating a {@link JwtProviderAuthPlugin}.
 * Exactly one of `secret` or `jwksUrl` must be provided.
 */
export type JwtProviderAuthPluginOptions = {
  /** HMAC shared secret for HS256/HS384/HS512 tokens. */
  secret? : string;
  /** JWKS endpoint URL for RS256/ES256/EdDSA tokens. */
  jwksUrl? : string;
  /** Expected JWT `iss` claim. If set, tokens without a matching issuer are rejected. */
  issuer? : string;
  /** Expected JWT `aud` claim. If set, tokens without a matching audience are rejected. */
  audience? : string;
};

/**
 * Built-in {@link ProviderAuthPlugin} that validates JWT registration tokens.
 *
 * Supports two modes:
 * - **HMAC secret** (`DWN_PROVIDER_AUTH_JWT_SECRET`): symmetric HS256 verification.
 * - **JWKS URL** (`DWN_PROVIDER_AUTH_JWT_JWKS_URL`): asymmetric verification via
 *   a remote JWKS endpoint (RS256, ES256, EdDSA, etc.). Keys are cached and
 *   rotated automatically by `jose`.
 *
 * The JWT payload may include:
 * - `sub` — mapped to `accountId` in the validation result.
 * - `metadata` — arbitrary provider-defined object stored with the tenant.
 *
 * This plugin ships with `@enbox/dwn-server` and requires no external code.
 * Providers who need custom validation logic can implement their own
 * {@link ProviderAuthPlugin} instead.
 */
export class JwtProviderAuthPlugin implements ProviderAuthPlugin {
  #getKey: Uint8Array | jose.JWTVerifyGetKey;
  #issuer: string | undefined;
  #audience: string | undefined;

  private constructor(
    getKey: Uint8Array | jose.JWTVerifyGetKey,
    issuer?: string,
    audience?: string,
  ) {
    this.#getKey = getKey;
    this.#issuer = issuer;
    this.#audience = audience;
  }

  /**
   * Create a {@link JwtProviderAuthPlugin} from options.
   *
   * @param options - Must include exactly one of `secret` or `jwksUrl`.
   * @throws If neither `secret` nor `jwksUrl` is provided.
   */
  public static async create(options: JwtProviderAuthPluginOptions): Promise<JwtProviderAuthPlugin> {
    if (!options.secret && !options.jwksUrl) {
      throw new Error(
        'JwtProviderAuthPlugin: exactly one of `secret` or `jwksUrl` must be provided.',
      );
    }

    let getKey: any;
    if (options.secret) {
      getKey = new TextEncoder().encode(options.secret);
    } else {
      getKey = jose.createRemoteJWKSet(new URL(options.jwksUrl!));
    }

    return new JwtProviderAuthPlugin(getKey, options.issuer, options.audience);
  }

  /**
   * Create a {@link JwtProviderAuthPlugin} from environment variables.
   *
   * Reads `DWN_PROVIDER_AUTH_JWT_SECRET`, `DWN_PROVIDER_AUTH_JWT_JWKS_URL`,
   * and optionally `DWN_PROVIDER_AUTH_JWT_ISSUER` / `DWN_PROVIDER_AUTH_JWT_AUDIENCE`.
   */
  public static async fromEnv(): Promise<JwtProviderAuthPlugin> {
    return JwtProviderAuthPlugin.create({
      secret   : process.env.DWN_PROVIDER_AUTH_JWT_SECRET,
      jwksUrl  : process.env.DWN_PROVIDER_AUTH_JWT_JWKS_URL,
      issuer   : process.env.DWN_PROVIDER_AUTH_JWT_ISSUER,
      audience : process.env.DWN_PROVIDER_AUTH_JWT_AUDIENCE,
    });
  }

  /** @inheritdoc */
  public async validateRegistrationToken(token: string): Promise<ProviderAuthValidationResult> {
    try {
      const verifyOptions: jose.JWTVerifyOptions = {};
      if (this.#issuer !== undefined) {
        verifyOptions.issuer = this.#issuer;
      }
      if (this.#audience !== undefined) {
        verifyOptions.audience = this.#audience;
      }

      const { payload } = await jose.jwtVerify(token, this.#getKey as any, verifyOptions);

      return {
        isValid   : true,
        accountId : typeof payload.sub === 'string' ? payload.sub : undefined,
        metadata  : typeof payload.metadata === 'object' && payload.metadata !== null
          ? payload.metadata as Record<string, unknown>
          : undefined,
      };
    } catch (error) {
      log.debug('JWT validation failed:', (error as Error).message);
      return {
        isValid : false,
        detail  : (error as Error).message,
      };
    }
  }
}
