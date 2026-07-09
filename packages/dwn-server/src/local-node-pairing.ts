import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';

export type LocalNodePairingCreateResult =
  | { status: 'created'; requestId: string }
  | { status: 'coalesced'; requestId: string }
  | { status: 'invalid-origin'; message: string }
  | { status: 'rate-limited'; retryAfterMs: number };

export type LocalNodePairingPollResult =
  | { status: 'pending'; origin: string }
  | { status: 'approved'; origin: string; token?: string }
  | { status: 'denied'; origin: string }
  | { status: 'expired'; origin: string };

export type LocalNodePairingRequestView = {
  id : string;
  origin : string;
  status : LocalNodePairingPollResult['status'];
  createdAt : number;
  expiresAt : number;
};

export type LocalNodePairingSessionRecord = {
  createdAt : number;
  origin? : string;
  token : string;
};

export type LocalNodePairingSessionsChangedListener = (sessions: LocalNodePairingSessionRecord[]) => void;

export type LocalNodePairingManagerOptions = {
  now? : () => number;
  pairingRequestTtlMs? : number;
  pairingRateLimitMax? : number;
  pairingRateLimitWindowMs? : number;
  terminalRequestRetentionMs?: number;
};

type LocalNodePairingRequest = {
  id : string;
  origin : string;
  status : LocalNodePairingPollResult['status'];
  createdAt : number;
  expiresAt : number;
  completedAt? : number;
  token? : string;
  tokenReturned : boolean;
};

type LocalNodeSession = {
  origin : string | undefined;
  token : string;
  createdAt : number;
};

const defaultPairingRequestTtlMs = 5 * 60 * 1000;
const defaultPairingRateLimitMax = 5;
const defaultPairingRateLimitWindowMs = 60 * 1000;
const defaultTerminalRequestRetentionMs = 5 * 60 * 1000;

function normalizeOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) {
      return undefined;
    }
    return origin;
  } catch {
    return undefined;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class LocalNodePairingManager {
  readonly #now: () => number;
  readonly #pairingRequestTtlMs: number;
  readonly #pairingRateLimitMax: number;
  readonly #pairingRateLimitWindowMs: number;
  readonly #terminalRequestRetentionMs: number;
  readonly #requests: Map<string, LocalNodePairingRequest> = new Map();
  readonly #pendingRequestIdsByOrigin: Map<string, string> = new Map();
  readonly #pairingAttemptsByOrigin: Map<string, number[]> = new Map();
  readonly #sessionsByToken: Map<string, LocalNodeSession> = new Map();
  readonly #sessionsChangedListeners: Set<LocalNodePairingSessionsChangedListener> = new Set();

  public constructor(options: LocalNodePairingManagerOptions = {}) {
    this.#now = options.now ?? ((): number => Date.now());
    this.#pairingRequestTtlMs = options.pairingRequestTtlMs ?? defaultPairingRequestTtlMs;
    this.#pairingRateLimitMax = options.pairingRateLimitMax ?? defaultPairingRateLimitMax;
    this.#pairingRateLimitWindowMs = options.pairingRateLimitWindowMs ?? defaultPairingRateLimitWindowMs;
    this.#terminalRequestRetentionMs = options.terminalRequestRetentionMs ?? defaultTerminalRequestRetentionMs;
  }

  public createRequest(originHeader: string | null): LocalNodePairingCreateResult {
    if (originHeader === null) {
      return { status: 'invalid-origin', message: 'Origin header is required.' };
    }

    const origin = normalizeOrigin(originHeader);
    if (origin === undefined) {
      return { status: 'invalid-origin', message: 'Origin header must be an http(s) origin.' };
    }

    const now = this.#now();
    this.#prune(now);

    const pendingRequestId = this.#pendingRequestIdsByOrigin.get(origin);
    if (pendingRequestId !== undefined) {
      const pendingRequest = this.#requests.get(pendingRequestId);
      if (pendingRequest !== undefined && pendingRequest.status === 'pending' && pendingRequest.expiresAt > now) {
        return { status: 'coalesced', requestId: pendingRequest.id };
      }
    }

    const retryAfterMs = this.#consumePairingAttempt(origin, now);
    if (retryAfterMs !== undefined) {
      return { status: 'rate-limited', retryAfterMs };
    }

    const request: LocalNodePairingRequest = {
      createdAt     : now,
      expiresAt     : now + this.#pairingRequestTtlMs,
      id            : randomUUID(),
      origin,
      status        : 'pending',
      tokenReturned : false,
    };

    this.#requests.set(request.id, request);
    this.#pendingRequestIdsByOrigin.set(origin, request.id);

    return { status: 'created', requestId: request.id };
  }

  public approveRequest(requestId: string): boolean {
    const request = this.#getActivePendingRequest(requestId);
    if (request === undefined) {
      return false;
    }

    const now = this.#now();
    const token = randomBytes(32).toString('base64url');
    request.status = 'approved';
    request.completedAt = now;
    request.token = token;
    this.#pendingRequestIdsByOrigin.delete(request.origin);
    this.#sessionsByToken.set(token, { createdAt: now, origin: request.origin, token });
    this.#notifySessionsChanged();

    return true;
  }

  public denyRequest(requestId: string): boolean {
    const request = this.#getActivePendingRequest(requestId);
    if (request === undefined) {
      return false;
    }

    request.status = 'denied';
    request.completedAt = this.#now();
    this.#pendingRequestIdsByOrigin.delete(request.origin);

    return true;
  }

  public pollRequest(requestId: string): LocalNodePairingPollResult | undefined {
    const request = this.#requests.get(requestId);
    if (request === undefined) {
      return undefined;
    }

    const now = this.#now();
    if (request.status === 'pending' && request.expiresAt <= now) {
      request.status = 'expired';
      request.completedAt = now;
      this.#pendingRequestIdsByOrigin.delete(request.origin);
    }

    if (request.status === 'approved') {
      if (request.tokenReturned || request.token === undefined) {
        return { origin: request.origin, status: 'approved' };
      }

      request.tokenReturned = true;
      return { origin: request.origin, status: 'approved', token: request.token };
    }

    return { origin: request.origin, status: request.status };
  }

  public getRequest(requestId: string): LocalNodePairingRequestView | undefined {
    const request = this.#requests.get(requestId);
    if (request === undefined) {
      return undefined;
    }

    return {
      createdAt : request.createdAt,
      expiresAt : request.expiresAt,
      id        : request.id,
      origin    : request.origin,
      status    : request.status,
    };
  }

  public listPendingRequests(): LocalNodePairingRequestView[] {
    const now = this.#now();
    this.#prune(now);

    return Array.from(this.#requests.values())
      .filter((request: LocalNodePairingRequest): boolean => request.status === 'pending')
      .map((request: LocalNodePairingRequest): LocalNodePairingRequestView => ({
        createdAt : request.createdAt,
        expiresAt : request.expiresAt,
        id        : request.id,
        origin    : request.origin,
        status    : request.status,
      }));
  }

  public createSession(origin: string | undefined): string {
    const normalizedOrigin = origin === undefined ? undefined : normalizeOrigin(origin);
    if (origin !== undefined && normalizedOrigin === undefined) {
      throw new Error('LocalNodePairingManager: origin must be an http(s) origin.');
    }

    const token = randomBytes(32).toString('base64url');
    this.#sessionsByToken.set(token, {
      createdAt : this.#now(),
      origin    : normalizedOrigin,
      token,
    });
    this.#notifySessionsChanged();

    return token;
  }

  /**
   * Registers a listener that is called synchronously after the set of pairing sessions changes.
   * The returned function removes the listener.
   */
  public onSessionsChanged(listener: LocalNodePairingSessionsChangedListener): () => void {
    this.#sessionsChangedListeners.add(listener);
    return (): void => {
      this.#sessionsChangedListeners.delete(listener);
    };
  }

  public exportSessions(): LocalNodePairingSessionRecord[] {
    return Array.from(this.#sessionsByToken.values())
      .map((session: LocalNodeSession): LocalNodePairingSessionRecord => {
        const record: LocalNodePairingSessionRecord = {
          createdAt : session.createdAt,
          token     : session.token,
        };

        if (session.origin !== undefined) {
          record.origin = session.origin;
        }

        return record;
      });
  }

  public importSessions(sessions: LocalNodePairingSessionRecord[]): void {
    this.#sessionsByToken.clear();

    for (const session of sessions) {
      this.#sessionsByToken.set(session.token, {
        createdAt : session.createdAt,
        origin    : session.origin,
        token     : session.token,
      });
    }
  }

  public validateSession(origin: string | undefined, token: string | undefined): boolean {
    if (token === undefined) {
      return false;
    }

    const session = this.#sessionsByToken.get(token);
    if (session === undefined || !constantTimeEqual(session.token, token)) {
      return false;
    }

    if (session.origin === undefined) {
      return origin === undefined;
    }

    return origin === session.origin;
  }

  public isOriginPaired(originHeader: string | null): boolean {
    if (originHeader === null || normalizeOrigin(originHeader) === undefined) {
      return false;
    }

    for (const session of this.#sessionsByToken.values()) {
      if (session.origin === originHeader) {
        return true;
      }
    }

    return false;
  }

  public revokeToken(token: string): boolean {
    const revoked = this.#sessionsByToken.delete(token);
    if (revoked) {
      this.#notifySessionsChanged();
    }

    return revoked;
  }

  #notifySessionsChanged(): void {
    const sessions = this.exportSessions();
    for (const listener of this.#sessionsChangedListeners) {
      listener(sessions.map((session: LocalNodePairingSessionRecord): LocalNodePairingSessionRecord => ({ ...session })));
    }
  }

  #getActivePendingRequest(requestId: string): LocalNodePairingRequest | undefined {
    const request = this.#requests.get(requestId);
    const now = this.#now();
    if (request === undefined || request.status !== 'pending') {
      return undefined;
    }

    if (request.expiresAt <= now) {
      request.status = 'expired';
      request.completedAt = now;
      this.#pendingRequestIdsByOrigin.delete(request.origin);
      return undefined;
    }

    return request;
  }

  #consumePairingAttempt(origin: string, now: number): number | undefined {
    const attemptWindowStart = now - this.#pairingRateLimitWindowMs;
    const recentAttempts = (this.#pairingAttemptsByOrigin.get(origin) ?? [])
      .filter((attemptedAt: number): boolean => attemptedAt > attemptWindowStart);

    if (recentAttempts.length >= this.#pairingRateLimitMax) {
      return this.#pairingRateLimitWindowMs - (now - recentAttempts[0]);
    }

    recentAttempts.push(now);
    this.#pairingAttemptsByOrigin.set(origin, recentAttempts);

    return undefined;
  }

  #prune(now: number): void {
    const terminalRequestCutoff = now - this.#terminalRequestRetentionMs;
    for (const [requestId, request] of this.#requests) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired';
        request.completedAt = now;
        this.#pendingRequestIdsByOrigin.delete(request.origin);
      }

      if (request.status !== 'pending' && request.completedAt !== undefined && request.completedAt <= terminalRequestCutoff) {
        this.#requests.delete(requestId);
      }
    }

    const attemptWindowStart = now - this.#pairingRateLimitWindowMs;
    for (const [origin, attempts] of this.#pairingAttemptsByOrigin) {
      const recentAttempts = attempts.filter((attemptedAt: number): boolean => attemptedAt > attemptWindowStart);
      if (recentAttempts.length === 0) {
        this.#pairingAttemptsByOrigin.delete(origin);
      } else {
        this.#pairingAttemptsByOrigin.set(origin, recentAttempts);
      }
    }
  }
}
