import type { ProtocolDefinition, ProtocolsQueryReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { TtlCache } from '@enbox/common';
import { afterEach, describe, expect, it } from 'bun:test';

import {
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
      const getDwnEndpointUrls = sinon.stub();

      const result = await fetchRemoteProtocolDefinition(
        targetDid, protocolUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
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
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      const result = await fetchRemoteProtocolDefinition(
        targetDid, protocolUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
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
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await expect(fetchRemoteProtocolDefinition(
        targetDid, protocolUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toThrow('Failed to fetch protocol');
    });

    it('should throw when remote DWN returns empty entries', async () => {
      const cache = new TtlCache<string, ProtocolDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [],
      } as unknown as ProtocolsQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await expect(fetchRemoteProtocolDefinition(
        targetDid, protocolUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toThrow('Failed to fetch protocol');
    });
  });

});
