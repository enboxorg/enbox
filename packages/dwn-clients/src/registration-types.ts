/**
 * Proof-of-work challenge returned by `GET /registration/proof-of-work`.
 */
export type ProofOfWorkChallengeModel = {
  challengeNonce: string;
  maximumAllowedHashValue: string;
};

/**
 * Registration data included in the `POST /registration` request body.
 */
export type RegistrationData = {
  did: string;
  termsOfServiceHash?: string;
};

/**
 * Full registration request body for `POST /registration`.
 */
export type RegistrationRequest = {
  proofOfWork?: {
    challengeNonce: string;
    responseNonce: string;
  },
  /**
   * Provider-auth-v0 credentials. Present when the server requires
   * `'provider-auth-v0'` registration.
   */
  providerAuth?: {
    /** The registration token obtained from the token exchange endpoint. */
    registrationToken: string;
  },
  registrationData: RegistrationData,
};

/**
 * Request body for `POST {tokenUrl}` — exchanges an authorization code for a
 * registration token. Sent by the wallet to the provider's auth service.
 */
export type TokenExchangeRequest = {
  /** Grant type identifier. */
  grantType : 'authorization_code';
  /** The authorization code received from the provider's redirect. */
  code : string;
  /** The redirect URI used in the authorization request (must match exactly). */
  redirectUri : string;
};

/**
 * Response body from `POST {tokenUrl}` or `POST {refreshUrl}` — contains the
 * registration token and optional refresh token.
 */
export type TokenExchangeResponse = {
  /** Opaque registration token for use with `POST /registration`. */
  registrationToken : string;
  /** Opaque refresh token for obtaining new registration tokens. */
  refreshToken? : string;
  /** Token lifetime in seconds. If absent, the token does not expire. */
  expiresIn? : number;
  /** Token type hint (e.g. `'bearer'`). */
  tokenType : string;
};

/**
 * Request body for `POST {refreshUrl}` — refreshes an expired registration
 * token.
 */
export type TokenRefreshRequest = {
  /** Grant type identifier. */
  grantType : 'refresh_token';
  /** The refresh token obtained from a prior token exchange. */
  refreshToken : string;
};
