import type { Dialect } from '@enbox/dwn-sql-store';

import { CryptoUtils } from '@enbox/crypto';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SqlTtlCache } from './sql-ttl-cache.js';

export const CONNECT_PAIRING_VERSION = '3' as const;

export type ConnectPairingRole = 'client' | 'wallet';
export type ConnectPairingClientStage = 'confirmation' | 'request';
export type ConnectPairingWalletStage = 'decision' | 'response';
export type ConnectPairingStage = ConnectPairingClientStage | ConnectPairingWalletStage;

export type ConnectPairingReveal = {
  nonce : string;
  public_key : string;
};

export type ConnectPairingFrame = {
  frame : string;
  stage : ConnectPairingStage;
};

type ConnectPairingFailure =
  | 'already-claimed'
  | 'commitment-mismatch'
  | 'conflict'
  | 'invalid-state'
  | 'not-found'
  | 'pending'
  | 'unauthorized';

export type ConnectPairingResult<T extends object = object> =
  | ({ status: 'ok' } & T)
  | { status: ConnectPairingFailure };

type PairingRecord = {
  clientCapabilityHash : string;
  clientCommitment : string;
  expiresAt : number;
  relayOrigin : string;
  version : typeof CONNECT_PAIRING_VERSION;
};

type ClaimRecord = {
  version : typeof CONNECT_PAIRING_VERSION;
  walletCapabilityHash : string;
  walletCommitment : string;
  walletOrigin : string;
};

type RevealRecord = {
  nonce : string;
  publicKey : string;
  version : typeof CONNECT_PAIRING_VERSION;
};

type FrameRecord = ConnectPairingFrame & {
  direction : ConnectPairingRole;
  version : typeof CONNECT_PAIRING_VERSION;
};

type PairingAuthorization = {
  claim? : ClaimRecord;
  pairing : PairingRecord;
};

const capabilityDomain = 'enbox-connect-v3:capability\0';
const commitmentDomain = 'enbox-connect-v3:key-commitment\0';

/** Opaque, capability-authenticated relay state for Connect v3 pairings. */
export class ConnectPairingServer {
  public static readonly maxFrameBytes = 256 * 1024;
  public static readonly pollingIntervalInSeconds = 2;
  public static readonly ttlInSeconds = 600;

  private readonly baseUrl: string;
  private readonly relayOrigin: string;
  private cache: SqlTtlCache;

  public static async create({ baseUrl, sqlDialect }: {
    baseUrl: string;
    sqlDialect: Dialect;
  }): Promise<ConnectPairingServer> {
    const server = new ConnectPairingServer(baseUrl);
    server.cache = await SqlTtlCache.create(sqlDialect);
    return server;
  }

  private constructor(baseUrl: string) {
    const url = new URL(baseUrl);
    if (!ConnectPairingServer.isSecureOrigin(url.origin)) {
      throw new TypeError('ConnectPairingServer: baseUrl must use HTTPS, except on localhost.');
    }
    if (baseUrl !== url.origin && baseUrl !== `${url.origin}/`) {
      throw new TypeError('ConnectPairingServer: baseUrl must be a canonical origin.');
    }

    this.baseUrl = url.origin;
    this.relayOrigin = url.origin;
  }

  /** Creates a pairing and returns its public locator plus a client-only capability. */
  public async create(clientCommitment: string): Promise<ConnectPairingResult<{
    client_capability : string;
    expires_in : number;
    interval : number;
    pair_uri : string;
    pairing_id : string;
    relay_origin : string;
    version : typeof CONNECT_PAIRING_VERSION;
  }>> {
    ConnectPairingServer.assertBase64Url32(clientCommitment, 'client key commitment');

    const clientCapability = ConnectPairingServer.createCapability();
    const pairingId = CryptoUtils.randomUuid();
    const record: PairingRecord = {
      clientCapabilityHash : ConnectPairingServer.hashCapability(clientCapability),
      clientCommitment,
      expiresAt            : Date.now() + (ConnectPairingServer.ttlInSeconds * 1000),
      relayOrigin          : this.relayOrigin,
      version              : CONNECT_PAIRING_VERSION,
    };
    await this.cache.insert(ConnectPairingServer.key(pairingId), record, ConnectPairingServer.ttlInSeconds);

    return {
      client_capability : clientCapability,
      expires_in        : ConnectPairingServer.ttlInSeconds,
      interval          : ConnectPairingServer.pollingIntervalInSeconds,
      pair_uri          : `${this.baseUrl}/connect/v3/pairings/${pairingId}`,
      pairing_id        : pairingId,
      relay_origin      : this.relayOrigin,
      status            : 'ok',
      version           : CONNECT_PAIRING_VERSION,
    };
  }

