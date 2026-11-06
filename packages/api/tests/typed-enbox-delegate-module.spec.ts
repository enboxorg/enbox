import type { DwnApi, ModulesConfigureResponse, ModulesQueryRequest } from '../src/dwn-api.js';
import type { ModuleDefinition, PublicKeyJwk } from '@enbox/dwn-sdk-js';

import { DidJwk } from '@enbox/dids';
import { ModulesConfigure } from '@enbox/dwn-sdk-js';
import { X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

import { defineModule } from '../src/define-module.js';
import { Module } from '../src/module.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox, WalletReapprovalRequiredError } from '../src/typed-enbox.js';

/**
 * Builds a TypedEnbox instance over a stubbed DwnApi so the private
 * delegate configure path can be exercised without an agent.
 */
function createDelegateTypedEnbox(queryResult: unknown): any {
  const dwn = {
    connectedDid : 'did:dht:owner',
    isDelegate   : true,
    modules      : {
      query: async (): Promise<unknown> => queryResult,
    },
  } as unknown as DwnApi;
  return new TypedEnbox(dwn, defineModule({
    definition : { module: 'https://example.com/modules/demo', published: true, types: {}, structure: {} },
    codecs     : {},
  }));
}

const EncryptedModule = defineModule({
  definition: {
    module    : 'https://example.com/modules/delegate-duplicate',
    published : true,
    types     : { secret: { dataFormats: ['application/json'], encryptionRequired: true } },
    structure : { secret: {} },
  },
  codecs: { secret: recordCodecs.json<{ value: string }>() },
});

async function createDelegateImportFixture(options: {
  changeLocalDefinition?: (definition: ModuleDefinition) => ModuleDefinition;
  importStatus?: ModulesConfigureResponse['status'];
  localMissing?: boolean;
  localQueryStatus?: ModulesConfigureResponse['status'];
} = {}): Promise<{
    importedMessages: unknown[];
    importResult: ModulesConfigureResponse;
    localModule: Module;
    remoteModule: Module;
    typed: TypedEnbox<typeof EncryptedModule.definition, typeof EncryptedModule.codecs>;
  }> {
  const owner = await DidJwk.create();
  const ownerSigner = await owner.getSigner();
  const publicKeyJwk = await X25519.computePublicKey({ key: await X25519.generateKey() }) as PublicKeyJwk;
  const keyAgreement = { publicKeyJwk };
  const definition: ModuleDefinition = {
    ...EncryptedModule.definition,
    $keyAgreement : keyAgreement,
    structure     : { secret: { $keyAgreement: keyAgreement } },
  };
  const signer = {
    algorithm : ownerSigner.algorithm,
    keyId     : ownerSigner.keyId,
    sign      : (data: Uint8Array): Promise<Uint8Array> => ownerSigner.sign({ data }),
  };
  const remoteModule = new Module((await ModulesConfigure.create({
    definition, signer, messageTimestamp: '2026-11-06T00:00:00.000000Z',
  })).message);
  const localModule = new Module((await ModulesConfigure.create({
    definition       : options.changeLocalDefinition?.(structuredClone(definition)) ?? definition,
    signer,
    messageTimestamp : '2026-11-06T00:00:01.000000Z',
  })).message);
  const importResult: ModulesConfigureResponse = {
    status : options.importStatus ?? { code: 409, detail: 'Conflict' },
    module : remoteModule,
  };
  const importedMessages: unknown[] = [];
  const dwn = {
    connectedDid : owner.uri,
    isDelegate   : true,
    modules      : {
      query: async (request: ModulesQueryRequest): Promise<unknown> => request.from === undefined
        ? { status: options.localQueryStatus ?? { code: 200, detail: 'OK' }, modules: options.localMissing ? [] : [localModule] }
        : { status: { code: 200, detail: 'OK' }, modules: [remoteModule] },
    },
    importModuleConfiguration: async (message: unknown): Promise<ModulesConfigureResponse> => {
      importedMessages.push(message);
      return importResult;
    },
  } as unknown as DwnApi;
  return { importedMessages, importResult, localModule, remoteModule, typed: new TypedEnbox(dwn, EncryptedModule) };
}

describe('TypedEnbox delegate module ensure', () => {
  it('should surface authorization failures instead of reporting a missing module', async () => {
    const typed = createDelegateTypedEnbox({
      status  : { code: 401, detail: 'GrantAuthorizationGrantRevoked: grant has been revoked' },
      modules : [],
    });

    await expect(typed.configure()).rejects.toMatchObject({
      status: {
        code   : 401,
        detail : 'GrantAuthorizationGrantRevoked: grant has been revoked',
      },
    });
  });

  it('should require wallet reapproval when the wallet has not installed the module', async () => {
    const typed = createDelegateTypedEnbox({
      status  : { code: 200, detail: 'OK' },
      modules : [],
    });

    await expect(typed.configure()).rejects.toBeInstanceOf(WalletReapprovalRequiredError);
  });

  it('should reuse a matching local wallet configuration for implicit readiness', async () => {
    const requests: unknown[] = [];
    const typed = createDelegateTypedEnbox({
      status  : { code: 200, detail: 'OK' },
      modules : [{ definition: { module: 'https://example.com/modules/demo', published: true, types: {}, structure: {} } }],
    });
    const query = typed._dwn.modules.query;
    typed._dwn.modules.query = async (request: unknown): Promise<unknown> => {
      requests.push(request);
      return query(request);
    };

    await typed._autoConfigureOnce();

    expect(typed._configured).toBe(true);
    expect(requests).toEqual([{ filter: { module: 'https://example.com/modules/demo' } }]);
  });

  it('should return success and the active local module after a verified duplicate import', async () => {
    const fixture = await createDelegateImportFixture();
    const result = await fixture.typed.configure();

    expect(result.status).toEqual({ code: 200, detail: 'OK' });
    expect(result.module).toBe(fixture.localModule);
    expect(result.module).not.toBe(fixture.remoteModule);
    expect(fixture.importedMessages).toEqual([fixture.remoteModule.toJSON()]);
    expect(fixture.importResult.status.code).toBe(409);
    expect(fixture.typed.isConfigured).toBe(true);
  });

  it('should preserve a successful non-conflict import response', async () => {
    const fixture = await createDelegateImportFixture({ importStatus: { code: 202, detail: 'Accepted' } });
    expect(await fixture.typed.configure()).toBe(fixture.importResult);
    expect(fixture.typed.isConfigured).toBe(true);
  });

  it('should reject a duplicate when a different local policy remains active', async () => {
    const fixture = await createDelegateImportFixture({
      changeLocalDefinition: definition => ({ ...definition, published: false }),
    });
    await expect(fixture.typed.configure()).rejects.toThrow('not the active local definition');
    expect(fixture.typed.isConfigured).toBe(false);
  });

  it('should reject a duplicate when the active local encryption keys differ', async () => {
    const otherPublicKey = await X25519.computePublicKey({ key: await X25519.generateKey() }) as PublicKeyJwk;
    const fixture = await createDelegateImportFixture({
      changeLocalDefinition: definition => ({ ...definition, $keyAgreement: { publicKeyJwk: otherPublicKey } }),
    });
    await expect(fixture.typed.configure()).rejects.toThrow('not the active local definition');
    expect(fixture.typed.isConfigured).toBe(false);
  });

  it('should reject a duplicate without an active local module', async () => {
    const fixture = await createDelegateImportFixture({ localMissing: true });
    await expect(fixture.typed.configure()).rejects.toThrow('not the active local definition');
    expect(fixture.typed.isConfigured).toBe(false);
  });

  it('should preserve a non-conflict import error even when a matching local module exists', async () => {
    const fixture = await createDelegateImportFixture({ importStatus: { code: 401, detail: 'Unauthorized' } });
    await expect(fixture.typed.configure()).rejects.toMatchObject({ status: { code: 401, detail: 'Unauthorized' } });
    expect(fixture.typed.isConfigured).toBe(false);
  });

  it('should reject a duplicate when the local verification query fails', async () => {
    const fixture = await createDelegateImportFixture({ localQueryStatus: { code: 503, detail: 'Service Unavailable' } });
    await expect(fixture.typed.configure()).rejects.toMatchObject({ status: { code: 503, detail: 'Service Unavailable' } });
    expect(fixture.typed.isConfigured).toBe(false);
  });

});
