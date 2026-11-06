import type { ModulesQueryMessage } from '../../src/index.js';

import dexModuleDefinition from '../vectors/module-definitions/dex.json' with { type: 'json' };
import { Jws } from '../../src/index.js';
import { ModulesQuery } from '../../src/interfaces/modules-query.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';

describe('ModulesQuery', () => {
  describe('create()', () => {
    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const modulesQuery = await ModulesQuery.create({
        filter           : { module: 'anyValue' },
        messageTimestamp : currentTime,
        signer           : Jws.createSigner(alice),
      });

      expect(modulesQuery.message.descriptor.messageTimestamp).toBe(currentTime);
    });


    it('should auto-normalize module URI', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        filter     : { module: 'example.com/' },
        definition : dexModuleDefinition
      };
      const modulesConfig = await ModulesQuery.create(options);

      const message = modulesConfig.message as ModulesQueryMessage;

      expect(message.descriptor.filter!.module).toBe('http://example.com');
    });
  });
});
