import type { KeyIdentifier } from '@enbox/crypto';
import type {
  Dwn,
  EncryptionInput,
  RecordsQueryReplyEntry,
  RecordsWrite,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import type { DwnSigner } from './types/dwn.js';
import type { Web5PlatformAgent } from './types/agent.js';

import {
  Encoder,
  KeyDerivationScheme,
  Message,
  Records,
} from '@enbox/dwn-sdk-js';

import { deriveContextEncryptionInput, getKeyDecrypter } from './dwn-encryption.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';

/**
 * Reactively upgrades an externally-authored root record that has only
 * ProtocolPath encryption by appending a ProtocolContext recipient entry.
 *
 * After the upgrade, both the owner (ProtocolPath) and context key holders —
 * including the external author (ProtocolContext) — can decrypt the record.
 *
 * Steps:
 *   1. Decrypt the DEK using the owner's ProtocolPath-derived private key
 *   2. Derive the context public key from the owner's #enc key
 *   3. ECIES-encrypt the same DEK to the context public key
 *   4. Append the ProtocolContext recipient entry (using PR 0b append mode)
 *   5. Re-sign the record as owner
 *
 * @param agent - The platform agent
 * @param tenantDid - The DWN owner's DID
 * @param recordsWrite - The RecordsWrite message to upgrade
 * @param dwn - The DWN instance
 * @param getSigner - Function to get a DWN signer
 * @param contextKeyCache - Cache for context key info
 */
export async function upgradeExternalRootRecord(
  agent: Web5PlatformAgent,
  tenantDid: string,
  recordsWrite: RecordsWriteMessage,
  dwn: Dwn,
  getSigner: (author: string) => Promise<DwnSigner>,
  contextKeyCache: { set(key: string, value: { keyId: string; keyUri: KeyIdentifier; contextDerivationPath: string[] }): void },
): Promise<void> {
  const { encryption } = recordsWrite;
  if (!encryption) { return; }

  // Verify: has ProtocolPath but NOT ProtocolContext
  const hasProtocolPath = encryption.recipients.some(
    (r: { header: { derivationScheme: string } }) => r.header.derivationScheme === KeyDerivationScheme.ProtocolPath
  );
  const hasProtocolContext = encryption.recipients.some(
    (r: { header: { derivationScheme: string } }) => r.header.derivationScheme === KeyDerivationScheme.ProtocolContext
  );
  if (!hasProtocolPath || hasProtocolContext) { return; }

  // 1. Decrypt the DEK using the owner's ProtocolPath key
  const keyDecrypter = await getKeyDecrypter(agent, tenantDid);

  // Find the ProtocolPath recipient entry
  const pathRecipient = encryption.recipients.find(
    (r: { header: { derivationScheme: string } }) => r.header.derivationScheme === KeyDerivationScheme.ProtocolPath
  )!;

  const fullDerivationPath = Records.constructKeyDerivationPathUsingProtocolPathScheme(
    recordsWrite.descriptor,
  );

  const dataEncryptionKey = await keyDecrypter.decrypt(
    fullDerivationPath,
    {
      encryptedKey       : Encoder.base64UrlToBytes(pathRecipient.encrypted_key),
      ephemeralPublicKey : pathRecipient.header.epk,
    },
  );

  // 2. Derive the context public key — contextId = recordId for root records
  const contextId = recordsWrite.recordId;
  const encryptionIV = Encoder.base64UrlToBytes(encryption.iv);

  // 3 & 4. Append the ProtocolContext recipient entry using append mode.
  // Append mode preserves the author's identity and authorization so that
  // signAsOwner() can be called in step 5.
  const { encryptionInput: contextEncryptionInput, keyId, keyUri, contextDerivationPath } =
    await deriveContextEncryptionInput(agent, tenantDid, contextId, dataEncryptionKey, encryptionIV);

  // Set the authentication tag from the existing JWE encryption property
  const fullContextInput = { ...contextEncryptionInput, authenticationTag: Encoder.base64UrlToBytes(encryption.tag) };

  // Parse the message to get a RecordsWrite instance we can mutate
  const recordsWriteInstance = await dwnMessageConstructors[DwnInterface.RecordsWrite].parse(
    recordsWrite,
  ) as unknown as RecordsWrite;

  await recordsWriteInstance.encryptSymmetricEncryptionKey(
    fullContextInput as EncryptionInput,
    { append: true },
  );

  // 5. Re-sign as owner — the author's signature is preserved but its
  // encryptionCid is now stale; the owner's signature vouches for the
  // updated encryption property.
  const signer = await getSigner(tenantDid);
  await recordsWriteInstance.signAsOwner(signer);

  // Store the upgraded message directly via the message store, bypassing
  // the handler's conflict resolution which doesn't support same-timestamp
  // owner-augmented replacements. The data is unchanged — only the encryption
  // metadata and authorization are updated.
  //
  // We must also update the state index and event stream to keep sync and
  // real-time subscribers consistent — without this, the upgraded record
  // would never propagate to remote DWNs or notify subscribers.
  const { messageStore, stateIndex, eventLog } = dwn.storage;

  // Validate the upgrade only changed encryption and authorization fields.
  // The descriptor, recordId, contextId, and data must remain identical.
  // Note: parse() may produce a new descriptor object, so we compare by value.
  const upgradedMessage = recordsWriteInstance.message as RecordsQueryReplyEntry;
  if (JSON.stringify(upgradedMessage.descriptor) !== JSON.stringify(recordsWrite.descriptor)) {
    throw new Error('AgentDwnApi: upgradeExternalRootRecord() must not modify the descriptor.');
  }
  if (upgradedMessage.recordId !== recordsWrite.recordId) {
    throw new Error('AgentDwnApi: upgradeExternalRootRecord() must not modify the recordId.');
  }

  // Fetch the stored original (which carries encodedData for small payloads)
  const originalCid = await Message.getCid(recordsWrite);
  const storedOriginal = await messageStore.get(tenantDid, originalCid) as RecordsQueryReplyEntry | undefined;

  // Build indexes for the upgraded message (mark as latest base state)
  const isLatestBaseState = true;
  const upgradedIndexes = await recordsWriteInstance.constructIndexes(isLatestBaseState);

  // Carry over the encoded data from the stored original (the handler
  // base64url-encodes small payloads into encodedData during processMessage)
  if (storedOriginal?.encodedData) {
    upgradedMessage.encodedData = storedOriginal.encodedData;
  }

  // Use put-before-delete ordering: if a crash occurs after the put but
  // before the delete, we end up with a duplicate (recoverable via the
  // isLatestBaseState index) rather than data loss (unrecoverable).
  const upgradedCid = await Message.getCid(upgradedMessage);
  await messageStore.put(tenantDid, upgradedMessage, upgradedIndexes);
  await stateIndex.insert(tenantDid, upgradedCid, upgradedIndexes);

  // Now remove the original message and its state index entry.
  await messageStore.delete(tenantDid, originalCid);
  await stateIndex.delete(tenantDid, [originalCid]);

  // Notify real-time subscribers (mirrors handler behavior)
  if (eventLog !== undefined) {
    await eventLog.emit(tenantDid, { message: upgradedMessage }, upgradedIndexes);
  }

  // Cache context key info for subsequent writes in this context
  contextKeyCache.set(contextId, { keyId, keyUri, contextDerivationPath });
}
