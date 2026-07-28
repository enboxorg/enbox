import type { DwnApi } from '../src/dwn-api.js';
import type { Protocol } from '../src/protocol.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from '../src/record-codec.js';
import type { TypedProtocol } from '../src/protocol-types.js';
import type { DwnMessage, EnboxPlatformAgent } from '@enbox/agent';
import type { TypedEnbox, VerifyInstalledResult } from '../src/typed-enbox.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { WalletReapprovalRequiredError } from '../src/typed-enbox.js';
import { ProtocolReadinessApi, ProtocolReadinessError } from '../src/protocol-readiness.js';

const OWNER_DID = 'did:example:owner';
const DELEGATE_DID = 'did:example:delegate';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/readiness-notes',
  published : true,
  types     : {
    note: { schema: 'https://example.com/schemas/readiness-note', dataFormats: ['application/json'] },
  },
  structure: { note: {} },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ text: string }>(),
});

type TypedStub = {
  configure: sinon.SinonStub;
  definition: ProtocolDefinition;
  protocol: string;
  verifyInstalled: sinon.SinonStub;
};

function createTypedStub(
  protocol: TypedProtocol,
  verification: VerifyInstalledResult = upToDateVerification(),
): TypedStub {
  return {
    configure       : sinon.stub().resolves({ status: { code: 200, detail: 'OK' } }),
    definition      : protocol.definition,
    protocol        : protocol.definition.protocol,
    verifyInstalled : sinon.stub().resolves(verification),
  };
}

function upToDateVerification(protocol?: Protocol): VerifyInstalledResult {
  return {
    definitionsMatch         : true,
    installed                : true,
    missingKeyAgreementPaths : [],
    protocol,
    status                   : 'up-to-date',
  };
}

function createReadinessApi(options: {
  agent?: EnboxPlatformAgent;
  delegateDid?: string;
  dwn?: DwnApi;
  signal?: AbortSignal;
  typed: Map<string, TypedStub>;
}): ProtocolReadinessApi {
  const using = <D extends ProtocolDefinition, C extends RecordCodecMap>(
    protocol: TypedProtocol<D, C>,
  ): TypedEnbox<D, C> => options.typed.get(protocol.definition.protocol) as unknown as TypedEnbox<D, C>;

  return new ProtocolReadinessApi({
    agent        : options.agent ?? createUnusedAgent(),
    connectedDid : OWNER_DID,
    delegateDid  : options.delegateDid,
    dwn          : options.dwn ?? {} as DwnApi,
    signal       : options.signal ?? new AbortController().signal,
    using,
  });
}

function createUnusedAgent(): EnboxPlatformAgent {
  return {
    processDwnRequest : sinon.stub().rejects(new Error('owner path must not run')),
    rpc               : { sendDwnRequest: sinon.stub().rejects(new Error('remote publish must not run')) },
  } as unknown as EnboxPlatformAgent;
}

function createOwnerAgent(initial: Record<string, ProtocolDefinition> = {}): {
  agent: EnboxPlatformAgent;
  getRemoteDwnEndpointUrls: sinon.SinonStub;
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
} {
  const installed = new Map(Object.entries(initial));
  const processDwnRequest = sinon.stub().callsFake(async (request: {
    messageParams: { definition?: ProtocolDefinition; filter?: { protocol?: string } };
    messageType: DwnInterface;
  }) => {
    if (request.messageType === DwnInterface.ProtocolsConfigure) {
      const definition = request.messageParams.definition!;
      installed.set(definition.protocol, definition);
      return {
        messageCid : 'configure-cid',
        message    : protocolMessage(definition),
        reply      : { status: { code: 202, detail: 'Accepted' } },
      };
    }

    const protocol = request.messageParams.filter?.protocol;
    const definition = protocol === undefined ? undefined : installed.get(protocol);
    return {
      messageCid : 'query-cid',
      message    : { descriptor: { interface: 'Protocols', method: 'Query' } },
      reply      : {
        entries : definition === undefined ? [] : [protocolMessage(definition)],
        status  : { code: 200, detail: 'OK' },
      },
    };
  });
  const getRemoteDwnEndpointUrls = sinon.stub().resolves([]);
  const sendDwnRequest = sinon.stub();
  const agent = {
    dwn: {
      getEncryptionKeyDeriver: sinon.stub().rejects(new Error('plain protocol has no encryption keys')),
      getRemoteDwnEndpointUrls,
    },
    processDwnRequest,
    rpc: { sendDwnRequest },
  } as unknown as EnboxPlatformAgent;
  return { agent, getRemoteDwnEndpointUrls, processDwnRequest, sendDwnRequest };
}

