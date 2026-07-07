import type { PlatformAgentTestHarness } from '../../src/test-harness.js';
import type { PortableDid } from '@enbox/dids';
import type { PrivateKeyJwk } from '@enbox/crypto';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';

export async function createPortableDidWithEncryptionKey(): Promise<PortableDid> {
  const { delegatePortableDid } = await createDelegatePortableDidWithEncryptionKey();
  return delegatePortableDid;
}

export async function createImportedDelegateDid(
  harness: PlatformAgentTestHarness,
): Promise<{ delegateDid: string; delegatePortableDid: PortableDid; delegateX25519PrivateKey: PrivateKeyJwk }> {
  const { delegatePortableDid, delegateX25519PrivateKey } = await createDelegatePortableDidWithEncryptionKey();

  await harness.agent.did.import({
    portableDid : delegatePortableDid,
    tenant      : harness.agent.agentDid.uri,
  });

  return {
    delegateDid: delegatePortableDid.uri,
    delegatePortableDid,
    delegateX25519PrivateKey,
  };
}

async function createDelegatePortableDidWithEncryptionKey(
): Promise<{ delegatePortableDid: PortableDid; delegateX25519PrivateKey: PrivateKeyJwk }> {
  const bearerDid = await DidJwk.create();
  const portableDid = await bearerDid.export();
  const privateKeys = portableDid.privateKeys ?? [];
  const delegateEdPrivateKey = privateKeys.find((key) => key.crv === 'Ed25519');
  if (delegateEdPrivateKey === undefined) {
    throw new Error('test delegate DID must include an Ed25519 private key.');
  }

  const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
    privateKey: delegateEdPrivateKey as PrivateKeyJwk,
  }) as PrivateKeyJwk;

  return {
    delegatePortableDid: {
      ...portableDid,
      privateKeys: [...privateKeys, delegateX25519PrivateKey],
    },
    delegateX25519PrivateKey,
  };
}
