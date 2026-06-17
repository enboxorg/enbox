import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ProtocolRuleSet, ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';

import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { ProtocolsConfigure } from '../../src/interfaces/protocols-configure.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { UniversalResolver } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

export function testRecordsDelivery(): void {
  describe('Records $delivery', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
    // so that different test suites can reuse the same backend store for testing
    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;
      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore();

      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    describe('ProtocolsConfigure validation', () => {
      it('should allow $delivery with strategy "direct"', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-direct',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $delivery : 'direct',
              $actions  : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$delivery).toBe('direct');
      });

      it('should allow $delivery with strategy "subscribe"', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-subscribe',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $delivery : 'subscribe',
              $actions  : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$delivery).toBe('subscribe');
      });

      it('should allow $delivery on nested protocol paths', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-nested',
          published : true,
          types     : { thread: {}, message: {} },
          structure : {
            thread: {
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
              message  : {
                $delivery : 'direct',
                $actions  : [{ who: 'anyone', can: ['create', 'read'] }],
              }
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
        const threadRuleSet = protocolsConfigure.message.descriptor.definition.structure.thread as ProtocolRuleSet;
        expect((threadRuleSet.message as ProtocolRuleSet).$delivery).toBe('direct');
      });

      it('should reject $delivery with an invalid strategy value via JSON schema', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-invalid',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $delivery : 'relay' as any,
              $actions  : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow('SchemaValidator');
      });

      it('should reject $delivery on a $ref node', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad-delivery-ref.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {},
          structure : {
            thread: {
              $ref      : 'threads:thread',
              $delivery : 'direct',
            },
          },
        };

        try {
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should warn when $delivery is set without $actions', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const warnSpy = sinon.spy(console, 'warn');

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-no-actions',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $delivery: 'direct',
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(reply.status.code).toBe(202);

        expect(warnSpy.called).toBe(true);
        expect(warnSpy.firstCall.args[0]).toContain('$delivery');
        expect(warnSpy.firstCall.args[0]).toContain('$actions');
      });

      it('should accept $delivery alongside other directives', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-with-directives',
          published : true,
          types     : { message: { schema: 'http://example.com/schema', dataFormats: ['application/json'] } },
          structure : {
            message: {
              $delivery    : 'direct',
              $actions     : [{ who: 'anyone', can: ['create', 'read'] }],
              $size        : { min: 0, max: 10000 },
              $recordLimit : { max: 100, strategy: 'reject' },
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$delivery).toBe('direct');
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$size).toEqual({ min: 0, max: 10000 });
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$recordLimit).toEqual({
          max      : 100,
          strategy : 'reject',
        });
      });

      it('should accept protocol installation with $delivery via DWN processMessage', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://example.com/delivery-install',
          published : true,
          types     : {
            participant : {},
            message     : {},
          },
          structure: {
            participant: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
            },
            message: {
              $delivery : 'direct',
              $actions  : [
                { who: 'anyone', can: ['create', 'read'] },
                { role: 'participant', can: ['read'] },
              ],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(reply.status.code).toBe(202);
      });
    });
  });
}

testRecordsDelivery();
