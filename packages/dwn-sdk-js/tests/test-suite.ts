import type { DataStore, EventLog, MessageStore, ResumableTaskStore } from '../src/index.js';

import { beforeAll } from 'bun:test';

import { testAuthorDelegatedGrant } from './features/author-delegated-grant.spec.js';
import { testDeletedRecordScenarios } from './scenarios/deleted-record.spec.js';
import { testDwnClass } from './dwn.spec.js';
import { testEndToEndScenarios } from './scenarios/end-to-end-tests.spec.js';
import { TestEventLog } from './test-event-stream.js';
import { testMessagesQueryHandler } from './handlers/messages-query.spec.js';
import { testMessagesReadHandler } from './handlers/messages-read.spec.js';
import { testMessagesSubscribeHandler } from './handlers/messages-subscribe.spec.js';
import { testMessageStore } from './store/message-store.spec.js';
import { testModuleComposition } from './features/module-composition.spec.js';
import { testModuleCreateAction } from './features/module-create-action.spec.js';
import { testModuleDeleteAction } from './features/module-delete-action.spec.js';
import { testModuleExampleApps } from './features/module-example-apps.spec.js';
import { testModuleHistoryRevalidation } from './features/module-history-revalidation.spec.js';
import { testModulesConfigureHandler } from './handlers/modules-configure.spec.js';
import { testModulesQueryHandler } from './handlers/modules-query.spec.js';
import { testModuleUpdateAction } from './features/module-update-action.spec.js';
import { testModuleUpgrades } from './features/module-upgrades.spec.js';
import { testNestedRoleScenarios } from './scenarios/nested-roles.spec.js';
import { testOwnerDelegatedGrant } from './features/owner-delegated-grant.spec.js';
import { testOwnerSignature } from './features/owner-signature.spec.js';
import { testPermissions } from './features/permissions.spec.js';
import { testRecordsCountHandler } from './handlers/records-count.spec.js';
import { testRecordsDeleteHandler } from './handlers/records-delete.spec.js';
import { testRecordsDelivery } from './features/records-delivery.spec.js';
import { testRecordsImmutable } from './features/records-immutable.spec.js';
import { testRecordsNestedQueryScope } from './features/records-nested-query-scope.spec.js';
import { testRecordsPrune } from './features/records-prune.spec.js';
import { testRecordsPruneCrossModule } from './features/records-prune-cross-module.spec.js';
import { testRecordsQueryHandler } from './handlers/records-query.spec.js';
import { testRecordsReadHandler } from './handlers/records-read.spec.js';
import { testRecordsRecordLimit } from './features/records-record-limit.spec.js';
import { testRecordsSquash } from './features/records-squash.spec.js';
import { testRecordsSubscribeHandler } from './handlers/records-subscribe.spec.js';
import { testRecordsTags } from './features/records-tags.spec.js';
import { testRecordsWriteHandler } from './handlers/records-write.spec.js';
import { testResumableTasks } from './features/resumable-tasks.spec.js';
import { TestStores } from './test-stores.js';
import { testSubscriptionScenarios } from './scenarios/subscriptions.spec.js';

/**
 * Class for running DWN tests from an external repository that depends on this SDK.
 */
export class TestSuite {

  /**
   * Runs tests that uses the store implementations passed.
   * Uses default implementation if not given.
   */
  public static runInjectableDependentTests(overrides?: {
    messageStore?: MessageStore,
    dataStore?: DataStore,
    eventLog?: EventLog,
    resumableTaskStore?: ResumableTaskStore,
  }): void {

    // Apply now for sub-suites that resolve shared test state during
    // registration. Re-apply in `beforeAll` because a sibling invocation can
    // replace that shared state before this suite executes.
    TestEventLog.override(overrides);
    TestStores.override(overrides);

    beforeAll(async () => {
      TestEventLog.override(overrides);
      TestStores.override(overrides);
    });

    testDwnClass();
    testMessageStore();

    // handler tests
    testMessagesQueryHandler();
    testMessagesReadHandler();
    testMessagesSubscribeHandler();
    testModulesConfigureHandler();
    testModulesQueryHandler();
    testRecordsCountHandler();
    testRecordsDeleteHandler();
    testRecordsQueryHandler();
    testRecordsReadHandler();
    testRecordsSubscribeHandler();
    testRecordsWriteHandler();

    // feature tests
    testAuthorDelegatedGrant();
    testOwnerDelegatedGrant();
    testOwnerSignature();
    testPermissions();
    testModuleComposition();
    testModuleExampleApps();
    testModuleHistoryRevalidation();
    testModuleUpgrades();
    testModuleCreateAction();
    testModuleDeleteAction();
    testModuleUpdateAction();
    testRecordsDelivery();
    testRecordsImmutable();
    testRecordsNestedQueryScope();
    testRecordsPrune();
    testRecordsPruneCrossModule();
    testRecordsRecordLimit();
    testRecordsSquash();
    testRecordsTags();
    testResumableTasks();

    // scenario tests
    testDeletedRecordScenarios();
    testEndToEndScenarios();
    testNestedRoleScenarios();
    testSubscriptionScenarios();
  }
}
