import type { ConnectModulePreparationPlan } from '../src/connect-module-preparation.js';
import type { ConnectPermissionRequest } from '@enbox/connect';
import type { ModuleDefinition, ModulesConfigureMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { DidJwk } from '@enbox/dids';
import { ModulesConfigure } from '@enbox/dwn-sdk-js';
import { X25519 } from '@enbox/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { resolveConnectModulePreparationPlan } from '../src/connect-module-preparation.js';
import { TestAgent } from './utils/test-agent.js';
import { ConnectCeremony, executeConnectApproval } from '../src/connect-approval.js';
import { DwnInterface, DwnPermissionGrant } from '../src/types/dwn.js';

const core: ModuleDefinition = {
  module    : 'https://example.com/connect-composition/core', published : false,
  types     : { note: { dataFormats: ['application/json'] }, member: {} },
  structure : { note: {}, member: { $role: true } },
};
const consumer: ModuleDefinition = {
  module    : 'https://example.com/connect-composition/comments', published : false,
  uses      : { core: core.module }, types     : { comment: { dataFormats: ['application/json'], encryptionRequired: true } },
  structure : { note: { $ref: 'core:note', comment: { $actions: [{ role: 'core:member', can: ['read', 'create'] }] } } },
};

function requests(provider = core): ConnectPermissionRequest[] {
  return [
    { moduleDefinition: provider, permissionScopes: [] },
    { moduleDefinition: consumer, permissionScopes: [{ module: consumer.module, interface: 'Records', method: 'Read' }] },
  ];
}

function updatedCore(): ModuleDefinition {
  const definition = structuredClone(core);
  definition.types.extra = {};
  definition.structure.extra = {};
  return definition;
}

describe('connect module composition preflight', () => {
  let harness: PlatformAgentTestHarness;
  let ownerDid: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({ agentClass: TestAgent, agentStores: 'memory' });
  });

  beforeEach(async () => {
    await harness.clearStorage();
    await harness.createAgentDid({ publish: false });
    ownerDid = harness.agent.agentDid.uri;
    await harness.agent.did.cacheResolution(ownerDid, {
      didDocument: harness.agent.agentDid.document, didDocumentMetadata: harness.agent.agentDid.metadata, didResolutionMetadata: {},
    });
  });

  afterEach(() => sinon.restore());
  afterAll(async () => harness.closeStorage());

  async function install(definition: ModuleDefinition): Promise<ModulesConfigureMessage> {
    const response = await harness.agent.processDwnRequest({
      author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
    });
    expect(response.reply.status.code).toBe(202);
    return response.message!;
  }

  async function plan(
    permissionRequests = requests(), approvedModuleOverrides: ReadonlySet<string> = new Set(),
  ): Promise<ConnectModulePreparationPlan> {
    return resolveConnectModulePreparationPlan({ agent: harness.agent, ownerDid, permissionRequests, approvedModuleOverrides });
  }

  it.each([
    ['mixed wrapper', { ...requests()[1], protocolDefinition: consumer }],
    ['mixed definition', { ...requests()[1], moduleDefinition: { ...consumer, protocol: consumer.module } }],
    ['mixed scope', {
      ...requests()[1], permissionScopes: [{ module: consumer.module, protocol: consumer.module, interface: 'Records', method: 'Read' }],
    }],
    ['old interface', { ...requests()[1], permissionScopes: [{ module: consumer.module, interface: 'Protocols', method: 'Configure' }] }],
  ] as const)('rejects %s at the direct approval boundary before any mutation', async (_name, invalid) => {
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    const grants = sinon.spy(ConnectCeremony, 'createPermissionGrants');
    const delegate = sinon.spy(DidJwk, 'create');
    await expect(executeConnectApproval({
      agent       : harness.agent, providerDid : ownerDid, transport   : 'relay',
      request     : { appName: 'Comments', permissionRequests: [invalid] as ConnectPermissionRequest[] },
    })).rejects.toThrow();
    expect(process.called).toBe(false);
    expect(grants.called).toBe(false);
    expect(delegate.called).toBe(false);
  });

  it('installs a missing plaintext role provider before its encrypted consumer', async () => {
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    sinon.stub(harness.agent.dwn, 'getRemoteDwnEndpointUrls').resolves(['https://in-process.example']);
    const rpc = createLocalDwnRpc(harness.agent.dwn.node);
    sinon.stub(harness.agent.rpc, 'sendDwnRequest').callsFake(rpc.sendDwnRequest.bind(rpc));
    await executeConnectApproval({
      agent       : harness.agent, providerDid : ownerDid, transport   : 'relay',
      request     : { appName: 'Comments', permissionRequests: requests() },
    });
    const configures = process.getCalls().filter(call => call.args[0].messageType === DwnInterface.ModulesConfigure);
    expect(configures.map(call => call.args[0].messageParams.definition.module)).toEqual([core.module, consumer.module]);
    const installed = await harness.agent.processDwnRequest({
      author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module: core.module } },
    });
    expect(installed.reply.entries![0].descriptor.definition.structure.member.$keyAgreement).toBeDefined();
  });

  it('reuses the exact owner provider and issues only explicitly requested grants', async () => {
    const installed = await install(updatedCore());
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    sinon.stub(harness.agent.dwn, 'getRemoteDwnEndpointUrls').resolves(['https://in-process.example']);
    const rpc = createLocalDwnRpc(harness.agent.dwn.node);
    sinon.stub(harness.agent.rpc, 'sendDwnRequest').callsFake(rpc.sendDwnRequest.bind(rpc));

    const result = await executeConnectApproval({
      agent                   : harness.agent, providerDid             : ownerDid, transport               : 'relay',
      approvedModuleOverrides : [core.module], request                 : { appName: 'Comments', permissionRequests: requests() },
    });

    const configures = process.getCalls().filter(call => call.args[0].messageType === DwnInterface.ModulesConfigure);
    expect(configures.map(call => call.args[0].messageParams.definition.module)).toEqual([consumer.module]);
    const grants = result.delegateGrants.map(message => DwnPermissionGrant.parse(message));
    expect(grants.some(grant => grant.scope.module === core.module)).toBe(false);
    expect(grants.filter(grant => grant.scope.module === consumer.module)).toHaveLength(1);
    const current = await harness.agent.processDwnRequest({
      author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module: core.module } },
    });
    expect(current.reply.entries![0]).toEqual(installed);
  });

  it('rejects incompatible consumer imports before any configurations or grants are written', async () => {
    const changed = updatedCore();
    changed.types.note.dataFormats = ['text/plain'];
    await install(changed);
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    await expect(executeConnectApproval({
      agent                   : harness.agent, providerDid             : ownerDid, transport               : 'relay',
      approvedModuleOverrides : [core.module], request                 : { appName: 'Comments', permissionRequests: requests() },
    })).rejects.toThrow('IncompatibleContractUpdate');
    expect(process.getCalls().every(call => call.args[0].messageType === DwnInterface.ModulesQuery)).toBe(true);
  });

  it('preserves explicit provider policies and their owner override requirement', async () => {
    await install(updatedCore());
    const explicit = requests();
    explicit[0].permissionScopes.push({ module: core.module, interface: 'Records', method: 'Read' });
    await expect(plan(explicit)).rejects.toThrow('different definition');
    const selected = await plan(explicit, new Set([core.module]));
    expect(selected.inferredProviderUris.has(core.module)).toBe(false);
    expect(selected.permissionRequests[0]).toEqual(explicit[0]);
  });

  it('checks a missing intermediate provider own imported contracts before installing it', async () => {
    const changed = updatedCore();
    changed.types.note.dataFormats = ['text/plain'];
    await install(changed);
    const intermediate: ModuleDefinition = {
      module    : 'https://example.com/connect-composition/intermediate', published : false, uses      : { core: core.module },
      types     : { child: {}, exported: {} }, structure : { note: { $ref: 'core:note', child: {} }, exported: {} },
    };
    const root: ModuleDefinition = {
      module    : 'https://example.com/connect-composition/root', published : false, uses      : { intermediate: intermediate.module },
      types     : { reply: {} }, structure : { exported: { $ref: 'intermediate:exported', reply: {} } },
    };
    await expect(plan([
      { moduleDefinition: core, permissionScopes: [] },
      { moduleDefinition: intermediate, permissionScopes: [] },
      { moduleDefinition: root, permissionScopes: [{ module: root.module, interface: 'Records', method: 'Read' }] },
    ])).rejects.toThrow('IncompatibleContractUpdate');
  });

  it('resolves actual installed dependencies and omits obsolete inferred packages', async () => {
    const obsolete: ModuleDefinition = {
      module: 'https://example.com/connect-composition/obsolete', published: false, types: { item: {} }, structure: { item: {} },
    };
    const current = { ...obsolete, module: 'https://example.com/connect-composition/current' };
    await install(current);
    await install({ ...updatedCore(), uses: { current: current.module } });
    const packaged = { ...core, uses: { obsolete: obsolete.module } };
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    const selected = await plan([{ moduleDefinition: obsolete, permissionScopes: [] }, ...requests(packaged)]);
    expect(selected.permissionRequests.map(request => request.moduleDefinition.module)).toEqual([core.module, consumer.module]);
    expect(selected.permissionRequests[0].moduleDefinition.uses).toEqual({ current: current.module });
    expect(process.getCalls().some(call => call.args[0].messageParams.filter?.module === current.module)).toBe(true);
    expect(process.getCalls().some(call => call.args[0].messageParams.filter?.module === obsolete.module)).toBe(false);
  });

  it('rejects installed provider keys from another owner even when an override was approved', async () => {
    const foreignPrivateKey = await X25519.generateKey();
    const publicKeyJwk = await X25519.getPublicKey({ key: foreignPrivateKey });
    const wrongKeys = updatedCore();
    wrongKeys.$keyAgreement = { publicKeyJwk };
    for (const node of Object.values(wrongKeys.structure)) {
      node.$keyAgreement = { publicKeyJwk };
    }
    const signer = await harness.agent.agentDid.getSigner();
    const configuration = await ModulesConfigure.create({
      definition : wrongKeys,
      signer     : { algorithm: signer.algorithm, keyId: signer.keyId, sign: async (data): Promise<Uint8Array> => signer.sign({ data }) },
    });
    expect((await harness.agent.dwn.processRawMessage(ownerDid, configuration.message)).status.code).toBe(202);
    await expect(plan(requests(), new Set([core.module]))).rejects.toThrow('keys that do not match this wallet owner');
  });

  it('rejects requester-owned keys instead of hiding them when selecting the installed provider', async () => {
    const installed = await install(updatedCore());
    await expect(plan(requests(installed.descriptor.definition))).rejects.toThrow('wallet-managed encryption keys');
  });
});
