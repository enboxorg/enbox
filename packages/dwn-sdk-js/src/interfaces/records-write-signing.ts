import type { GeneralJws } from '../types/jws-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { EncryptionInput, JweEncryption } from '../utils/encryption.js';
import type { RecordsWriteAttestationPayload, RecordsWriteMessage, RecordsWriteSignaturePayload } from '../types/records-types.js';

import { Cid } from '../utils/cid.js';
import { Encoder } from '../utils/encoder.js';
import { Encryption } from '../utils/encryption.js';
import { GeneralJwsBuilder } from '../jose/jws/general/builder.js';
import { Jws } from '../utils/jws.js';
import { removeUndefinedProperties } from '@enbox/common';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

/**
 * Creates the JWE `encryption` property if encryption input is given. Else `undefined` is returned.
 * Uses ECDH-ES+A256KW key agreement with X25519 and AEAD content encryption (A256GCM or XC20P).
 * @param encryptionInput The encryption input containing CEK, IV, authentication tag, and recipient key encryption inputs.
 */
export async function createEncryptionProperty(
  encryptionInput: EncryptionInput | undefined,
): Promise<JweEncryption | undefined> {
  if (encryptionInput === undefined) {
    return undefined;
  }

  // Build the JWE structure. The authentication tag comes from the AEAD encryption of record data.
  const jwe = await Encryption.buildJwe(encryptionInput, encryptionInput.authenticationTag);

  return jwe;
}

/**
 * Creates the `attestation` property of a RecordsWrite message if given signature inputs; returns `undefined` otherwise.
 */
export async function createAttestation(descriptorCid: string, signers?: MessageSigner[]): Promise<GeneralJws | undefined> {
  if (signers === undefined || signers.length === 0) {
    return undefined;
  }

  const attestationPayload: RecordsWriteAttestationPayload = { descriptorCid };
  const attestationPayloadBytes = Encoder.objectToBytes(attestationPayload);

  const builder = await GeneralJwsBuilder.create(attestationPayloadBytes, signers);
  return builder.getJws();
}

/**
 * Creates the `signature` property in the `authorization` of a `RecordsWrite` message.
 */
export async function createSignerSignature(input: {
  recordId: string,
  contextId: string,
  descriptorCid: string,
  attestation: GeneralJws | undefined,
  encryption: JweEncryption | undefined,
  signer: MessageSigner,
  delegatedGrantId?: string,
  permissionGrantId?: string,
  protocolRole?: string
}): Promise<GeneralJws> {
  const { recordId, contextId, descriptorCid, attestation, encryption, signer, delegatedGrantId, permissionGrantId, protocolRole } = input;

  const attestationCid = attestation ? await Cid.computeCid(attestation) : undefined;
  const encryptionCid = encryption ? await Cid.computeCid(encryption) : undefined;

  const signaturePayload: RecordsWriteSignaturePayload = {
    recordId,
    descriptorCid,
    contextId,
    attestationCid,
    encryptionCid,
    delegatedGrantId,
    permissionGrantId,
    protocolRole
  };
  removeUndefinedProperties(signaturePayload);

  const signaturePayloadBytes = Encoder.objectToBytes(signaturePayload);

  const builder = await GeneralJwsBuilder.create(signaturePayloadBytes, [signer]);
  const signature = builder.getJws();

  return signature;
}

/**
 * Validates the structural integrity of the `attestation` property.
 * NOTE: Cryptographic verification of attestation signatures is performed in `authenticate()`.
 */
export async function validateAttestationIntegrity(message: RecordsWriteMessage): Promise<void> {
  if (message.attestation === undefined) {
    return;
  }

  // TODO: support multiple attesters (https://github.com/enboxorg/enbox/issues/223)
  if (message.attestation.signatures.length !== 1) {
    throw new DwnError(
      DwnErrorCode.RecordsWriteAttestationIntegrityMoreThanOneSignature,
      `Currently implementation only supports 1 attester, but got ${message.attestation.signatures.length}`
    );
  }

  const payloadJson = Jws.decodePlainObjectPayload(message.attestation);
  const { descriptorCid } = payloadJson;

  // `descriptorCid` validation - ensure that the provided descriptorCid matches the CID of the actual message
  const expectedDescriptorCid = await Cid.computeCid(message.descriptor);
  if (descriptorCid !== expectedDescriptorCid) {
    throw new DwnError(
      DwnErrorCode.RecordsWriteAttestationIntegrityDescriptorCidMismatch,
      `descriptorCid ${descriptorCid} does not match expected descriptorCid ${expectedDescriptorCid}`
    );
  }

  // check to ensure that no other unexpected properties exist in payload.
  const propertyCount = Object.keys(payloadJson).length;
  if (propertyCount > 1) {
    throw new DwnError(
      DwnErrorCode.RecordsWriteAttestationIntegrityInvalidPayloadProperty,
      `Only 'descriptorCid' is allowed in attestation payload, but got ${propertyCount} properties.`
    );
  }
}