  /** Atomically records the first wallet commitment and returns its capability once. */
  public async claim(
    pairingId: string,
    walletCommitment: string,
    walletOrigin: string,
    walletCapability: string,
  ): Promise<ConnectPairingResult<{
    client_key_commitment : string;
    relay_origin : string;
    version : typeof CONNECT_PAIRING_VERSION;
    wallet_origin : string;
  }>> {
    ConnectPairingServer.assertBase64Url32(walletCommitment, 'wallet key commitment');
    ConnectPairingServer.assertBase64Url32(walletCapability, 'wallet capability');
    const normalizedWalletOrigin = ConnectPairingServer.normalizeSecureOrigin(walletOrigin);
    if (normalizedWalletOrigin === undefined) {
      throw new TypeError('ConnectPairingServer: wallet origin must be an HTTPS origin, except on localhost.');
    }

    const pairing = await this.getPairing(pairingId);
    if (pairing === undefined) {
      return { status: 'not-found' };
    }

    const claim: ClaimRecord = {
      version              : CONNECT_PAIRING_VERSION,
      walletCapabilityHash : ConnectPairingServer.hashCapability(walletCapability),
      walletCommitment,
      walletOrigin         : normalizedWalletOrigin,
    };
    const won = await this.cache.insertIfAbsent(
      ConnectPairingServer.key(pairingId, 'claim'),
      claim,
      ConnectPairingServer.remainingTtl(pairing),
    );
    if (!won) {
      const existing = await this.getClaim(pairingId);
      if (existing === undefined ||
          existing.walletCommitment !== walletCommitment ||
          existing.walletOrigin !== normalizedWalletOrigin ||
          !ConnectPairingServer.capabilityMatches(walletCapability, existing.walletCapabilityHash)) {
        return { status: 'already-claimed' };
      }
    }

    return {
      client_key_commitment : pairing.clientCommitment,
      relay_origin          : pairing.relayOrigin,
      status                : 'ok',
      version               : CONNECT_PAIRING_VERSION,
      wallet_origin         : normalizedWalletOrigin,
    };
  }

  /** Polls the wallet commitment with the client capability. */
  public async pollClaim(pairingId: string, clientCapability: string): Promise<ConnectPairingResult<{
    relay_origin : string;
    version : typeof CONNECT_PAIRING_VERSION;
    wallet_key_commitment : string;
    wallet_origin : string;
  }>> {
    const authorization = await this.authorize(pairingId, 'client', clientCapability);
    if (authorization === undefined) {
      return { status: 'unauthorized' };
    }

    const claim = await this.getClaim(pairingId);
    return claim === undefined ? { status: 'pending' } : {
      relay_origin          : authorization.pairing.relayOrigin,
      status                : 'ok',
      version               : CONNECT_PAIRING_VERSION,
      wallet_key_commitment : claim.walletCommitment,
      wallet_origin         : claim.walletOrigin,
    };
  }

  /** Verifies and stores one side's committed key reveal. */
  public async putReveal(
    pairingId: string,
    role: ConnectPairingRole,
    capability: string,
    reveal: ConnectPairingReveal,
  ): Promise<ConnectPairingResult> {
    const authorization = await this.authorize(pairingId, role, capability);
    if (authorization === undefined) {
      return { status: 'unauthorized' };
    }
    if (authorization.claim === undefined) {
      return { status: 'invalid-state' };
    }

    const commitment = role === 'client'
      ? authorization.pairing.clientCommitment
      : authorization.claim.walletCommitment;
    if (!ConnectPairingServer.matchesCommitment(reveal, commitment)) {
      return { status: 'commitment-mismatch' };
    }

    const record: RevealRecord = {
      nonce     : reveal.nonce,
      publicKey : reveal.public_key,
      version   : CONNECT_PAIRING_VERSION,
    };
    return this.putOnce(pairingId, `reveal:${role}`, record, authorization.pairing);
  }

