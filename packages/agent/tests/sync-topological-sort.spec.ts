import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol } from '@enbox/dwn-sdk-js';

import { topologicalSort } from '../src/sync-topological-sort.js';

type SortEntry = { message: GenericMessage };

function makeMessage(overrides: Record<string, unknown> = {}): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : '2024-01-01T00:00:00.000000Z',
      ...overrides,
    },
  } as unknown as GenericMessage;
}

describe('topologicalSort', () => {
  it('should return empty array for empty input', () => {
    const result = topologicalSort([]);
    expect(result).toEqual([]);
  });

  it('should return single-element array unchanged', () => {
    const msg: SortEntry = { message: makeMessage() };
    const result = topologicalSort([msg]);
    expect(result).toEqual([msg]);
  });

  it('should place ProtocolsConfigure before RecordsWrite that references the protocol', () => {
    const configureMsg: SortEntry = {
      message: makeMessage({
        interface  : DwnInterfaceName.Protocols,
        method     : DwnMethodName.Configure,
        definition : { protocol: 'https://example.com/protocol' },
      }),
    };
    const recordsWriteMsg: SortEntry = {
      message: {
        ...makeMessage({
          protocol    : 'https://example.com/protocol',
          dateCreated : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };

    // Input order: records first, protocol second — sort should reverse.
    const result = topologicalSort([recordsWriteMsg, configureMsg]);
    expect(result[0]).toBe(configureMsg);
    expect(result[1]).toBe(recordsWriteMsg);
  });

  it('should place initial write before update write for same recordId', () => {
    const initialWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };
    const updateWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-02T00:00:00.000000Z',
        }),
        recordId: 'rec-1',
      } as unknown as GenericMessage,
    };

    const result = topologicalSort([updateWrite, initialWrite]);
    expect(result[0]).toBe(initialWrite);
    expect(result[1]).toBe(updateWrite);
  });

  it('should place parent record before child record (parentId)', () => {
    const parent: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'parent-rec',
      } as unknown as GenericMessage,
    };
    const child: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'parent-rec',
        }),
        recordId: 'child-rec',
      } as unknown as GenericMessage,
    };

    const result = topologicalSort([child, parent]);
    expect(result[0]).toBe(parent);
    expect(result[1]).toBe(child);
  });

  it('should place initial write before RecordsDelete for same recordId', () => {
    const initialWrite: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        }),
        recordId: 'rec-to-delete',
      } as unknown as GenericMessage,
    };
    const deleteMsg: SortEntry = {
      message: makeMessage({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Delete,
        recordId  : 'rec-to-delete',
      }),
    };

    const result = topologicalSort([deleteMsg, initialWrite]);
    expect(result[0]).toBe(initialWrite);
    expect(result[1]).toBe(deleteMsg);
  });

  it('should place permission grant before records referencing permissionGrantId', () => {
    const grantMsg: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
        }),
        recordId: 'grant-rec-id',
      } as unknown as GenericMessage,
    };
    const dependentMsg: SortEntry = {
      message: makeMessage({
        permissionGrantId: 'grant-rec-id',
      }),
    };

    const result = topologicalSort([dependentMsg, grantMsg]);
    expect(result[0]).toBe(grantMsg);
    expect(result[1]).toBe(dependentMsg);
  });

  it('should handle self-referencing edge (from === to) without infinite loop', () => {
    // A RecordsWrite whose parentId is its own recordId should not break.
    const selfRef: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'self-ref',
        }),
        recordId: 'self-ref',
      } as unknown as GenericMessage,
    };

    const result = topologicalSort([selfRef]);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(selfRef);
  });

  it('should append cycle nodes at the end when a dependency cycle exists', () => {
    // Simulate a cycle: A depends on B (via parentId), B depends on A (via parentId).
    // Both are "initial writes" so initialWriteIndex maps both.
    const msgA: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'rec-b',
        }),
        recordId: 'rec-a',
      } as unknown as GenericMessage,
    };
    const msgB: SortEntry = {
      message: {
        ...makeMessage({
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          parentId         : 'rec-a',
        }),
        recordId: 'rec-b',
      } as unknown as GenericMessage,
    };

    // Both nodes are in a cycle, neither has inDegree 0 when processed together.
    // An independent node should come first.
    const independent: SortEntry = {
      message: {
        ...makeMessage({
          interface  : DwnInterfaceName.Protocols,
          method     : DwnMethodName.Configure,
          definition : { protocol: 'https://example.com/other' },
        }),
      } as unknown as GenericMessage,
    };

    const result = topologicalSort([msgA, msgB, independent]);
    // The independent node should be first; the cycle nodes appended at the end.
    expect(result.length).toBe(3);
    expect(result[0]).toBe(independent);
    // Both cycle nodes are present in the result.
    expect(result.includes(msgA)).toBe(true);
    expect(result.includes(msgB)).toBe(true);
  });

  it('should handle messages with no dependency relations', () => {
    const msg1: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };
    const msg2: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };
    const msg3: SortEntry = { message: makeMessage({ interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }) };

    const result = topologicalSort([msg1, msg2, msg3]);
    expect(result.length).toBe(3);
  });
});
