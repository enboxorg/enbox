import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { afterEach, describe, expect, it } from 'bun:test';

import { Jws } from '@enbox/dwn-sdk-js';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { recordCodecs } from '../src/record-codec.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import {
  createHostedDelegatedEnboxTestContext,
  type HostedDelegatedEnboxTestContext,
} from '../src/testing.js';

describe('createHostedDelegatedEnboxTestContext', () => {
  let context: HostedDelegatedEnboxTestContext | undefined;

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('uses hosted routing and delegated grants for encrypted create, read, and delete', async () => {
    const moduleUri = `https://example.com/modules/hosted-testing-${TestDataGenerator.randomString(15)}`;
    const definition = {
      module    : moduleUri,
      published : false,
      types     : {
        secret: {
          dataFormats        : ['application/json'],
          encryptionRequired : true,
          schema             : `${moduleUri}/schemas/secret`,
        },
      },
      structure: {
        secret: { $immutable: true },
      },
    } as const satisfies ModuleDefinition;
    const module = defineModule(definition, {
      secret: recordCodecs.json<{ message: string }>(),
    });
    const application = defineApplicationManifest({ modules: [module] } as const);

    context = await createHostedDelegatedEnboxTestContext({
      application,
      dwnEndpoints: [testDwnUrl],
    });

    expect(context.session.did).toBe(context.ownerDid);
    expect(context.session.delegateDid).toBe(context.delegateDid);
    expect(context.delegateDid).not.toBe(context.ownerDid);

    const records = context.enbox.using(module).records;
    const created = await records.create('secret', {
      data : { message: 'hosted and delegated' },
      from : context.ownerDid,
    });

    expect(created.rawMessage.encryption).toBeDefined();
    expect(Jws.getSignerDid(created.rawMessage.authorization.signature.signatures[0])).toBe(context.delegateDid);

    const remote = await records.query('secret', { from: context.ownerDid });
    expect(remote.records).toHaveLength(1);
    expect(remote.records[0].id).toBe(created.id);
    expect(await remote.records[0].value()).toEqual({ message: 'hosted and delegated' });

    await records.delete('secret', { from: context.ownerDid, recordId: created.id });
    expect((await records.query('secret', { from: context.ownerDid })).records).toEqual([]);

    await context.close();
    expect(context.session.signal.aborted).toBe(true);
    await context.close();
  });

  it('requires a caller-managed hosted DWN endpoint', async () => {
    const moduleUri = 'https://example.com/modules/hosted-testing-input';
    const module = defineModule({
      module    : moduleUri,
      published : false,
      types     : { note: { dataFormats: ['application/json'] } },
      structure : { note: {} },
    } as const satisfies ModuleDefinition, {
      note: recordCodecs.json<{ body: string }>(),
    });
    const application = defineApplicationManifest({ modules: [module] } as const);

    await expect(createHostedDelegatedEnboxTestContext({
      application,
      dwnEndpoints: [],
    })).rejects.toThrow('requires at least one DWN endpoint');
  });
});
