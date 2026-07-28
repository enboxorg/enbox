import sinon from 'sinon';

import CommonScenarioValidator from '../common-scenario-validator.js';
import { config } from '../../src/config.js';
import DataStoreSqlite from '../plugins/data-store-sqlite.js';
import { DurableEventLog } from '@enbox/dwn-sdk-js';
import { DwnServer } from '../../src/dwn-server.js';
import EventBusInMemory from '../plugins/event-bus-in-memory.js';
import MessageStoreSqlite from '../plugins/message-store-sqlite.js';
import ResumableTaskStoreSqlite from '../plugins/resumable-task-store-sqlite.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { DidDht, DidKey, UniversalResolver } from '@enbox/dids';

function createOpenTestConfig(): typeof config {
  return {
    ...config,
    allowOpenTenants          : true,
    allowUnboundedTenantUsage : true,
    port                      : 0,
  };
}

describe('Dynamic DWN plugin loading', () => {
  let dwnServer: DwnServer;

  afterEach(async () => {
    if (dwnServer !== undefined) {
      await dwnServer.stop();
    }
  });

  it('should fail dynamically loading a non-existent plugin', async () => {
    const dwnServerConfigCopy = createOpenTestConfig();
    dwnServerConfigCopy.dataStore = './non-existent-plugin.js';

    const invalidDwnServer = new DwnServer({ config: dwnServerConfigCopy });
    await expect(invalidDwnServer.start()).rejects.toThrow('Failed to load component at ./non-existent-plugin.js');
  });

  it('should close the event bus if DWN startup fails after loading it', async () => {
    const customEventBusCloseSpy = sinon.spy(EventBusInMemory, 'spyingTheClose');
    const dwnServerConfigCopy = createOpenTestConfig();
    dwnServerConfigCopy.registrationStoreUrl = undefined;
    dwnServerConfigCopy.messageStore = 'unsupported://messages';
    dwnServerConfigCopy.eventBusPluginPath = '../tests/plugins/event-bus-in-memory.js';

    dwnServer = new DwnServer({ config: dwnServerConfigCopy });

    await expect(dwnServer.start()).rejects.toThrow('Unknown storage protocol unsupported');
    expect(customEventBusCloseSpy.calledOnce).toBe(true);
    customEventBusCloseSpy.restore();
  });

  it('should be able to dynamically load and use custom data store implementation', async () => {
    // Scenario:
    // 1. Configure DWN to load a custom data store plugin.
    // 2. Validate that the constructor of the plugin is called.
    // 3. Validate that the DWN instance is using the custom data store plugin.

    // NOTE: was not able to spy on constructor directly, so spying on a method that is called in the constructor
    const customMessageStoreConstructorSpy = sinon.spy(MessageStoreSqlite, 'spyingTheConstructor');
    const customDataStoreConstructorSpy = sinon.spy(DataStoreSqlite, 'spyingTheConstructor');
    const customResumableTaskStoreConstructorSpy = sinon.spy(ResumableTaskStoreSqlite, 'spyingTheConstructor');
    const customEventBusConstructorSpy = sinon.spy(EventBusInMemory, 'spyingTheConstructor');

    // 1. Configure DWN to load a custom data store plugin.
    const dwnServerConfigCopy = createOpenTestConfig();

    // TODO: remove below after https://github.com/enboxorg/enbox/issues/144 is resolved
    // The default config is not reliable because other tests modify it.
    dwnServerConfigCopy.registrationStoreUrl = undefined; // allow all traffic

    dwnServerConfigCopy.messageStore = '../tests/plugins/message-store-sqlite.js';
    dwnServerConfigCopy.dataStore = '../tests/plugins/data-store-sqlite.js';
    dwnServerConfigCopy.resumableTaskStore = '../tests/plugins/resumable-task-store-sqlite.js';
    dwnServerConfigCopy.eventBusPluginPath = '../tests/plugins/event-bus-in-memory.js';

    // 2. Validate that the constructor of the plugin is called.
    // CRITICAL: We need to create a custom DID resolver that does not use a LevelDB based cache (which is the default cache used in `DWN`)
    // otherwise we will receive a `Database is not open` coming from LevelDB.
    // This is likely due to the fact that LevelDB is the default cache used in `DWN`, and we have tests creating default DWN instances,
    // so here we have to create a DWN that does not use the same LevelDB cache to avoid hitting LevelDB locked issues.
    // Long term we should investigate and unify approach of DWN instantiation taken by tests to avoid this "workaround" entirely.
    const didResolver = new UniversalResolver({
      didResolvers: [DidDht, DidKey],
    });
    dwnServer = new DwnServer({ config: dwnServerConfigCopy, didResolver });
    await dwnServer.start();
    expect(customMessageStoreConstructorSpy.calledOnce).toBe(true);
    expect(customDataStoreConstructorSpy.calledOnce).toBe(true);
    expect(customResumableTaskStoreConstructorSpy.calledOnce).toBe(true);
    expect(customEventBusConstructorSpy.calledOnce).toBe(true);
    expect(dwnServer.dwn?.storage.eventLog).toBeInstanceOf(DurableEventLog);

    // 3. Validate that the DWN instance is using the custom data store plugin.
    const testBaseUrl = `http://localhost:${dwnServer.httpServer.port}`;
    await CommonScenarioValidator.sanityTestDwnReadWrite(testBaseUrl);
  });
});
