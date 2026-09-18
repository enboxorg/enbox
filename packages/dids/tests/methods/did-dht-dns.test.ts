import type { Packet, StringAnswer, TxtAnswer } from '@dnsquery/dns-packet';

import {
  chunkDataIfNeeded,
  parseTxtDataToObject,
  parseTxtDataToString,
  toDnsPacket,
  TXT_SEGMENT_MAX_BYTES,
} from '../../src/methods/did-dht-dns.js';
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

describe('parseTxtDataToObject()', () => {
  it('splits pairs on the first = only, preserving values that contain =', () => {
    // Previously split on every '=', truncating values such as URL query strings or padded
    // base64 after the second '='.
    expect(parseTxtDataToObject('se=https://example.com/dwn?foo=bar')).toEqual({
      se: 'https://example.com/dwn?foo=bar'
    });
    expect(parseTxtDataToObject('k=YWJjZA==')).toEqual({ k: 'YWJjZA==' });
    expect(parseTxtDataToObject('a=1;b=x=y;v=0')).toEqual({ a: '1', b: 'x=y', v: '0' });
  });

  it('parses key/value pairs separated by property separators', () => {
    expect(parseTxtDataToObject('id=0;t=0;k=amty')).toEqual({ id: '0', t: '0', k: 'amty' });
  });

  it('keeps pairs without a separator as keys with undefined values', () => {
    const parsed = parseTxtDataToObject('v=0;orphan');
    expect(parsed.v).toBe('0');
    expect('orphan' in parsed).toBe(true);
    expect(parsed.orphan).toBeUndefined();
  });
});

describe('toDnsPacket() — authoritative gateway NS records', () => {
  const didUri = 'did:dht:5cahcfh3zh8bqd5cn3y6inoea1b3d6kh85rjksne9e5dcyrc1ery';

  const toPacket = (authoritativeGatewayUris?: string[]): Promise<Packet> => toDnsPacket({
    didDocument : { id: didUri },
    didMetadata : { published: false },
    authoritativeGatewayUris,
  });

  const nsTargets = (packet: Packet): string[] => (packet.answers ?? [])
    .filter((answer): answer is StringAnswer => answer.type === 'NS')
    .map((answer) => answer.data);

  it('emits the gateway host in FQDN form, dropping scheme, port, path, query, and fragment', async () => {
    const packet = await toPacket(['https://gateway.example:8443/some/path?q=1#frag']);
    expect(nsTargets(packet)).toEqual(['gateway.example.']);
  });

  it('accepts bare hosts, as used by the DID DHT specification test vectors', async () => {
    const packet = await toPacket(['gateway1.example-did-dht-gateway.com']);
    expect(nsTargets(packet)).toEqual(['gateway1.example-did-dht-gateway.com.']);
  });

  it('omits NS records for IP-literal gateways, which carry no NS metadata', async () => {
    const packet = await toPacket(['http://127.0.0.1:7527', 'http://[::1]:8080']);
    expect(nsTargets(packet)).toEqual([]);
  });

  it('emits no NS records when no authoritative gateways are given', async () => {
    expect(nsTargets(await toPacket(undefined))).toEqual([]);
    expect(nsTargets(await toPacket([]))).toEqual([]);
  });

  it('passes malformed or host-less gateway URIs through unchanged, as older versions did', async () => {
    // Legacy behavior is preserved rather than rejecting such inputs; whether to validate
    // strictly instead is an open question (https://github.com/enboxorg/enbox/issues/1718).
    const packet = await toPacket(['https://', 'file:///etc/hosts']);
    expect(nsTargets(packet)).toEqual(['https://.', 'file:///etc/hosts.']);
  });
});