function protocolMessage(definition: ProtocolDefinition): DwnMessage[DwnInterface.ProtocolsConfigure] {
  return {
    authorization : { signature: 'owner-signature' },
    descriptor    : {
      definition,
      interface        : 'Protocols',
      messageTimestamp : '2026-07-28T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as unknown as DwnMessage[DwnInterface.ProtocolsConfigure];
}

describe('ProtocolReadinessApi', () => {
  it('preserves cancellation after delegate verification and before local import', async () => {
    const controller = new AbortController();
    const cancellation = new Error('session ended');
    const walletMessage = protocolMessage(NotesDefinition);
    const remoteProtocol = {
      toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage,
    } as unknown as Protocol;
    const typed = createTypedStub(NotesProtocol, upToDateVerification(remoteProtocol));
    typed.verifyInstalled.callsFake(async () => {
      controller.abort(cancellation);
      return upToDateVerification(remoteProtocol);
    });
    const importProtocolConfiguration = sinon.stub();
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      dwn         : { importProtocolConfiguration } as unknown as DwnApi,
      signal      : controller.signal,
      typed       : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    })).rejects.toBe(cancellation);

    expect(importProtocolConfiguration.called).toBe(false);
  });

  it('does not seed delegate readiness when cancellation lands during local verification', async () => {
    const controller = new AbortController();
    const cancellation = new Error('session ended');
    const walletMessage = protocolMessage(NotesDefinition);
    const remoteProtocol = {
      toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage,
    } as unknown as Protocol;
    const typed = createTypedStub(NotesProtocol, upToDateVerification(remoteProtocol));
    const query = sinon.stub().callsFake(async () => {
      controller.abort(cancellation);
      return {
        protocols : [remoteProtocol],
        status    : { code: 200, detail: 'OK' },
      };
    });
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      dwn         : {
        importProtocolConfiguration: sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } }),
        get protocols(): { query: typeof query } { return { query }; },
      } as unknown as DwnApi,
      signal : controller.signal,
      typed  : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    })).rejects.toBe(cancellation);

    expect(typed.configure.called).toBe(false);
  });

  it('rejects a missing runtime publication policy before doing readiness work', async () => {
    const owner = createOwnerAgent();
    const typed = createTypedStub(NotesProtocol);
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : undefined as never,
    })).rejects.toThrow('publication must be either \'local-only\' or \'required\'');

    expect(owner.processDwnRequest.called).toBe(false);
    expect(typed.configure.called).toBe(false);
  });

  it('configures owner protocols without resolving or publishing in explicit local-only mode', async () => {
    const owner = createOwnerAgent();
    const typed = createTypedStub(NotesProtocol);
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([[NotesDefinition.protocol, typed]]),
    });

    await api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'local-only',
    });

    expect(owner.getRemoteDwnEndpointUrls.called).toBe(false);
    expect(owner.sendDwnRequest.called).toBe(false);
    expect(owner.processDwnRequest.getCalls().filter(
      (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
    )).toHaveLength(1);
    expect(typed.configure.calledOnce).toBe(true);
  });

  it('surfaces required publication without advertised endpoints as a typed actionable error', async () => {
    const owner = createOwnerAgent();
    const typed = createTypedStub(NotesProtocol);
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([[NotesDefinition.protocol, typed]]),
    });

    let failure: unknown;
    try {
      await api.ensureReady({
        application : defineApplicationManifest({ protocols: [NotesProtocol] }),
        publication : 'required',
        targetDid   : 'did:example:hosted-owner',
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProtocolReadinessError);
    expect(failure).toMatchObject({
      protocol  : NotesDefinition.protocol,
      recovery  : 'retry',
      stage     : 'endpoint-resolution',
      targetDid : 'did:example:hosted-owner',
    });
  });

  it('retains a rejected owner local configure status', async () => {
    const owner = createOwnerAgent();
    owner.processDwnRequest.onSecondCall().resolves({
      message : protocolMessage(NotesDefinition),
      reply   : { status: { code: 400, detail: 'invalid definition', errorCode: 'InvalidProtocol' } },
    });
    const typed = createTypedStub(NotesProtocol);
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'local-only',
    })).rejects.toMatchObject({
      stage  : 'local-configure',
      status : { code: 400, detail: 'invalid definition', errorCode: 'InvalidProtocol' },
    });
  });

  it('labels a thrown owner cache-seeding failure as local verification', async () => {
    const owner = createOwnerAgent();
    const typed = createTypedStub(NotesProtocol);
    typed.configure.rejects(new Error('local query unavailable'));
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'local-only',
    })).rejects.toMatchObject({
      protocol : NotesDefinition.protocol,
      recovery : 'retry',
      stage    : 'local-verify',
    });
  });

  it('orders manifest protocols by in-manifest uses dependencies', async () => {
    const DependencyDefinition = {
      ...NotesDefinition,
      protocol: 'https://example.com/protocols/readiness-membership',
    } as const satisfies ProtocolDefinition;
    const DependencyProtocol = defineProtocol(DependencyDefinition, NotesProtocol.codecs);
    const BoardDefinition = {
      ...NotesDefinition,
      protocol : 'https://example.com/protocols/readiness-board',
      uses     : { membership: DependencyDefinition.protocol },
    } as const satisfies ProtocolDefinition;
    const BoardProtocol = defineProtocol(BoardDefinition, NotesProtocol.codecs);
    const owner = createOwnerAgent();
    const configureOrder: string[] = [];
    owner.processDwnRequest.callsFake(async (request: {
      messageParams: { definition?: ProtocolDefinition; filter?: { protocol?: string } };
      messageType: DwnInterface;
    }) => {
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        configureOrder.push(request.messageParams.definition!.protocol);
        return {
          messageCid : 'configure-cid',
          message    : protocolMessage(request.messageParams.definition!),
          reply      : { status: { code: 202, detail: 'Accepted' } },
        };
      }
      const configured = configureOrder.includes(request.messageParams.filter?.protocol ?? '');
      const definition = request.messageParams.filter?.protocol === DependencyDefinition.protocol
        ? DependencyDefinition
        : BoardDefinition;
      return {
        messageCid : 'query-cid',
        message    : { descriptor: { interface: 'Protocols', method: 'Query' } },
        reply      : {
          entries : configured ? [protocolMessage(definition)] : [],
          status  : { code: 200, detail: 'OK' },
        },
      };
    });
    const api = createReadinessApi({
      agent : owner.agent,
      typed : new Map([
        [DependencyDefinition.protocol, createTypedStub(DependencyProtocol)],
        [BoardDefinition.protocol, createTypedStub(BoardProtocol)],
      ]),
    });

    await api.ensureReady({
      application : defineApplicationManifest({ protocols: [BoardProtocol, DependencyProtocol] }),
      publication : 'local-only',
    });

    expect(configureOrder).toEqual([DependencyDefinition.protocol, BoardDefinition.protocol]);
  });

  it('imports and verifies the exact wallet-owned message for delegates without publishing', async () => {
    const walletMessage = protocolMessage(NotesDefinition);
    const remoteProtocol = { toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage };
    const importProtocolConfiguration = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
    const query = sinon.stub().resolves({
      protocols : [remoteProtocol],
      status    : { code: 200, detail: 'OK' },
    });
    const typed = createTypedStub(
      NotesProtocol,
      upToDateVerification(remoteProtocol as unknown as Protocol),
    );
    const agent = createUnusedAgent();
    const api = createReadinessApi({
      agent,
      delegateDid : DELEGATE_DID,
      dwn         : {
        importProtocolConfiguration,
        get protocols(): { query: typeof query } { return { query }; },
      } as unknown as DwnApi,
      typed: new Map([[NotesDefinition.protocol, typed]]),
    });

    await api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    });

    expect(importProtocolConfiguration.calledOnceWith(walletMessage)).toBe(true);
    expect((agent.processDwnRequest as sinon.SinonStub).called).toBe(false);
    expect((agent.rpc.sendDwnRequest as sinon.SinonStub).called).toBe(false);
    expect(typed.configure.calledOnce).toBe(true);
  });

  it('preserves WalletReapprovalRequiredError identity for stale delegate configurations', async () => {
    const reapproval = new WalletReapprovalRequiredError(NotesDefinition.protocol, 'is stale.');
    const typed = createTypedStub(NotesProtocol, {
      definitionsMatch         : false,
      error                    : reapproval,
      installed                : true,
      missingKeyAgreementPaths : [],
      reason                   : 'stale',
      status                   : 'wallet-reapproval-required',
    });
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      typed       : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    })).rejects.toBe(reapproval);
  });

  it('retains remote query status and recommends retry for a temporary delegate failure', async () => {
    const typed = createTypedStub(NotesProtocol);
    typed.verifyInstalled.rejects(new DwnResponseError(
      'wallet protocol query',
      { code: 503, detail: 'temporarily unavailable', info: { retryAfter: 1 } },
    ));
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      typed       : new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    })).rejects.toMatchObject({
      recovery : 'retry',
      stage    : 'remote-query',
      status   : { code: 503, detail: 'temporarily unavailable', info: { retryAfter: 1 } },
    });
  });

  it('wraps delegate import exceptions as local-import readiness failures', async () => {
    const walletMessage = protocolMessage(NotesDefinition);
    const remoteProtocol = {
      toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage,
    } as unknown as Protocol;
    const typed = createTypedStub(NotesProtocol, upToDateVerification(remoteProtocol));
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      dwn         : {
        importProtocolConfiguration: sinon.stub().rejects(new Error('local DWN unavailable')),
      } as unknown as DwnApi,
      typed: new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'required',
    })).rejects.toMatchObject({
      protocol : NotesDefinition.protocol,
      recovery : 'retry',
      stage    : 'local-import',
    });
  });

  it('wraps delegate local verification exceptions as typed readiness failures', async () => {
    const walletMessage = protocolMessage(NotesDefinition);
    const remoteProtocol = {
      toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage,
    } as unknown as Protocol;
    const typed = createTypedStub(NotesProtocol, upToDateVerification(remoteProtocol));
    const query = sinon.stub().rejects(new Error('local query unavailable'));
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      dwn         : {
        importProtocolConfiguration: sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } }),
        get protocols(): { query: typeof query } { return { query }; },
      } as unknown as DwnApi,
      typed: new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'local-only',
    })).rejects.toMatchObject({
      protocol : NotesDefinition.protocol,
      recovery : 'retry',
      stage    : 'local-verify',
    });
  });

  it('fails delegate readiness when the local import does not retain the wallet artifact', async () => {
    const walletMessage = protocolMessage(NotesDefinition);
    const otherMessage = protocolMessage({ ...NotesDefinition, published: false });
    const remoteProtocol = {
      toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => walletMessage,
    } as unknown as Protocol;
    const query = sinon.stub().resolves({
      protocols : [{ toJSON: (): DwnMessage[DwnInterface.ProtocolsConfigure] => otherMessage }],
      status    : { code: 200, detail: 'OK' },
    });
    const typed = createTypedStub(NotesProtocol, upToDateVerification(remoteProtocol));
    const api = createReadinessApi({
      delegateDid : DELEGATE_DID,
      dwn         : {
        importProtocolConfiguration: sinon.stub().resolves({ status: { code: 409, detail: 'Conflict' } }),
        get protocols(): { query: typeof query } { return { query }; },
      } as unknown as DwnApi,
      typed: new Map([[NotesDefinition.protocol, typed]]),
    });

    await expect(api.ensureReady({
      application : defineApplicationManifest({ protocols: [NotesProtocol] }),
      publication : 'local-only',
    })).rejects.toMatchObject({
      protocol  : NotesDefinition.protocol,
      recovery  : 'reconnect',
      stage     : 'local-verify',
      targetDid : OWNER_DID,
    });
  });
});
