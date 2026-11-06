import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from '../src/record-codec.js';
import type { TypedEnbox } from '../src/typed-enbox.js';
import type { TypedModule } from '../src/module-types.js';
import type { DwnMessage, EnboxPlatformAgent } from '@enbox/agent';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { createModuleReadinessApi, ModuleReadinessError } from '../src/module-readiness.js';

const OWNER_DID = 'did:example:owner';
const DELEGATE_DID = 'did:example:delegate';
const TARGET_DID = 'did:example:target';

const NotesDefinition = {
  module    : 'https://example.com/modules/readiness-notes',
  published : true,
  types     : { note: { dataFormats: ['application/json'] } },
  structure : { note: {} },
} as const satisfies ModuleDefinition;

const NotesModule = defineModule(NotesDefinition, {
  note: recordCodecs.json<{ text: string }>(),
});
const Application = defineApplicationManifest({ modules: [NotesModule] });

type ConfigureMessage = DwnMessage[DwnInterface.ModulesConfigure];
type AgentRequest = {
  author: string;
  messageParams?: {
    definition?: ModuleDefinition;
    filter?: { module?: string };
  };
  messageType: DwnInterface;
  rawMessage?: ConfigureMessage;
  store?: boolean;
  target: string;
};

function messageFor(definition: ModuleDefinition): ConfigureMessage {
  return {
    authorization : { signature: 'owner-signature' },
    descriptor    : {
      definition,
      interface        : 'Modules',
      messageTimestamp : '2026-07-29T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as unknown as ConfigureMessage;
}

function hostedKey(target: string, module: string): string {
  return `${target}\u0000${module}`;
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
  api: ReturnType<typeof createModuleReadinessApi>;
  configure: sinon.SinonStub;
  hosted: Map<string, ModuleDefinition>;
  operations: string[];
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
} {
  const hosted = new Map<string, ModuleDefinition>();
  const operations: string[] = [];
  const processDwnRequest = sinon.stub().callsFake(async (request: AgentRequest): Promise<unknown> => ({
    message : messageFor(request.messageParams!.definition!),
    reply   : { status: { code: 202, detail: 'Accepted' } },
  }));
  const sendDwnRequest = sinon.stub().callsFake(async (request: AgentRequest): Promise<unknown> => {
    if (request.messageType === DwnInterface.ModulesQuery) {
      const module = request.messageParams!.filter!.module!;
      operations.push(`query:${module}`);
      const definition = hosted.get(hostedKey(request.target, module));
      return {
        reply: {
          entries : definition === undefined ? [] : [messageFor(definition)],
          status  : { code: 200, detail: 'OK' },
        },
      };
    }

    const definition = request.rawMessage!.descriptor.definition;
    operations.push(`publish:${definition.module}`);
    const key = hostedKey(request.target, definition.module);
    const status = options.publishStatus ?? (hosted.has(key)
      ? { code: 409, detail: 'Conflict' }
      : { code: 202, detail: 'Accepted' });
    if (options.retainPublishedDefinition !== false && (status.code < 300 || status.code === 409)) {
      hosted.set(key, definition);
    }
    return { reply: { status } };
  });
  const agent = { processDwnRequest, sendDwnRequest } as unknown as EnboxPlatformAgent;
  const configure = sinon.stub().callsFake(async (moduleArtifact: TypedModule): Promise<unknown> => {
    operations.push(`install:${moduleArtifact.definition.module}`);
    return {
      module: {
        definition : moduleArtifact.definition,
        toJSON     : (): ConfigureMessage => messageFor(moduleArtifact.definition),
      },
      status: { code: 200, detail: 'OK' },
    };
  });
  const api = createModuleReadinessApi({
    agent,
    connectedDid : OWNER_DID,
    delegateDid  : options.delegateDid,
    using        : <D extends ModuleDefinition, C extends RecordCodecMap>(moduleArtifact: TypedModule<D, C>): TypedEnbox<D, C> => ({
      configure  : (): Promise<unknown> => configure(moduleArtifact),
      definition : moduleArtifact.definition,
      module     : moduleArtifact.definition.module,
    } as unknown as TypedEnbox<D, C>),
  });

  return { api, configure, hosted, operations, processDwnRequest, sendDwnRequest };
}

describe('ModuleReadinessApi', () => {
  it('should complete each manifest entry before installing the next entry', async () => {
    const otherModule = defineModule({ ...NotesDefinition, module: 'https://example.com/modules/readiness-other' }, NotesModule.codecs);
    const application = defineApplicationManifest({ modules: [NotesModule, otherModule] });
    const fixture = createFixture();

    await fixture.api.ensureReady({ application });

    expect(fixture.operations).toEqual([
      `install:${NotesDefinition.module}`, `publish:${NotesDefinition.module}`, `query:${NotesDefinition.module}`,
      `install:${otherModule.definition.module}`, `publish:${otherModule.definition.module}`, `query:${otherModule.definition.module}`,
    ]);
  });

  it('should stop later manifest writes when an earlier publication fails', async () => {
    const otherModule = defineModule({ ...NotesDefinition, module: 'https://example.com/modules/readiness-other' }, NotesModule.codecs);
    const application = defineApplicationManifest({ modules: [NotesModule, otherModule] });
    const fixture = createFixture({ publishStatus: { code: 503, detail: 'Unavailable' } });

    await expect(fixture.api.ensureReady({ application })).rejects.toMatchObject({ operation: 'publish', module: NotesDefinition.module });

    expect(fixture.operations).toEqual([`install:${NotesDefinition.module}`, `publish:${NotesDefinition.module}`]);
    expect(fixture.configure.callCount).toBe(1);
  });

  it('should install, publish, verify, and accept an idempotent rerun', async () => {
    const fixture = createFixture();

    await fixture.api.ensureReady({ application: Application });
    await fixture.api.ensureReady({ application: Application });

    expect(fixture.configure.callCount).toBe(2);
    expect(callsFor(fixture.sendDwnRequest, DwnInterface.ModulesConfigure)).toHaveLength(2);
    expect(callsFor(fixture.sendDwnRequest, DwnInterface.ModulesQuery)).toHaveLength(2);
  });

  it('should support local owner readiness without hosted publication', async () => {
    const fixture = createFixture();

    await fixture.api.ensureReady({ application: Application, publish: false, targetDid: TARGET_DID });

    expect(fixture.configure.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.called).toBe(false);
    expect(fixture.sendDwnRequest.called).toBe(false);

    fixture.configure.resolves({ status: { code: 500, detail: 'Install failed' } });
    const failure = await fixture.api.ensureReady({ application: Application, publish: false })
      .catch((error: unknown): unknown => error);
    expect(failure).toMatchObject({ operation: 'install', targetDid: OWNER_DID });
  });

  it('should expose publication failures with their status and cause', async () => {
    const fixture = createFixture({ publishStatus: { code: 503, detail: 'Unavailable' } });
    const failure = await fixture.api.ensureReady({ application: Application })
      .catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(ModuleReadinessError);
    expect(failure).toMatchObject({
      operation : 'publish',
      module    : NotesDefinition.module,
      status    : { code: 503, detail: 'Unavailable' },
      targetDid : OWNER_DID,
    });
    expect((failure as ModuleReadinessError).cause).toBeInstanceOf(DwnResponseError);
  });

  it('should fail when a 409 leaves a different definition active remotely', async () => {
    const fixture = createFixture({
      publishStatus             : { code: 409, detail: 'Conflict' },
      retainPublishedDefinition : false,
    });
    fixture.hosted.set(hostedKey(OWNER_DID, NotesDefinition.module), {
      ...NotesDefinition,
      published: false,
    });

    await expect(fixture.api.ensureReady({ application: Application })).rejects.toMatchObject({
      operation : 'publish',
      module    : NotesDefinition.module,
      targetDid : OWNER_DID,
    });
  });

  it('should configure delegates without publishing and normalize failures', async () => {
    const fixture = createFixture({ delegateDid: DELEGATE_DID });

    await fixture.api.ensureReady({ application: Application, targetDid: TARGET_DID });

    expect(fixture.configure.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.called).toBe(false);
    expect(fixture.sendDwnRequest.called).toBe(false);

    const cause = new DwnResponseError('Import wallet module', { code: 401, detail: 'Unauthorized' });
    fixture.configure.rejects(cause);
    const failure = await fixture.api.ensureReady({ application: Application })
      .catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(ModuleReadinessError);
    expect(failure).toMatchObject({
      cause,
      operation : 'install',
      module    : NotesDefinition.module,
      status    : cause.status,
      targetDid : OWNER_DID,
    });
  });

  it('should keep the local install and avoid storing an override target artifact', async () => {
    const fixture = createFixture();

    await fixture.api.ensureReady({ application: Application, targetDid: TARGET_DID });

    expect(fixture.configure.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.calledOnce).toBe(true);
    expect(fixture.processDwnRequest.firstCall.args[0]).toMatchObject({
      author      : TARGET_DID,
      messageType : DwnInterface.ModulesConfigure,
      store       : false,
      target      : TARGET_DID,
    });
    expect(fixture.hosted.get(hostedKey(TARGET_DID, NotesDefinition.module))).toEqual(NotesDefinition);
  });
});
