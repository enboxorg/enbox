import type { BearerDid } from '@enbox/dids';
import type { DwnResponse } from '@enbox/agent';
import type { MessageSigner, ModuleDefinition, ModuleRuleSet, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { join } from 'node:path';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { tmpdir } from 'node:os';
import { AgentDwnApi, DwnInterface, EnboxUserAgent } from '@enbox/agent';
import { mkdtemp, rm } from 'node:fs/promises';

export type ModuleTestActor = {
  harness: PlatformAgentTestHarness;
  identity: BearerDid;
  did: string;
  signer: MessageSigner;
};

export type ModuleTestWrite = {
  actor: ModuleTestActor;
  definition: ModuleDefinition;
  path: string;
  data: Blob;
  parentContextId?: string;
  moduleRole?: string;
  squash?: true;
};

/** Separate private-key custody, real encrypted writes, and a shared multi-tenant DWN. */
export class ModuleTestWorld {
  public readonly actors: ModuleTestActor[];
  private readonly _directory: string;

  private constructor(directory: string, actors: ModuleTestActor[]) {
    this._directory = directory;
    this.actors = actors;
  }

  public get owner(): ModuleTestActor {
    return this.actors[0];
  }

  public static async create(definitions: readonly ModuleDefinition[], count = 4): Promise<ModuleTestWorld> {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-module-authority-'));
    const actors: ModuleTestActor[] = [];
    for (let index = 0; index < count; index++) {
      const harness = await PlatformAgentTestHarness.setup({
        agentClass       : EnboxUserAgent,
        agentStores      : 'memory',
        testDataLocation : join(directory, String(index)),
      });
      await harness.createAgentDid({ publish: false });
      const identity = (await harness.createIdentity({ name: `Participant ${index}`, publish: false })).did;
      const signer = await identity.getSigner();
      actors.push({
        harness,
        identity,
        did    : identity.uri,
        signer : { algorithm: signer.algorithm, keyId: signer.keyId, sign: (data): Promise<Uint8Array> => signer.sign({ data }) },
      });
    }
    const world = new ModuleTestWorld(directory, actors);
    for (const actor of actors) {
      for (const peer of actors) {
        const resolution = { didDocument: peer.identity.document, didDocumentMetadata: peer.identity.metadata, didResolutionMetadata: {} };
        await actor.harness.didResolverCache.set(peer.did, resolution);
        await actor.harness.agent.did.cacheResolution(peer.did, resolution);
      }
      if (actor !== world.owner) {
        actor.harness.agent.dwn = new AgentDwnApi({ agent: actor.harness.agent, dwn: world.owner.harness.agent.dwn.node });
      }
      for (const definition of definitions) {
        const result = await actor.harness.agent.dwn.processRequest({
          author        : actor.did,
          target        : actor.did,
          messageType   : DwnInterface.ModulesConfigure,
          messageParams : { definition },
        });
        if (result.reply.status.code !== 202) {
          throw new Error(result.reply.status.detail);
        }
      }
    }
    return world;
  }

  public async write({
    actor,
    definition,
    path,
    data,
    parentContextId,
    moduleRole,
    squash,
  }: ModuleTestWrite): Promise<DwnResponse<DwnInterface.RecordsWrite>> {
    const type = definition.types[path.split('/').at(-1)!];
    return actor.harness.agent.dwn.processRequest({
      author        : actor.did,
      target        : this.owner.did,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : definition.module,
        modulePath : path,
        schema     : type.schema,
        dataFormat : type.dataFormats![0],
        parentContextId,
        moduleRole,
        squash,
      },
      dataStream: data,
    });
  }

  public async assign(
    definition: ModuleDefinition,
    path: string,
    parentContextId: string,
    recipient: ModuleTestActor,
  ): Promise<RecordsWriteMessage> {
    const installed = await recipient.harness.agent.dwn.processRequest({
      author        : recipient.did,
      target        : recipient.did,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: definition.module } },
    });
    const configured = installed.reply.entries![0].descriptor.definition;
    const rule = path.split('/').reduce<ModuleRuleSet>((node, segment): ModuleRuleSet => node[segment] as ModuleRuleSet, configured.structure);
    const result = await this.owner.harness.agent.dwn.processRequest({
      author                 : this.owner.did,
      target                 : this.owner.did,
      messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : rule.$keyAgreement!.publicKeyJwk,
      messageParams          : {
        module     : definition.module,
        modulePath : path,
        schema     : definition.types[path.split('/').at(-1)!].schema,
        parentContextId,
        recipient  : recipient.did,
        dataFormat : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    if (result.reply.status.code !== 202 || result.audienceKeyDelivery?.delivered !== true) {
      throw new Error(`Role assignment failed: ${JSON.stringify({ status: result.reply.status, delivery: result.audienceKeyDelivery })}`);
    }
    return result.message!;
  }

  public async close(): Promise<void> {
    for (const actor of [...this.actors].reverse()) {
      await actor.harness.closeStorage();
    }
    await rm(this._directory, { recursive: true, force: true });
  }
}
