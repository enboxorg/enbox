import type { ProtocolDefinition, ProtocolsQueryReply, RecordsQueryReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import { TtlCache } from '@enbox/common';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  extractDerivedPublicKey,
  fetchRemoteProtocolDefinition,
  getProtocolDefinition,
} from '../src/dwn-protocol-cache.js';

describe('dwn-protocol-cache', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ---------------------------------------------------------------------------
  // getProtocolDefinition
  // ---------------------------------------------------------------------------
  describe('getProtocolDefinition', () => {
    const tenantDid = 'did:example:alice';
    const protocolUri = 'https://example.com/protocol';
    const mockDefinition: ProtocolDefinition = {
      protocol  : protocolUri,
      published : true,
      types     : {},
      structure : {},
    };

    /**
     * Creates a real DWN signer from TestDataGenerator so that
     * dwnMessageConstructors[...].create() succeeds.
     */
    async function createRealSigner(): Promise<sinon.SinonStub> {
      const { TestDataGenerator } = await import('@enbox/dwn-sdk-js');
      const persona = await TestDataGenerator.generatePersona();
      return sinon.stub().resolves(persona.signer);
    }

    it('should return cached definition if available', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      cache.set(`${tenantDid}~${protocolUri}`, mockDefinition);
      const dwn = { processMessage: sinon.stub() };
      const getSigner = sinon.stub();

      const result = await getProtocolDefinition(tenantDid, protocolUri, dwn, getSigner, cache);
      expect(result).toBe(mockDefinition);
      expect(dwn.processMessage.callCount).toBe(0);
    });

    it('should query the DWN and cache the result on cache miss', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status  : { code: 200 },
          entries : [{ descriptor: { definition: mockDefinition } }],
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getProtocolDefinition(tenantDid, protocolUri, dwn, getSigner, cache);
      expect(result).toEqual(mockDefinition);
      expect(cache.get(`${tenantDid}~${protocolUri}`)).toEqual(mockDefinition);
    });

    it('should return undefined if DWN query returns non-200 status', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status: { code: 404 },
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getProtocolDefinition(tenantDid, protocolUri, dwn, getSigner, cache);
      expect(result).toBeUndefined();
    });

    it('should return undefined if DWN query returns empty entries', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status  : { code: 200 },
          entries : [],
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getProtocolDefinition(tenantDid, protocolUri, dwn, getSigner, cache);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // fetchRemoteProtocolDefinition
  // ---------------------------------------------------------------------------
  describe('fetchRemoteProtocolDefinition', () => {
    const targetDid = 'did:example:bob';
    const protocolUri = 'https://example.com/protocol';
    const mockDefinition: ProtocolDefinition = {
      protocol  : protocolUri,
      published : true,
      types     : {},
      structure : {},
    };

    it('should return cached definition if available', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      cache.set(`remote~${targetDid}~${protocolUri}`, mockDefinition);
      const sendDwnRpcRequest = sinon.stub();
      const didDereferencer = { dereference: sinon.stub() };

      const result = await fetchRemoteProtocolDefinition(
        targetDid, protocolUri, didDereferencer as any, sendDwnRpcRequest, cache,
      );
      expect(result).toBe(mockDefinition);
      expect(sendDwnRpcRequest.callCount).toBe(0);
    });

    it('should query remote DWN and cache the result on cache miss', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: mockDefinition } }],
      } as ProtocolsQueryReply);
      const didDereferencer = {
        dereference: sinon.stub().resolves({
          dereferencingMetadata : {},
          contentStream         : {
            id              : `${targetDid}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          },
        }),
      };

      const result = await fetchRemoteProtocolDefinition(
        targetDid, protocolUri, didDereferencer as any, sendDwnRpcRequest, cache,
      );
      expect(result).toEqual(mockDefinition);
      expect(cache.get(`remote~${targetDid}~${protocolUri}`)).toEqual(mockDefinition);
    });

    it('should throw when remote DWN returns non-200 status', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 404 },
        entries : [],
      } as unknown as ProtocolsQueryReply);
      const didDereferencer = {
        dereference: sinon.stub().resolves({
          dereferencingMetadata : {},
          contentStream         : {
            id              : `${targetDid}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          },
        }),
      };

      await expect(fetchRemoteProtocolDefinition(
        targetDid, protocolUri, didDereferencer as any, sendDwnRpcRequest, cache,
      )).rejects.toThrow('Failed to fetch protocol');
    });

    it('should throw when remote DWN returns empty entries', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [],
      } as unknown as ProtocolsQueryReply);
      const didDereferencer = {
        dereference: sinon.stub().resolves({
          dereferencingMetadata : {},
          contentStream         : {
            id              : `${targetDid}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          },
        }),
      };

      await expect(fetchRemoteProtocolDefinition(
        targetDid, protocolUri, didDereferencer as any, sendDwnRpcRequest, cache,
      )).rejects.toThrow('Failed to fetch protocol');
    });
  });

  // ---------------------------------------------------------------------------
  // extractDerivedPublicKey
  // ---------------------------------------------------------------------------
  describe('extractDerivedPublicKey', () => {
    const targetDid = 'did:example:bob';
    const protocolUri = 'https://example.com/protocol';
    const rootContextId = 'ctx-123';
    const requesterDid = 'did:example:alice';
    const mockDerivedPublicKey = { kty: 'OKP', crv: 'X25519', x: 'mock-x' };

    /**
     * Creates a real DWN signer from TestDataGenerator so that
     * dwnMessageConstructors[DwnInterface.RecordsQuery].create() succeeds.
     */
    async function createRealSigner(): Promise<sinon.SinonStub> {
      const { TestDataGenerator } = await import('@enbox/dwn-sdk-js');
      const persona = await TestDataGenerator.generatePersona();
      return sinon.stub().resolves(persona.signer);
    }

    const dwnDereferencer = (did: string): any => ({
      dereference: sinon.stub().resolves({
        dereferencingMetadata : {},
        contentStream         : {
          id              : `${did}#dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://dwn.example.com'],
        },
      }),
    });

    it('should return undefined when query returns non-200', async () => {
      const getSigner = await createRealSigner();
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 404 },
        entries : [],
      } as unknown as RecordsQueryReply);

      const result = await extractDerivedPublicKey(
        targetDid, protocolUri, rootContextId, requesterDid,
        dwnDereferencer(targetDid) as any, getSigner, sendDwnRpcRequest,
      );
      expect(result).toBeUndefined();
    });

    it('should return undefined when query returns empty entries', async () => {
      const getSigner = await createRealSigner();
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [],
      } as unknown as RecordsQueryReply);

      const result = await extractDerivedPublicKey(
        targetDid, protocolUri, rootContextId, requesterDid,
        dwnDereferencer(targetDid) as any, getSigner, sendDwnRpcRequest,
      );
      expect(result).toBeUndefined();
    });

    it('should return the derived public key from a matching entry', async () => {
      const getSigner = await createRealSigner();
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{
          encryption: {
            recipients: [{
              header: {
                kid              : 'root-key-1',
                derivationScheme : KeyDerivationScheme.ProtocolContext,
                derivedPublicKey : mockDerivedPublicKey,
              },
            }],
          },
        }],
      } as unknown as RecordsQueryReply);

      const result = await extractDerivedPublicKey(
        targetDid, protocolUri, rootContextId, requesterDid,
        dwnDereferencer(targetDid) as any, getSigner, sendDwnRpcRequest,
      );
      expect(result).toBeDefined();
      expect(result!.rootKeyId).toBe('root-key-1');
      expect(result!.derivedPublicKey).toEqual(mockDerivedPublicKey);
    });

    it('should return undefined when entries have no ProtocolContext recipient', async () => {
      const getSigner = await createRealSigner();
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{
          encryption: {
            recipients: [{
              header: {
                kid              : 'root-key-1',
                derivationScheme : KeyDerivationScheme.ProtocolPath,
              },
            }],
          },
        }],
      } as unknown as RecordsQueryReply);

      const result = await extractDerivedPublicKey(
        targetDid, protocolUri, rootContextId, requesterDid,
        dwnDereferencer(targetDid) as any, getSigner, sendDwnRpcRequest,
      );
      expect(result).toBeUndefined();
    });

    it('should return undefined when entries have no encryption field', async () => {
      const getSigner = await createRealSigner();
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: {} }],
      } as unknown as RecordsQueryReply);

      const result = await extractDerivedPublicKey(
        targetDid, protocolUri, rootContextId, requesterDid,
        dwnDereferencer(targetDid) as any, getSigner, sendDwnRpcRequest,
      );
      expect(result).toBeUndefined();
    });
  });
});
