import type { SinonStub } from 'sinon';

import type { GenericMessage, ProgressToken, ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  SyncScopeClosureValidatorOperations,
  SyncScopeProtocolHistoryPage,
} from '../src/sync-scope-closure-validator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';

const commentsProtocol = 'https://example.com/comments';
const profilesProtocol = 'https://example.com/profiles';
const threadsProtocol = 'https://example.com/threads';

type SyncScopeClosureOperationStubs = {
  [Method in keyof SyncScopeClosureValidatorOperations]: SinonStub;
};

type SyncScopeClosureValidatorHarness = {
  operations: SyncScopeClosureOperationStubs;
  validator: SyncScopeClosureValidator;
};

describe('SyncScopeClosureValidator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('preserves identity-option validation and skips closure I/O for full replicas', async () => {
    const { operations, validator } = createHarness();

    expect(() => validator.validateOptions(undefined as never)).toThrow(
      'SyncScopeClosureValidator: options.protocols is required — pass \'all\' for a full replica or a non-empty protocol list.'
    );
    expect(() => validator.validateOptions({ protocols: 'invalid' } as never)).toThrow(
      'SyncScopeClosureValidator: protocols must be \'all\' or a non-empty string array.'
    );
    expect(() => validator.validateOptions({ protocols: [] })).toThrow(
      'SyncScopeClosureValidator: protocols must be \'all\' or a non-empty array of protocol URIs. An empty array is ambiguous.'
    );
    expect(() => validator.validateOptions({ protocols: 'all' })).not.toThrow();
    expect(() => validator.validateOptions({ protocols: [commentsProtocol] })).not.toThrow();

    await validator.validateClosure('did:example:alice', { protocols: 'all' });

    expect(operations.resolvePermissionGrantIds.called).toBe(false);
    expect(operations.queryProtocolHistory.called).toBe(false);
  });

  it('walks paged retained history and scans each requested closure protocol once', async () => {
    const { operations, validator } = createHarness();
    const commentsCursor = cursor('1');
    operations.queryProtocolHistory.callsFake(async (query) => {
      if (query.protocol === commentsProtocol && query.cursor === undefined) {
        return historyPage({
          cursor  : commentsCursor,
          drained : false,
          entries : [
            historyEntry(unrelatedMessage()),
            historyEntry(protocolMessage({})),
          ],
        });
      }
      if (query.protocol === commentsProtocol) {
        return historyPage({
          drained : true,
          entries : [historyEntry(protocolMessage(composedProtocolDefinition()))],
        });
      }
      return historyPage({ drained: true });
    });

    await validator.validateClosure('did:example:alice', {
      delegateDid : 'did:example:delegate',
      protocols   : [commentsProtocol, profilesProtocol, threadsProtocol],
    });

    expect(operations.queryProtocolHistory.callCount).toBe(4);
    expect(operations.queryProtocolHistory.firstCall.args[0]).toMatchObject({
      cursor             : undefined,
      delegateDid        : 'did:example:delegate',
      did                : 'did:example:alice',
      limit              : 500,
      permissionGrantIds : ['grant-1'],
      protocol           : commentsProtocol,
    });
    expect(operations.queryProtocolHistory.secondCall.args[0]).toMatchObject({
      cursor   : commentsCursor,
      protocol : commentsProtocol,
    });
    expect(operations.queryProtocolHistory.thirdCall.args[0]).toMatchObject({
      cursor   : undefined,
      protocol : profilesProtocol,
    });
    expect(operations.queryProtocolHistory.getCall(3).args[0]).toMatchObject({
      cursor   : undefined,
      protocol : threadsProtocol,
    });
    expect(operations.resolvePermissionGrantIds.callCount).toBe(3);
  });

  it('reports missing delegated grants and split dependencies with deterministic details', async () => {
    const { operations, validator } = createHarness();
    operations.resolvePermissionGrantIds.callsFake(async (query) => query.protocol === commentsProtocol
      ? { kind: 'granted', permissionGrantIds: ['comments-grant'] }
      : { kind: 'missing' });
    operations.queryProtocolHistory.resolves(historyPage({
      drained : true,
      entries : [historyEntry(protocolMessage(composedProtocolDefinition()))],
    }));

    await expect(validator.validateClosure('did:example:alice', {
      delegateDid : 'did:example:delegate',
      protocols   : [commentsProtocol],
    })).rejects.toThrow(
      'SyncScopeClosureValidator: sync scope closure validation failed for did:example:alice: ' +
      `delegate did:example:delegate lacks Messages.Read grants for closure protocols: ${profilesProtocol}, ${threadsProtocol}; ` +
      `scope splits cross-protocol dependencies: ${commentsProtocol} -> ${profilesProtocol}, ` +
      `${commentsProtocol} -> ${threadsProtocol}; ` +
      `uses protocols outside the sync scope: ${profilesProtocol}, ${threadsProtocol}`
    );

    expect(operations.queryProtocolHistory.calledOnce).toBe(true);
    expect(operations.resolvePermissionGrantIds.callCount).toBe(3);
  });

  it('preserves protocol-history status failures', async () => {
    const { operations, validator } = createHarness();
    operations.queryProtocolHistory.resolves(historyPage({
      drained : true,
      status  : { code: 503, detail: 'temporarily unavailable' },
    }));

    await expect(validator.validateClosure('did:example:alice', {
      protocols: [commentsProtocol],
    })).rejects.toThrow(
      `SyncScopeClosureValidator: local protocol history query failed for did:example:alice / ${commentsProtocol}: ` +
      '503 temporarily unavailable'
    );
    expect(operations.resolvePermissionGrantIds.called).toBe(false);
  });

  it('rejects an undrained protocol-history page without a cursor', async () => {
    const { operations, validator } = createHarness();
    operations.queryProtocolHistory.resolves(historyPage({ drained: false }));

    await expect(validator.validateClosure('did:example:alice', {
      protocols: [commentsProtocol],
    })).rejects.toThrow(
      `SyncScopeClosureValidator: local protocol history query returned no cursor before drain for did:example:alice / ${commentsProtocol}`
    );
  });
});

