import type { Filter } from '../../src/types/query-types.js';
import type { MessagesFilter } from '../../src/types/messages-types.js';

import { CoreModuleRegistry } from '../../src/core/core-module.js';
import { FilterUtility } from '../../src/utils/filter.js';
import { Messages } from '../../src/utils/messages.js';
import { PermissionsModule } from '../../src/modules/permissions.js';
import { DwnInterfaceName, DwnMethodName, TestDataGenerator } from '../../src/index.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('Messages Utils', () => {
  let coreModules: CoreModuleRegistry;

  beforeAll(() => {
    coreModules = new CoreModuleRegistry();
    coreModules.register(new PermissionsModule());
  });

  afterAll(() => {
    sinon.restore();
  });

  beforeEach(() => {
    sinon.restore();
  });

  describe('normalizeFilters', () => {
    it('normalizes module URLs in filters', () => {
      const filters: MessagesFilter[] = [
        { module: 'http://example.com/module/' },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(1);
      expect(result[0].module).toBe('http://example.com/module');
    });

    it('removes undefined properties from filters', () => {
      const filters: MessagesFilter[] = [
        { interface: DwnInterfaceName.Records, module: undefined },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('module');
      expect(result[0].interface).toBe(DwnInterfaceName.Records);
    });

    it('excludes filters that become empty after removing undefined properties', () => {
      const filters: MessagesFilter[] = [
        { module: undefined } as any,
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(0);
    });

    it('returns multiple normalized filters', () => {
      const filters: MessagesFilter[] = [
        { module: 'http://example.com/a/' },
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Write },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(2);
      expect(result[0].module).toBe('http://example.com/a');
      expect(result[1].interface).toBe(DwnInterfaceName.Records);
    });
  });

  describe('constructPermissionRecordsFilter', () => {
    it('does not apply any tag filters to non-module-filtered messages', async () => {
      const messagesFilter: MessagesFilter = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write
      };

      const messageFilter: Filter[] = Messages.convertFilters([messagesFilter]);
      expect(messageFilter).toHaveLength(1);
      expect(messageFilter[0].interface).toBe(DwnInterfaceName.Records);
      expect(messageFilter[0].method).toEqual(DwnMethodName.Write);
    });

    it('applies appropriate tag filters to module-filtered messages', async () => {
      // in order to filter for module-specific permission requests, grants and revocations we add a a module tag index to the message
      // when we filter for a module, we should add the tag filters in to accommodate for the module tag index

      const exampleModule = 'https://example.xyz/module/1';

      // only a module filter is applied
      const moduleMessagesFilter: MessagesFilter = {
        module: exampleModule,
      };

      // here we are testing where only a module MessagesFilter is applied
      // we should expect the MessagesFilter to be split into two MessageStore Filters
      // the first filter should be the module tag filter applied to the permissions module uri
      // the second filter should be the remaining filter, only containing a module filter to the module we are targeting
      const moduleMessageFilter: Filter[] = Messages.convertFilters([moduleMessagesFilter], coreModules);
      expect(moduleMessageFilter).toHaveLength(2);

      const permissionRecordsFilter = moduleMessageFilter[0];
      // should have two filter properties: module tag filter and a module filter for the permissions module
      expect(Object.keys(permissionRecordsFilter)).toHaveLength(2);
      expect(permissionRecordsFilter['tag.module']).toBe(exampleModule);
      expect(permissionRecordsFilter.module).toBe(PermissionsModule.uri);

      // should only have a module filter for the targeted module
      const remainingFilter = moduleMessageFilter[1];
      expect(Object.keys(remainingFilter)).toHaveLength(1);
      expect(remainingFilter.module).toBe(exampleModule);


      // with other filters in addition to the filtered module
      const otherMessagesFilter: MessagesFilter = {
        module    : exampleModule,
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write
      };

      const messageFilter: Filter[] = Messages.convertFilters([otherMessagesFilter], coreModules);
      expect(messageFilter).toHaveLength(2);

      const moduleTagFilter2 = messageFilter[0];
      // should have two filter properties: module tag filter and a module filter for the permissions module
      expect(Object.keys(moduleTagFilter2)).toHaveLength(2);
      expect(permissionRecordsFilter['tag.module']).toBe(exampleModule);
      expect(permissionRecordsFilter.module).toBe(PermissionsModule.uri);

      const remainingFilter2 = messageFilter[1];
      // should have the remaining filters
      expect(Object.keys(remainingFilter2)).toHaveLength(3);
      expect(remainingFilter2.module).toBe(exampleModule);
      expect(remainingFilter2.interface).toBe(DwnInterfaceName.Records);
      expect(remainingFilter2.method).toEqual(DwnMethodName.Write);
    });

    it('applies appropriate tag filters to module-filtered messages with messageTimestamp filter', async () => {
      // should apply the dateUpdated filter to the module tag filter

      const exampleModule = 'https://example.xyz/module/1';
      const dateUpdatedTimestamp = TestDataGenerator.randomTimestamp();
      const messageTimestampFilterResult = FilterUtility.convertRangeCriterion({ from: dateUpdatedTimestamp });

      const withDateUpdatedFilter: MessagesFilter = {
        module           : exampleModule,
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Write,
        messageTimestamp : { from: dateUpdatedTimestamp }
      };

      const messageFilter: Filter[] = Messages.convertFilters([withDateUpdatedFilter], coreModules);
      expect(messageFilter).toHaveLength(2);
      expect(messageFilter[0].module).toBe(PermissionsModule.uri);
      expect(messageFilter[0]['tag.module']).toBe(exampleModule);
      expect(messageFilter[0].messageTimestamp).toEqual(messageTimestampFilterResult);


      expect(messageFilter[1].module).toBe(exampleModule);
      expect(messageFilter[1].interface).toBe(DwnInterfaceName.Records);
      expect(messageFilter[1].method).toEqual(DwnMethodName.Write);
      expect(messageFilter[1].messageTimestamp).toEqual(messageTimestampFilterResult);
    });

    it('omits support-record shadow filters when requested', () => {
      const messageFilter = Messages.convertFilters([{
        module           : 'https://example.xyz/module/1',
        modulePathPrefix : 'post',
      }], coreModules, false);

      expect(messageFilter).toEqual([{
        module     : 'https://example.xyz/module/1',
        modulePath : { subtree: 'post' },
      }]);
    });
  });
});
