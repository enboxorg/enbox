import type { SinonStub } from 'sinon';

import type { GenericMessage, ModuleDefinition, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncScopeClosureValidatorOperations,
  SyncScopeModuleHistoryPage,
} from '../src/sync-scope-closure-validator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';

const commentsModule = 'https://example.com/comments';
const profilesModule = 'https://example.com/profiles';
const threadsModule = 'https://example.com/threads';

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
      'SyncScopeClosureValidator: options.modules is required — pass \'all\' for a full replica or a non-empty module list.'
    );
    expect(() => validator.validateOptions({ modules: 'invalid' } as never)).toThrow(
      'SyncScopeClosureValidator: modules must be \'all\' or a non-empty string array.'
    );
    expect(() => validator.validateOptions({ modules: [] })).toThrow(
      'SyncScopeClosureValidator: modules must be \'all\' or a non-empty array of module URIs. An empty array is ambiguous.'
    );
    expect(() => validator.validateOptions({ modules: 'all' })).not.toThrow();
    expect(() => validator.validateOptions({ modules: [commentsModule] })).not.toThrow();
    expect(() => validator.validateOptions({ protocols: [commentsModule] } as never)).toThrow('options.modules is required');
    expect(() => validator.validateOptions({ modules: 'all', protocols: [commentsModule] } as never))
      .toThrow('unrecognized sync identity option');

    await validator.validateClosure('did:example:alice', { modules: 'all' });

    expect(operations.resolvePermissionGrantIds.called).toBe(false);
    expect(operations.queryModuleHistory.called).toBe(false);
  });

  it('walks paged retained history and scans each requested closure module once', async () => {
    const { operations, validator } = createHarness();
    const commentsCursor = cursor('1');
    operations.queryModuleHistory.callsFake(async (query) => {
      if (query.module === commentsModule && query.cursor === undefined) {
        return historyPage({
          cursor  : commentsCursor,
          drained : false,
          entries : [
            historyEntry(unrelatedMessage()),
            historyEntry(moduleMessage({})),
          ],
        });
      }
      if (query.module === commentsModule) {
        return historyPage({
          drained : true,
          entries : [historyEntry(moduleMessage(composedModuleDefinition()))],
        });
      }
      return historyPage({ drained: true });
    });

    await validator.validateClosure('did:example:alice', {
      delegateDid : 'did:example:delegate',
      modules     : [commentsModule, profilesModule, threadsModule],
    });

    expect(operations.queryModuleHistory.callCount).toBe(4);
    expect(operations.queryModuleHistory.firstCall.args[0]).toMatchObject({
      cursor             : undefined,
      delegateDid        : 'did:example:delegate',
      did                : 'did:example:alice',
      limit              : 500,
      permissionGrantIds : ['grant-1'],
      module             : commentsModule,
    });
    expect(operations.queryModuleHistory.secondCall.args[0]).toMatchObject({
      cursor : commentsCursor,
      module : commentsModule,
    });
    expect(operations.queryModuleHistory.thirdCall.args[0]).toMatchObject({
      cursor : undefined,
      module : profilesModule,
    });
    expect(operations.queryModuleHistory.getCall(3).args[0]).toMatchObject({
      cursor : undefined,
      module : threadsModule,
    });
    expect(operations.resolvePermissionGrantIds.callCount).toBe(3);
  });

  it('reports missing delegated grants and split dependencies with deterministic details', async () => {
    const { operations, validator } = createHarness();
    operations.resolvePermissionGrantIds.callsFake(async (query) => query.module === commentsModule
      ? { kind: 'granted', permissionGrantIds: ['comments-grant'] }
      : { kind: 'missing' });
    operations.queryModuleHistory.resolves(historyPage({
      drained : true,
      entries : [historyEntry(moduleMessage(composedModuleDefinition()))],
    }));

    await expect(validator.validateClosure('did:example:alice', {
      delegateDid : 'did:example:delegate',
      modules     : [commentsModule],
    })).rejects.toThrow(
      'SyncScopeClosureValidator: sync scope closure validation failed for did:example:alice: ' +
      `delegate did:example:delegate lacks Messages.Read grants for closure modules: ${profilesModule}, ${threadsModule}; ` +
      `scope splits cross-module dependencies: ${commentsModule} -> ${profilesModule}, ` +
      `${commentsModule} -> ${threadsModule}; ` +
      `uses modules outside the sync scope: ${profilesModule}, ${threadsModule}`
    );

    expect(operations.queryModuleHistory.calledOnce).toBe(true);
    expect(operations.resolvePermissionGrantIds.callCount).toBe(3);
  });

  it('preserves module-history status failures', async () => {
    const { operations, validator } = createHarness();
    operations.queryModuleHistory.resolves(historyPage({
      drained : true,
      status  : { code: 503, detail: 'temporarily unavailable' },
    }));

    await expect(validator.validateClosure('did:example:alice', {
      modules: [commentsModule, profilesModule],
    })).rejects.toThrow(
      `SyncScopeClosureValidator: local module history query failed for did:example:alice / ${commentsModule}: ` +
      '503 temporarily unavailable'
    );
    expect(operations.resolvePermissionGrantIds.called).toBe(false);
    // A failed retained-history scan must stop before querying the next module.
    expect(operations.queryModuleHistory.calledOnce).toBe(true);
  });

  it('rejects an undrained module-history page without a cursor', async () => {
    const { operations, validator } = createHarness();
    operations.queryModuleHistory.resolves(historyPage({ drained: false }));

    await expect(validator.validateClosure('did:example:alice', {
      modules: [commentsModule],
    })).rejects.toThrow(
      `SyncScopeClosureValidator: local module history query returned no cursor before drain for did:example:alice / ${commentsModule}`
    );
  });
});

function createHarness(): SyncScopeClosureValidatorHarness {
  const operations = {
    queryModuleHistory        : sinon.stub().resolves(historyPage({ drained: true })),
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
  overrides: Partial<SyncScopeModuleHistoryPage>,
): SyncScopeModuleHistoryPage {
  return {
    status: { code: 200, detail: 'OK' },
    ...overrides,
  };
}

function historyEntry(message: GenericMessage): NonNullable<SyncScopeModuleHistoryPage['entries']>[number] {
  return {
    isLatestBaseState : true,
    message,
    messageCid        : 'module-cid',
    seq               : '1',
  };
}

function moduleMessage(definition: unknown): GenericMessage {
  return {
    descriptor: {
      definition,
      interface        : DwnInterfaceName.Modules,
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

function composedModuleDefinition(): ModuleDefinition {
  return {
    module    : commentsModule,
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
        schema      : `${commentsModule}/profile`,
      },
      thread: {
        dataFormats : ['application/json'],
        schema      : `${commentsModule}/thread`,
      },
    },
    uses: {
      threads  : threadsModule,
      profiles : profilesModule,
    },
  };
}
