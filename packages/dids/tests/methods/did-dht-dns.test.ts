import type { Packet, TxtAnswer } from '@dnsquery/dns-packet';

import { chunkDataIfNeeded, parseTxtDataToString, TXT_SEGMENT_MAX_BYTES } from '../../src/methods/did-dht-dns.js';
import { describe, expect, it } from 'bun:test';
import { decode as dnsPacketDecode, encode as dnsPacketEncode } from '@dnsquery/dns-packet';

const textEncoder = new TextEncoder();

const utf8ByteLength = (value: string): number => textEncoder.encode(value).length;

describe('chunkDataIfNeeded()', () => {
  it('returns the original string when it fits in a single 255-byte segment', () => {
    const data = 'a'.repeat(TXT_SEGMENT_MAX_BYTES);
    expect(chunkDataIfNeeded(data)).toBe(data);
  });

  it('chunks ASCII strings into 255-byte segments', () => {
    const data = 'a'.repeat(600);
    const chunks = chunkDataIfNeeded(data) as string[];

    expect(chunks.map(utf8ByteLength)).toEqual([TXT_SEGMENT_MAX_BYTES, TXT_SEGMENT_MAX_BYTES, 90]);
    expect(chunks.join('')).toBe(data);
  });

  it('chunks strings whose UTF-8 length exceeds 255 bytes even when their UTF-16 length does not', () => {
    // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: 128 of them are 128 code units (under the
    // old 255-character limit) yet 384 bytes, so the buggy implementation returned the string
    // un-chunked and the DNS encoder corrupted its length prefix.
    const data = '€'.repeat(128);
    const chunks = chunkDataIfNeeded(data) as string[];

    expect(chunks.map(utf8ByteLength)).toEqual([TXT_SEGMENT_MAX_BYTES, 129]);
    expect(chunks.join('')).toBe(data);
  });

  it('does not split multibyte characters across segment boundaries', () => {
    // 64 '😀' = 128 UTF-16 code units (surrogate pairs) and 256 UTF-8 bytes. Splitting by
    // code-unit count would separate a surrogate pair mid-boundary; chunking by UTF-8 bytes
    // at code-point boundaries yields a 252-byte segment (63 characters) plus a 4-byte one.
    const data = '😀'.repeat(64);
    const chunks = chunkDataIfNeeded(data) as string[];

    expect(chunks.map(utf8ByteLength)).toEqual([252, 4]);
    expect(chunks.join('')).toBe(data);
  });

  it('round-trips mixed-width data through DNS packet encode/decode without replacement characters', () => {
    // Mixed 1/3/4-byte characters straddling the 255-byte boundary.
    const data = 'x'.repeat(200) + '€'.repeat(40) + '😀'.repeat(10);
    const txtRecord: TxtAnswer = {
      type : 'TXT',
      name : '_did.example.',
      ttl  : 7200,
      data : chunkDataIfNeeded(data),
    };
    const dnsPacket: Packet = {
      id      : 0,
      type    : 'response',
      flags   : 1024,
      answers : [txtRecord],
    };

    const decodedPacket = dnsPacketDecode(dnsPacketEncode(dnsPacket));
    const decodedData = parseTxtDataToString((decodedPacket.answers![0] as TxtAnswer).data);

    expect(decodedData).toBe(data);
    expect(decodedData).not.toContain('\uFFFD');
  });
});