  /** Releases a committed reveal after the wallet claim fixes both commitments. */
  public async getReveal(
    pairingId: string,
    role: ConnectPairingRole,
    capability: string,
  ): Promise<ConnectPairingResult<{
    key_commitment : string;
    nonce : string;
    public_key : string;
    relay_origin : string;
    version : typeof CONNECT_PAIRING_VERSION;
    wallet_origin : string;
  }>> {
    const caller = role === 'client' ? 'wallet' : 'client';
    const authorization = await this.authorize(pairingId, caller, capability);
    if (authorization?.claim === undefined) {
      return { status: 'unauthorized' };
    }

    const reveal = await this.read<RevealRecord>(pairingId, `reveal:${role}`);
    if (reveal === undefined) {
      return { status: 'pending' };
    }
    return {
      key_commitment: role === 'client'
        ? authorization.pairing.clientCommitment
        : authorization.claim.walletCommitment,
      nonce         : reveal.nonce,
      public_key    : reveal.publicKey,
      relay_origin  : authorization.pairing.relayOrigin,
      status        : 'ok',
      version       : CONNECT_PAIRING_VERSION,
      wallet_origin : authorization.claim.walletOrigin,
    };
  }

  /** Writes one opaque frame to the role's directional slot. */
  public async putFrame(
    pairingId: string,
    direction: ConnectPairingRole,
    capability: string,
    frame: ConnectPairingFrame,
  ): Promise<ConnectPairingResult> {
    const authorization = await this.authorize(pairingId, direction, capability);
    if (authorization === undefined) {
      return { status: 'unauthorized' };
    }
    if (!ConnectPairingServer.isFrameForDirection(frame, direction)) {
      throw new TypeError('ConnectPairingServer: invalid frame stage or size.');
    }
    if (!await this.isStageReady(pairingId, frame.stage)) {
      return { status: 'invalid-state' };
    }

    const record: FrameRecord = { ...frame, direction, version: CONNECT_PAIRING_VERSION };
    return this.putOnce(pairingId, `frame:${direction}:${frame.stage}`, record, authorization.pairing);
  }

  /** Reads and atomically consumes one opaque frame from a directional slot. */
  public async getFrame(
    pairingId: string,
    direction: ConnectPairingRole,
    capability: string,
    stage: ConnectPairingStage,
  ): Promise<ConnectPairingResult<ConnectPairingFrame & { version: typeof CONNECT_PAIRING_VERSION }>> {
    const caller = direction === 'client' ? 'wallet' : 'client';
    const authorization = await this.authorize(pairingId, caller, capability);
    if (authorization === undefined) {
      return { status: 'unauthorized' };
    }
    if (!ConnectPairingServer.isStageForDirection(stage, direction)) {
      return { status: 'invalid-state' };
    }
    if (!await this.isStageReady(pairingId, stage)) {
      return { status: 'pending' };
    }

    const frame = await this.read<FrameRecord>(pairingId, `frame:${direction}:${stage}`);
    if (frame === undefined) {
      return { status: 'pending' };
    }
    await this.cache.insertIfAbsent(
      ConnectPairingServer.key(pairingId, `consumed:${direction}:${stage}`),
      { consumedAt: Date.now(), version: CONNECT_PAIRING_VERSION },
      ConnectPairingServer.remainingTtl(authorization.pairing),
    );

    const result: ConnectPairingFrame & { status: 'ok'; version: typeof CONNECT_PAIRING_VERSION } = {
      frame   : frame.frame,
      stage,
      status  : 'ok',
      version : CONNECT_PAIRING_VERSION,
    };
    return result;
  }

  public close(): void {
    this.cache.close();
  }

  private async putOnce(
    pairingId: string,
    suffix: string,
    value: RevealRecord | FrameRecord,
    pairing: PairingRecord,
  ): Promise<ConnectPairingResult> {
    const key = ConnectPairingServer.key(pairingId, suffix);
    if (await this.cache.insertIfAbsent(key, value, ConnectPairingServer.remainingTtl(pairing))) {
      return { status: 'ok' };
    }

    return JSON.stringify(await this.cache.get(key)) === JSON.stringify(value)
      ? { status: 'ok' }
      : { status: 'conflict' };
  }

  private async isStageReady(pairingId: string, stage: ConnectPairingStage): Promise<boolean> {
    if (stage === 'request') {
      const [clientReveal, walletReveal] = await Promise.all([
        this.read<RevealRecord>(pairingId, 'reveal:client'),
        this.read<RevealRecord>(pairingId, 'reveal:wallet'),
      ]);
      return clientReveal !== undefined && walletReveal !== undefined;
    }

    const previous: Record<Exclude<ConnectPairingStage, 'request'>, [ConnectPairingRole, ConnectPairingStage]> = {
      confirmation : ['wallet', 'decision'],
      decision     : ['client', 'request'],
      response     : ['client', 'confirmation'],
    };
    const [direction, previousStage] = previous[stage];
    return (await this.cache.get(ConnectPairingServer.key(pairingId, `consumed:${direction}:${previousStage}`))) !== undefined;
  }

