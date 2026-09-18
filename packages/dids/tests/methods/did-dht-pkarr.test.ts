import type { Signer } from '@enbox/crypto';
import type { Packet, TxtAnswer } from '@dnsquery/dns-packet';

import { DidErrorCode } from '../../src/did-error.js';
import { encode as dnsPacketEncode } from '@dnsquery/dns-packet';
import { Ed25519 } from '@enbox/crypto';
import { TXT_SEGMENT_MAX_BYTES } from '../../src/methods/did-dht-dns.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { BEP44_VALUE_MAX_BYTES, createBep44PutMessage, parseBep44GetMessage } from '../../src/methods/did-dht-pkarr.js';

/**
 * Builds a DNS packet whose encoded form is exactly `targetSize` bytes, by padding the TXT
 * record's data with filler segments. Each added segment of N bytes grows the encoded packet
 * by N + 1 bytes (one length-prefix byte per DNS character-string), so the filler is
 * distributed across segments of at most 255 bytes (the DNS character-string limit).
 */
function createDnsPacketOfSize(targetSize: number): Packet {
  const answer: TxtAnswer = {
    type : 'TXT',
    name : '_did.example.',
    ttl  : 7200,
    data : ['id=0'],
  };
  const dnsPacket: Packet = {
    id      : 0,
    type    : 'response',
    flags   : 1024,
    answers : [answer],
  };

  let remaining = targetSize - dnsPacketEncode(dnsPacket).length;
  const data = answer.data as string[];
  while (remaining > 0) {
    const segmentLength = Math.min(TXT_SEGMENT_MAX_BYTES, remaining - 1);
    data.push('x'.repeat(segmentLength));
    remaining -= segmentLength + 1;
  }

  return dnsPacket;
}

describe('createBep44PutMessage()', () => {
  describe('value size limit', () => {
    let publicKeyBytes: Uint8Array;
    let signer: Signer;

    beforeEach(async () => {
      const privateKey = await Ed25519.generateKey();
      const publicKey = await Ed25519.getPublicKey({ key: privateKey });
      publicKeyBytes = await Ed25519.publicKeyToBytes({ publicKey });
      signer = {
        async sign({ data }): Promise<Uint8Array> {
          return Ed25519.sign({ key: privateKey, data });
        },
        async verify({ data, signature }): Promise<boolean> {
          return Ed25519.verify({ key: publicKey, data, signature });
        }
      };
    });

    it('accepts a DNS packet whose encoded value is exactly 1000 bytes', async () => {
      const dnsPacket = createDnsPacketOfSize(BEP44_VALUE_MAX_BYTES);
      // Pin the setup: the BEP44 value is exactly at the limit, so the signing payload
      // (`3:seqi<seq>e1:v<len>:` prefix + value) is necessarily over 1000 bytes.
      expect(dnsPacketEncode(dnsPacket)).toHaveLength(BEP44_VALUE_MAX_BYTES);

      const bep44Message = await createBep44PutMessage({ dnsPacket, publicKeyBytes, signer });

      expect(bep44Message.v).toHaveLength(BEP44_VALUE_MAX_BYTES);
      await expect(parseBep44GetMessage({ bep44Message })).resolves.toBeDefined();
    });

    it('rejects a DNS packet whose encoded value exceeds 1000 bytes', async () => {
      const dnsPacket = createDnsPacketOfSize(BEP44_VALUE_MAX_BYTES + 1);
      expect(dnsPacketEncode(dnsPacket)).toHaveLength(BEP44_VALUE_MAX_BYTES + 1);

      await expect(createBep44PutMessage({ dnsPacket, publicKeyBytes, signer }))
        .rejects.toThrow(DidErrorCode.InvalidDidDocumentLength);
    });
  });
});
