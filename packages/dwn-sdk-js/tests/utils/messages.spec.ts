import type { Filter } from '../../src/types/query-types.js';
import type { MessagesFilter } from '../../src/types/messages-types.js';

import { CoreProtocolRegistry } from '../../src/core/core-protocol.js';
import { FilterUtility } from '../../src/utils/filter.js';
import { Messages } from '../../src/utils/messages.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { DwnInterfaceName, DwnMethodName, TestDataGenerator } from '../../src/index.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('Messages Utils', () => {
  let coreProtocols: CoreProtocolRegistry;

  beforeAll(() => {
    coreProtocols = new CoreProtocolRegistry();
    coreProtocols.register(new PermissionsProtocol());
  });

  afterAll(() => {
    sinon.restore();
  });

  beforeEach(() => {
    sinon.restore();
  });

  describe('normalizeFilters', () => {
    it('normalizes protocol URLs in filters', () => {
      const filters: MessagesFilter[] = [
        { protocol: 'http://example.com/protocol/' },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('http://example.com/protocol');
    });

    it('removes undefined properties from filters', () => {
      const filters: MessagesFilter[] = [
        { interface: DwnInterfaceName.Records, protocol: undefined },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('protocol');
      expect(result[0].interface).toBe(DwnInterfaceName.Records);
    });

    it('excludes filters that become empty after removing undefined properties', () => {
      const filters: MessagesFilter[] = [
        { protocol: undefined } as any,
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(0);
    });

    it('returns multiple normalized filters', () => {
      const filters: MessagesFilter[] = [
        { protocol: 'http://example.com/a/' },
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Write },
      ];
      const result = Messages.normalizeFilters(filters);
      expect(result).toHaveLength(2);
      expect(result[0].protocol).toBe('http://example.com/a');
      expect(result[1].interface).toBe(DwnInterfaceName.Records);
    });
  });

  describe('constructPermissionRecordsFilter', () => {
    it('does not apply any tag filters to non-protocol-filtered messages', async () => {
      const messagesFilter: MessagesFilter = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write
      };

      const messageFilter: Filter[] = Messages.convertFilters([messagesFilter]);
      expect(messageFilter.length).toBe(1);
      expect(messageFilter[0].interface).toBe(DwnInterfaceName.Records);
      expect(messageFilter[0].method).toEqual(DwnMethodName.Write);
    });

    it('applies appropriate tag filters to protocol-filtered messages', async () => {
      // in order to filter for protocol-specific permission requests, grants and revocations we add a a protocol tag index to the message
      // when we filter for a protocol, we should add the tag filters in to accommodate for the protocol tag index

      const exampleProtocol = 'https://example.xyz/protocol/1';

      // only a protocol filter is applied
      const protocolMessagesFilter: MessagesFilter = {
        protocol: exampleProtocol,
      };

      // here we are testing where only a protocol MessagesFilter is applied
      // we should expect the MessagesFilter to be split into two MessageStore Filters
      // the first filter should be the protocol tag filter applied to the permissions protocol uri
      // the second filter should be the remaining filter, only containing a protocol filter to the protocol we are targeting
      const protocolMessageFilter: Filter[] = Messages.convertFilters([protocolMessagesFilter], coreProtocols);
      expect(protocolMessageFilter.length).toBe(2);

      const permissionRecordsFilter = protocolMessageFilter[0];
      // should have two filter properties: protocol tag filter and a protocol filter for the permissions protocol
      expect(Object.keys(permissionRecordsFilter).length).toBe(2);
      expect(permissionRecordsFilter['tag.protocol']).toBe(exampleProtocol);
      expect(permissionRecordsFilter.protocol).toBe(PermissionsProtocol.uri);

      // should only have a protocol filter for the targeted protocol
      const remainingFilter = protocolMessageFilter[1];
      expect(Object.keys(remainingFilter).length).toBe(1);
      expect(remainingFilter.protocol).toBe(exampleProtocol);


      // with other filters in addition to the filtered protocol
      const otherMessagesFilter: MessagesFilter = {
        protocol  : exampleProtocol,
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write
      };

      const messageFilter: Filter[] = Messages.convertFilters([otherMessagesFilter], coreProtocols);
      expect(messageFilter.length).toBe(2);

      const protocolTagFilter2 = messageFilter[0];
      // should have two filter properties: protocol tag filter and a protocol filter for the permissions protocol
      expect(Object.keys(protocolTagFilter2).length).toBe(2);
      expect(permissionRecordsFilter['tag.protocol']).toBe(exampleProtocol);
      expect(permissionRecordsFilter.protocol).toBe(PermissionsProtocol.uri);

      const remainingFilter2 = messageFilter[1];
      // should have the remaining filters
      expect(Object.keys(remainingFilter2).length).toBe(3);
      expect(remainingFilter2.protocol).toBe(exampleProtocol);
      expect(remainingFilter2.interface).toBe(DwnInterfaceName.Records);
      expect(remainingFilter2.method).toEqual(DwnMethodName.Write);
    });

    it('applies appropriate tag filters to protocol-filtered messages with messageTimestamp filter', async () => {
      // should apply the dateUpdated filter to the protocol tag filter

      const exampleProtocol = 'https://example.xyz/protocol/1';
      const dateUpdatedTimestamp = TestDataGenerator.randomTimestamp();
      const messageTimestampFilterResult = FilterUtility.convertRangeCriterion({ from: dateUpdatedTimestamp });

      const withDateUpdatedFilter: MessagesFilter = {
        protocol         : exampleProtocol,
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Write,
        messageTimestamp : { from: dateUpdatedTimestamp }
      };

      const messageFilter: Filter[] = Messages.convertFilters([withDateUpdatedFilter], coreProtocols);
      expect(messageFilter.length).toBe(2);
      expect(messageFilter[0].protocol).toBe(PermissionsProtocol.uri);
      expect(messageFilter[0]['tag.protocol']).toBe(exampleProtocol);
      expect(messageFilter[0].messageTimestamp).toEqual(messageTimestampFilterResult);


      expect(messageFilter[1].protocol).toBe(exampleProtocol);
      expect(messageFilter[1].interface).toBe(DwnInterfaceName.Records);
      expect(messageFilter[1].method).toEqual(DwnMethodName.Write);
      expect(messageFilter[1].messageTimestamp).toEqual(messageTimestampFilterResult);
    });
  });
});