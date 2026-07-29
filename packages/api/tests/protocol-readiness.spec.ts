import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from '../src/record-codec.js';
import type { TypedEnbox } from '../src/typed-enbox.js';
import type { DwnMessage, EnboxPlatformAgent } from '@enbox/agent';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { createProtocolReadinessApi, ProtocolReadinessError } from '../src/protocol-readiness.js';

const OWNER_DID = 'did:example:owner';
const DELEGATE_DID = 'did:example:delegate';
const TARGET_DID = 'did:example:target';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/readiness-notes',
  published : true,
  types     : { note: { dataFormats: ['application/json'] } },
  structure : { note: {} },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ text: string }>(),
});
const Application = defineApplicationManifest({ protocols: [NotesProtocol] });

type ConfigureMessage = DwnMessage[DwnInterface.ProtocolsConfigure];
type AgentRequest = {
  author: string;
  messageParams?: {
    definition?: ProtocolDefinition;
    filter?: { protocol?: string };
  };
  messageType: DwnInterface;
  rawMessage?: ConfigureMessage;
  remoteEndpointsOnly?: boolean;
  store?: boolean;
  target: string;
};

function messageFor(definition: ProtocolDefinition): ConfigureMessage {
  return {
    authorization : { signature: 'owner-signature' },
    descriptor    : {
      definition,
      interface        : 'Protocols',
      messageTimestamp : '2026-07-29T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as unknown as ConfigureMessage;
}

function hostedKey(target: string, protocol: string): string {
  return `${target}\u0000${protocol}`;
}

function callsFor(stub: sinon.SinonStub, messageType: DwnInterface): sinon.SinonSpyCall[] {
  return stub.getCalls().filter((call): boolean => (
    (call.args[0] as AgentRequest).messageType === messageType
  ));
}

function createFixture(options: {
  delegateDid?: string;
  publishStatus?: { code: number; detail: string };
  retainPublishedDefinition?: boolean;
} = {}): {
  api: ReturnType<typeof createProtocolReadinessApi>;
  configure: sinon.SinonStub;
  hosted: Map<string, ProtocolDefinition>;
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
} {
  const hosted = new Map<string, ProtocolDefinition>();
  const processDwnRequest = sinon.stub().callsFake(async (request: AgentRequest): Promise<unknown> => ({
    message : messageFor(request.messageParams!.definition!),
    reply   : { status: { code: 202, detail: 'Accepted' } },
  }));
  const sendDwnRequest = sinon.stub().callsFake(async (request: AgentRequest): Promise<unknown> => {
    if (request.messageType === DwnInterface.ProtocolsQuery) {
      const protocol = request.messageParams!.filter!.protocol!;
      const definition = hosted.get(hostedKey(request.target, protocol));
      return {
        reply: {
          entries : definition === undefined ? [] : [messageFor(definition)],
          status  : { code: 200, detail: 'OK' },
        },
      };
    }

    const definition = request.rawMessage!.descriptor.definition;
    const key = hostedKey(request.target, definition.protocol);
    const status = options.publishStatus ?? (hosted.has(key)
      ? { code: 409, detail: 'Conflict' }
      : { code: 202, detail: 'Accepted' });
    if (options.retainPublishedDefinition !== false && (status.code < 300 || status.code === 409)) {
      hosted.set(key, definition);
    }
    return { reply: { status } };
  });
  const agent = { processDwnRequest, sendDwnRequest } as unknown as EnboxPlatformAgent;
  const localMessage = messageFor(NotesDefinition);
  const configure = sinon.stub().resolves({
    protocol: {
      definition : NotesDefinition,
      toJSON     : (): ConfigureMessage => localMessage,
    },
    status: { code: 200, detail: 'OK' },
  });
  const typed = {
    configure,
    definition : NotesDefinition,
    protocol   : NotesDefinition.protocol,
  };
  const api = createProtocolReadinessApi({
    agent,
    connectedDid : OWNER_DID,
    delegateDid  : options.delegateDid,
    using        : <D extends ProtocolDefinition, C extends RecordCodecMap>(): TypedEnbox<D, C> => (
      typed as unknown as TypedEnbox<D, C>
    ),
  });

  return { api, configure, hosted, processDwnRequest, sendDwnRequest };
}

describe('ProtocolReadinessApi', () => {
  it('should install, publish, verify, and accept an idempotent rerun', async () => {
    const fixture = createFixture();

    await fixture.api.ensureReady({ application: Application });
    await fixture.api.ensureReady({ application: Application });

    expect(fixture.configure.callCount).toBe(2);
    expect(callsFor(fixture.sendDwnRequest, DwnInterface.ProtocolsConfigure)).toHaveLength(2);
    expect(callsFor(fixture.sendDwnRequest, DwnInterface.ProtocolsQuery)).toHaveLength(2);
    for (const call of fixture.sendDwnRequest.getCalls()) {
      expect(call.args[0].remoteEndpointsOnly).toBe(true);
    }
  });

  it('should expose publication failures with their status and cause', async () => {
    const fixture = createFixture({ publishStatus: { code: 503, detail: 'Unavailable' } });
    const failure = await fixture.api.ensureReady({ application: Application })
      .catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(ProtocolReadinessError);
    expect(failure).toMatchObject({
      operation : 'publish',
      protocol  : NotesDefinition.protocol,
      status    : { code: 503, detail: 'Unavailable' },
      targetDid : OWNER_DID,
    });
    expect((failure as ProtocolReadinessError).cause).toBeInstanceOf(DwnResponseError);
  });

  it('should fail when an accepted publication is not active remotely', async () => {
    const fixture = createFixture({ retainPublishedDefinition: false });

    await expect(fixture.api.ensureReady({ application: Application })).rejects.toMatchObject({
      operation : 'publish',
      protocol  : NotesDefinition.protocol,
      targetDid : OWNER_DID,
    });
  });

  it('should configure delegates without publishing', async () => {
    const fixture = createFixture({ delegateDid: DELEGATE_DID });

    await fixture.api.ensureReady({ application: Application, targetDid: TARGET_DID });

    expect(fixture.configure.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.called).toBe(false);
    expect(fixture.sendDwnRequest.called).toBe(false);
  });

  it('should keep the local install and avoid storing an override target artifact', async () => {
    const fixture = createFixture();

    await fixture.api.ensureReady({ application: Application, targetDid: TARGET_DID });

    expect(fixture.configure.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.firstCall.args[0]).toMatchObject({
      author      : TARGET_DID,
      messageType : DwnInterface.ProtocolsConfigure,
      store       : false,
      target      : TARGET_DID,
    });
    expect(fixture.hosted.get(hostedKey(TARGET_DID, NotesDefinition.protocol))).toEqual(NotesDefinition);
  });
});
