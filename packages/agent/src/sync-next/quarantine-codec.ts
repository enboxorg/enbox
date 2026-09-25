import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { IdentityVault } from '../types/identity-vault.js';
import type { SyncNextLinkIdentity } from './types.js';

import { syncNextReceiptKey } from './ledger-key.js';

const QUARANTINE_PAYLOAD_VERSION = 1 as const;

/** Maximum plaintext retained in one encrypted quarantine row. */
export const SYNC_NEXT_MAX_QUARANTINE_PLAINTEXT_BYTES = 1024 * 1024;

type BoundQuarantinePayload = {
  entry: MessagesQueryReplyEntry;
  receiptKey: string;
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
  entry: MessagesQueryReplyEntry,
): Promise<string> {
  assertEntryMatchesBinding(binding, entry);
  const bound: BoundQuarantinePayload = {
    entry      : structuredClone(entry),
    receiptKey : syncNextReceiptKey(binding.identity, binding),
    version    : QUARANTINE_PAYLOAD_VERSION,
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
): Promise<MessagesQueryReplyEntry> {
  const plaintext = await vault.decryptData({ jwe: encryptedPayload });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error: unknown) {
    throw new Error('SyncNextQuarantineCodec: decrypted payload is not valid JSON.', { cause: error });
  }
  if (!isBoundPayload(parsed)) {
    throw new Error('SyncNextQuarantineCodec: decrypted payload has an invalid schema.');
  }

  if (parsed.receiptKey !== syncNextReceiptKey(binding.identity, binding)) {
    throw new Error('SyncNextQuarantineCodec: encrypted payload does not belong to this receipt.');
  }
  assertEntryMatchesBinding(binding, parsed.entry);
  return parsed.entry;
}

function assertEntryMatchesBinding(
  binding: QuarantinePayloadBinding,
  entry: MessagesQueryReplyEntry,
): void {
  if (entry.messageCid !== binding.messageCid) {
    throw new Error('SyncNextQuarantineCodec: root entry CID does not match its receipt.');
  }
  if (binding.source.messageCid !== undefined && binding.source.messageCid !== binding.messageCid) {
    throw new Error('SyncNextQuarantineCodec: source token CID does not match its receipt.');
  }
}

function isBoundPayload(value: unknown): value is BoundQuarantinePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<BoundQuarantinePayload>;
  const entry = candidate.entry as Partial<MessagesQueryReplyEntry> | undefined;
  return candidate.version === QUARANTINE_PAYLOAD_VERSION &&
    typeof candidate.receiptKey === 'string' &&
    typeof entry === 'object' && entry !== null &&
    typeof entry.messageCid === 'string' && typeof entry.seq === 'string';
}
