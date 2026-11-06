import type { ModuleDefinition, ModulesQueryReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { TtlCache } from '@enbox/common';
import { afterEach, describe, expect, it } from 'bun:test';
import { Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import {
  fetchRemoteModuleDefinition,
  getModuleDefinition,
  RemoteModuleDefinitionError,
} from '../src/dwn-module-cache.js';

describe('dwn-module-cache', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ---------------------------------------------------------------------------
  // getModuleDefinition
  // ---------------------------------------------------------------------------
  describe('getModuleDefinition', () => {
    const tenantDid = 'did:example:alice';
    const moduleUri = 'https://example.com/module';
    const mockDefinition: ModuleDefinition = {
      module    : moduleUri,
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
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      cache.set(`local~owner~${tenantDid}~${moduleUri}`, mockDefinition);
      const dwn = { processMessage: sinon.stub() };
      const getSigner = sinon.stub();

      const result = await getModuleDefinition(tenantDid, moduleUri, dwn, getSigner, cache);
      expect(result).toBe(mockDefinition);
      expect(dwn.processMessage.callCount).toBe(0);
    });

    it('should query the DWN and cache the result on cache miss', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status  : { code: 200 },
          entries : [{ descriptor: { definition: mockDefinition } }],
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getModuleDefinition(tenantDid, moduleUri, dwn, getSigner, cache);
      expect(result).toEqual(mockDefinition);
      expect(cache.get(`local~owner~${tenantDid}~${moduleUri}`)).toEqual(mockDefinition);
    });

    it('should return undefined if DWN query returns non-200 status', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status: { code: 404 },
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getModuleDefinition(tenantDid, moduleUri, dwn, getSigner, cache);
      expect(result).toBeUndefined();
    });

    it('should return undefined if DWN query returns empty entries', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const dwn = {
        processMessage: sinon.stub().resolves({
          status  : { code: 200 },
          entries : [],
        }),
      };
      const getSigner = await createRealSigner();

      const result = await getModuleDefinition(tenantDid, moduleUri, dwn, getSigner, cache);
      expect(result).toBeUndefined();
    });

    it('should isolate unpublished cached definitions by caller and grant', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const owner = await TestDataGenerator.generatePersona();
      const delegate = await TestDataGenerator.generatePersona();
      const getSigner = sinon.stub();
      getSigner.withArgs(tenantDid).resolves(owner.signer);
      getSigner.withArgs(delegate.did).resolves(delegate.signer);
      const dwn = {
        processMessage: sinon.stub()
          .onFirstCall().resolves({
            status  : { code: 200 },
            entries : [{ descriptor: { definition: { ...mockDefinition, published: false } } }],
          })
          .onSecondCall().resolves({ status: { code: 401 } }),
      };

      expect(await getModuleDefinition(
        tenantDid, moduleUri, dwn, getSigner, cache,
      )).toMatchObject({ published: false });
      expect(await getModuleDefinition(
        tenantDid, moduleUri, dwn, getSigner, cache, delegate.did,
      )).toBeUndefined();
      expect(dwn.processMessage.callCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // fetchRemoteModuleDefinition
  // ---------------------------------------------------------------------------
  describe('fetchRemoteModuleDefinition', () => {
    const targetDid = 'did:example:bob';
    const moduleUri = 'https://example.com/module';
    const mockDefinition: ModuleDefinition = {
      module    : moduleUri,
      published : true,
      types     : {},
      structure : {},
    };

    it('should return cached definition if available', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      cache.set(`remote~${targetDid}~${moduleUri}`, mockDefinition);
      const sendDwnRpcRequest = sinon.stub();
      const getDwnEndpointUrls = sinon.stub();

      const result = await fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      );
      expect(result).toBe(mockDefinition);
      expect(sendDwnRpcRequest.callCount).toBe(0);
    });

    it('should query remote DWN and cache the result on cache miss', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: mockDefinition } }],
      } as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      const result = await fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      );
      expect(result).toEqual(mockDefinition);
      expect(cache.get(`remote~${targetDid}~${moduleUri}`)).toEqual(mockDefinition);
      expect(sendDwnRpcRequest.firstCall.args[0].verifyResponse).toBe(true);
    });

    it('should sign the remote query with delegated authorization when supplied', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: mockDefinition } }],
      } as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);
      const delegate = await TestDataGenerator.generatePersona();
      const permissionGrantId = await TestDataGenerator.randomCborSha256Cid();

      await fetchRemoteModuleDefinition(
        targetDid,
        moduleUri,
        getDwnEndpointUrls,
        sendDwnRpcRequest,
        cache,
        'remote',
        { permissionGrantId, signer: delegate.signer },
      );

      const message = sendDwnRpcRequest.firstCall.args[0].message;
      expect(Message.getAuthor(message)).toBe(delegate.did);
      expect(message.descriptor.permissionGrantId).toBe(permissionGrantId);
      expect(sendDwnRpcRequest.firstCall.args[0].verifyResponse).toBe(true);
    });

    it('should not serve a delegated unpublished definition to an anonymous query', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub()
        .onFirstCall().resolves({
          status  : { code: 200 },
          entries : [{ descriptor: { definition: { ...mockDefinition, published: false } } }],
        } as ModulesQueryReply)
        .onSecondCall().resolves({
          status: { code: 401, detail: 'Unauthorized' },
        } as unknown as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);
      const delegate = await TestDataGenerator.generatePersona();

      expect(await fetchRemoteModuleDefinition(
        targetDid,
        moduleUri,
        getDwnEndpointUrls,
        sendDwnRpcRequest,
        cache,
        'remote',
        {
          permissionGrantId : await TestDataGenerator.randomCborSha256Cid(),
          signer            : delegate.signer,
        },
      )).toMatchObject({ published: false });
      await expect(fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toMatchObject({ failure: 'rejected', statusCode: 401 });
      expect(sendDwnRpcRequest.callCount).toBe(2);
    });

    it('should throw when remote DWN returns non-200 status', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 404 },
        entries : [],
      } as unknown as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await expect(fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toMatchObject({ failure: 'rejected', statusCode: 404 });
    });

    it('should throw when remote DWN returns empty entries', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [],
      } as unknown as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await expect(fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toMatchObject({ failure: 'not-found' });
    });

    it('should distinguish a target with no DWN endpoint', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub();
      const getDwnEndpointUrls = sinon.stub().resolves([]);

      await expect(fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toEqual(expect.objectContaining({
        failure : 'no-endpoint',
        name    : RemoteModuleDefinitionError.name,
      }));
      expect(sendDwnRpcRequest.callCount).toBe(0);
    });

    it('should preserve a rejected query status', async () => {
      const cache = new TtlCache<string, ModuleDefinition>({ ttl: 60_000 });
      const sendDwnRpcRequest = sinon.stub().resolves({
        status: { code: 503, detail: 'Service Unavailable' },
      } as unknown as ModulesQueryReply);
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await expect(fetchRemoteModuleDefinition(
        targetDid, moduleUri, getDwnEndpointUrls, sendDwnRpcRequest, cache,
      )).rejects.toMatchObject({ failure: 'rejected', statusCode: 503 });
    });
  });

});
