import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { IdentityVault } from '../types/identity-vault.js';
import type { SyncNextLinkIdentity } from './types.js';

import { syncNextLinkKey } from './ledger-key.js';

const QUARANTINE_PAYLOAD_VERSION = 1 as const;

/** Maximum plaintext retained in one encrypted quarantine row. */
export const SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES = 1024 * 1024;

/** Received pull input that must survive after handled-through progress advances. */
export type SyncNextQuarantinePayload = {
  entry: MessagesQueryReplyEntry;
};

type BoundQuarantinePayload = SyncNextQuarantinePayload & {
  binding: {
    linkKey: string;
    messageCid: string;
    source: ProgressToken;
  };
  version: typeof QUARANTINE_PAYLOAD_VERSION;
};

type QuarantinePayloadBinding = {
  identity: SyncNextLinkIdentity;
  messageCid: string;
  source: ProgressToken;
};

/** Encrypt and bind received input to its exact durable receipt. */
export async function sealSyncNextQuarantinePayload(
  vault: Pick<IdentityVault, 'encryptData'>,
  binding: QuarantinePayloadBinding,
  payload: SyncNextQuarantinePayload,
): Promise<string> {
  SyncNextQuarantineCodec.assertPayloadMatchesBinding(binding, payload);
  const bound: BoundQuarantinePayload = {
    binding: {
      linkKey    : syncNextLinkKey(binding.identity),
      messageCid : binding.messageCid,
      source     : structuredClone(binding.source),
    },
    entry   : structuredClone(payload.entry),
    version : QUARANTINE_PAYLOAD_VERSION,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(bound));
  if (plaintext.byteLength > SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES) {
    throw new Error(
      `SyncNextQuarantineCodec: payload exceeds ${SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES} bytes.`,
    );
  }
  return vault.encryptData({ plaintext });
}

/** Decrypt one row and reject ciphertext moved to another receipt. */
export async function openSyncNextQuarantinePayload(
  vault: Pick<IdentityVault, 'decryptData'>,
  binding: QuarantinePayloadBinding,
  encryptedPayload: string,
): Promise<SyncNextQuarantinePayload> {
  const plaintext = await vault.decryptData({ jwe: encryptedPayload });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error: unknown) {
    throw new Error('SyncNextQuarantineCodec: decrypted payload is not valid JSON.', { cause: error });
  }
  if (!SyncNextQuarantineCodec.isBoundPayload(parsed)) {
    throw new Error('SyncNextQuarantineCodec: decrypted payload has an invalid schema.');
  }

  const expectedLinkKey = syncNextLinkKey(binding.identity);
  if (
    parsed.binding.linkKey !== expectedLinkKey ||
    parsed.binding.messageCid !== binding.messageCid ||
    !SyncNextQuarantineCodec.tokensEqual(parsed.binding.source, binding.source)
  ) {
    throw new Error('SyncNextQuarantineCodec: encrypted payload does not belong to this receipt.');
  }
  const payload = { entry: parsed.entry };
  SyncNextQuarantineCodec.assertPayloadMatchesBinding(binding, payload);
  return payload;
}

class SyncNextQuarantineCodec {
  public static assertPayloadMatchesBinding(
    binding: QuarantinePayloadBinding,
    payload: SyncNextQuarantinePayload,
  ): void {
    if (payload.entry.messageCid !== binding.messageCid) {
      throw new Error('SyncNextQuarantineCodec: root entry CID does not match its receipt.');
    }
    if (
      binding.source.messageCid !== undefined &&
      binding.source.messageCid !== binding.messageCid
    ) {
      throw new Error('SyncNextQuarantineCodec: source token CID does not match its receipt.');
    }
  }

  public static isBoundPayload(value: unknown): value is BoundQuarantinePayload {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<BoundQuarantinePayload>;
    return candidate.version === QUARANTINE_PAYLOAD_VERSION &&
      typeof candidate.binding === 'object' && candidate.binding !== null &&
      typeof candidate.binding.linkKey === 'string' &&
      typeof candidate.binding.messageCid === 'string' &&
      SyncNextQuarantineCodec.isProgressToken(candidate.binding.source) &&
      SyncNextQuarantineCodec.isFeedEntry(candidate.entry);
  }

  private static isFeedEntry(value: unknown): value is MessagesQueryReplyEntry {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<MessagesQueryReplyEntry>;
    return typeof candidate.messageCid === 'string' && typeof candidate.seq === 'string';
  }

  private static isProgressToken(value: unknown): value is ProgressToken {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ProgressToken>;
    return typeof candidate.streamId === 'string' &&
      typeof candidate.epoch === 'string' &&
      typeof candidate.position === 'string' &&
      (candidate.messageCid === undefined || typeof candidate.messageCid === 'string');
  }

  public static tokensEqual(a: ProgressToken, b: ProgressToken): boolean {
    return a.streamId === b.streamId &&
      a.epoch === b.epoch &&
      a.position === b.position &&
      a.messageCid === b.messageCid;
  }
}
