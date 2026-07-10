import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { describe, expect, it } from 'bun:test';

import { signJwt, verifyJwt } from '../src/jwt.js';

describe('connect jwt', () => {
  it('should sign and verify a payload, returning the signer DID', async () => {
    const did = await DidJwk.create();
    const payload = { hello: 'world', count: 42 };

    const jwt = await signJwt({ did, data: payload });
    const result = await verifyJwt({ jwt });

    expect(result.payload).toEqual(payload);
    expect(result.signerDid).toBe(did.uri);
  });

  it('should reject a tampered payload', async () => {
    const did = await DidJwk.create();
    const jwt = await signJwt({ did, data: { hello: 'world' } });

    const [header, , signature] = jwt.split('.');
    const forgedPayload = Convert.object({ hello: 'tampered' }).toBase64Url();
    const tamperedJwt = `${header}.${forgedPayload}.${signature}`;

    await expect(verifyJwt({ jwt: tamperedJwt })).rejects.toThrow('invalid signature');
  });

  it('should reject a JWT that does not have 3 parts', async () => {
    await expect(verifyJwt({ jwt: 'only.two' })).rejects.toThrow('must have 3 parts');
  });

  it('should reject a JWT with a malformed header', async () => {
    await expect(verifyJwt({ jwt: '!!!.AAAA.AAAA' })).rejects.toThrow('malformed JWT header');
  });

  it('should reject a JWT whose alg is not EdDSA', async () => {
    const header = Convert.object({ alg: 'ES256K', kid: 'did:jwk:abc#0', typ: 'JWT' }).toBase64Url();
    const payload = Convert.object({ hello: 'world' }).toBase64Url();

    await expect(verifyJwt({ jwt: `${header}.${payload}.AAAA` })).rejects.toThrow('"alg" must be "EdDSA"');
  });

  it('should reject a JWT missing the kid header', async () => {
    const header = Convert.object({ alg: 'EdDSA', typ: 'JWT' }).toBase64Url();
    const payload = Convert.object({ hello: 'world' }).toBase64Url();

    await expect(verifyJwt({ jwt: `${header}.${payload}.AAAA` })).rejects.toThrow('missing required "kid"');
  });

  it('should reject a kid that is not a did:jwk', async () => {
    const header = Convert.object({ alg: 'EdDSA', kid: 'did:dht:abc123#0', typ: 'JWT' }).toBase64Url();
    const payload = Convert.object({ hello: 'world' }).toBase64Url();

    await expect(verifyJwt({ jwt: `${header}.${payload}.AAAA` })).rejects.toThrow('must reference a did:jwk');
  });

  it('should reject a payload that is not a JSON object', async () => {
    const did = await DidJwk.create();
    const jwt = await signJwt({ did, data: [1, 2, 3] as unknown as object });

    await expect(verifyJwt({ jwt })).rejects.toThrow('payload must be a JSON object');
  });
});