  private async authorize(
    pairingId: string,
    role: ConnectPairingRole,
    capability: string,
  ): Promise<PairingAuthorization | undefined> {
    const pairing = await this.getPairing(pairingId);
    if (pairing === undefined) {
      return undefined;
    }

    const claim = await this.getClaim(pairingId);
    const expectedHash = role === 'client' ? pairing.clientCapabilityHash : claim?.walletCapabilityHash;
    if (expectedHash === undefined || !ConnectPairingServer.capabilityMatches(capability, expectedHash)) {
      return undefined;
    }
    return { claim, pairing };
  }

  private async getPairing(pairingId: string): Promise<PairingRecord | undefined> {
    const pairing = await this.read<PairingRecord>(pairingId);
    return pairing !== undefined && pairing.expiresAt > Date.now() ? pairing : undefined;
  }

  private async getClaim(pairingId: string): Promise<ClaimRecord | undefined> {
    return this.read<ClaimRecord>(pairingId, 'claim');
  }

  private async read<T extends { version: typeof CONNECT_PAIRING_VERSION }>(
    pairingId: string,
    suffix?: string,
  ): Promise<T | undefined> {
    const value = await this.cache.get(ConnectPairingServer.key(pairingId, suffix));
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== CONNECT_PAIRING_VERSION) {
      return undefined;
    }
    return value as T;
  }

  private static matchesCommitment(reveal: ConnectPairingReveal, commitment: string): boolean {
    if (!ConnectPairingServer.isBase64Url32(reveal.public_key) || !ConnectPairingServer.isBase64Url32(reveal.nonce) ||
        !ConnectPairingServer.isBase64Url32(commitment)) {
      return false;
    }
    const actual = createHash('sha256')
      .update(`${commitmentDomain}${reveal.public_key}\0${reveal.nonce}`, 'utf8')
      .digest();
    return timingSafeEqual(actual, Buffer.from(commitment, 'base64url'));
  }

  private static capabilityMatches(capability: string, expectedHash: string): boolean {
    if (!ConnectPairingServer.isBase64Url32(capability) || !ConnectPairingServer.isBase64Url32(expectedHash)) {
      return false;
    }
    return timingSafeEqual(
      Buffer.from(ConnectPairingServer.hashCapability(capability), 'base64url'),
      Buffer.from(expectedHash, 'base64url'),
    );
  }

  private static hashCapability(capability: string): string {
    return createHash('sha256').update(capabilityDomain).update(capability).digest('base64url');
  }

  private static createCapability(): string {
    return randomBytes(32).toString('base64url');
  }

  private static assertBase64Url32(value: string, label: string): void {
    if (!ConnectPairingServer.isBase64Url32(value)) {
      throw new TypeError(`ConnectPairingServer: ${label} must be 32-byte base64url data.`);
    }
  }

  private static isBase64Url32(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
      Buffer.from(value, 'base64url').toString('base64url') === value;
  }

  private static normalizeSecureOrigin(value: string): string | undefined {
    try {
      const url = new URL(value);
      return url.origin === value && ConnectPairingServer.isSecureOrigin(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private static isSecureOrigin(value: string): boolean {
    const url = new URL(value);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost);
  }

  private static isFrameForDirection(frame: ConnectPairingFrame, direction: ConnectPairingRole): boolean {
    return ConnectPairingServer.isStageForDirection(frame.stage, direction) &&
      typeof frame.frame === 'string' && frame.frame !== '' &&
      Buffer.byteLength(frame.frame, 'utf8') <= ConnectPairingServer.maxFrameBytes;
  }

  private static isStageForDirection(stage: ConnectPairingStage, direction: ConnectPairingRole): boolean {
    return direction === 'client'
      ? stage === 'request' || stage === 'confirmation'
      : stage === 'decision' || stage === 'response';
  }

  private static remainingTtl(pairing: PairingRecord): number {
    return Math.max(1, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
  }

  private static key(pairingId: string, suffix?: string): string {
    return suffix === undefined ? `pairing-v3:${pairingId}` : `pairing-v3:${pairingId}:${suffix}`;
  }
}