function createHarness(): SyncScopeClosureValidatorHarness {
  const operations = {
    queryProtocolHistory      : sinon.stub().resolves(historyPage({ drained: true })),
    resolvePermissionGrantIds : sinon.stub().resolves({ kind: 'granted', permissionGrantIds: ['grant-1'] }),
  } satisfies SyncScopeClosureValidatorOperations;
  return {
    operations,
    validator: new SyncScopeClosureValidator({ operations }),
  };
}

function cursor(position: string): ProgressToken {
  return {
    epoch    : 'epoch-1',
    position,
    streamId : 'stream-1',
  };
}

function historyPage(
  overrides: Partial<SyncScopeProtocolHistoryPage>,
): SyncScopeProtocolHistoryPage {
  return {
    status: { code: 200, detail: 'OK' },
    ...overrides,
  };
}

function historyEntry(message: GenericMessage): NonNullable<SyncScopeProtocolHistoryPage['entries']>[number] {
  return {
    isLatestBaseState : true,
    message,
    messageCid        : 'protocol-cid',
    seq               : '1',
  };
}

function protocolMessage(definition: unknown): GenericMessage {
  return {
    descriptor: {
      definition,
      interface        : DwnInterfaceName.Protocols,
      messageTimestamp : '2026-01-01T00:00:00.000Z',
      method           : DwnMethodName.Configure,
    },
  } as GenericMessage;
}

function unrelatedMessage(): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      messageTimestamp : '2026-01-01T00:00:00.000Z',
      method           : DwnMethodName.Delete,
    },
  } as GenericMessage;
}

function composedProtocolDefinition(): ProtocolDefinition {
  return {
    protocol  : commentsProtocol,
    published : true,
    structure : {
      profile: {
        $ref: 'profiles:profile',
      },
      thread: {
        $ref: 'threads:thread',
      },
    },
    types: {
      profile: {
        dataFormats : ['application/json'],
        schema      : `${commentsProtocol}/profile`,
      },
      thread: {
        dataFormats : ['application/json'],
        schema      : `${commentsProtocol}/thread`,
      },
    },
    uses: {
      threads  : threadsProtocol,
      profiles : profilesProtocol,
    },
  };
}
