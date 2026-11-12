import type {
  ModuleDefinition,
  ModulesConfigureMessage,
  RecordsDeleteMessage,
  RecordsReadMessage,
  RecordsReadReplicationSupportEntry,
  RecordsReadReply,
  RecordsWriteMessage,
  ResolvedModuleGraph,
  ResolvedRoleReference,
  RoleRecordIdentity,
} from '@enbox/dwn-sdk-js';

import type { DwnDataEncodedRecordsWriteMessage } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncRemoteRequestRunner } from './sync-request-runner.js';

import {
  DwnConstant,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  getRecordsWriteRoleIdentity,
  getRoleAudienceContextId,
  getRoleRecordIdentity,
  Message,
  Records,
  RecordsWrite,
  resolveModuleGraph,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isEncryptionControlRecordFor } from './dwn-encryption.js';
import { isTenantModuleConfig } from './sync-fetch-helpers.js';
import { runSyncRemoteRequest } from './sync-request-runner.js';
import { verifyRemoteDwnResponse } from './remote-dwn-response.js';
import { dataStreamFromBytes, SyncWorkInterruptedError } from './sync-messages.js';
import { getRecordAuthor, getRecordModuleRole, resolveDwnSubscriptionUrl as resolveDwnWebSocketUrl } from './utils.js';

/** A role-authorized read, its current module definition, and its local-replication prerequisites. */
export type RoleReplicationSupportBatch = {
  dependencies: SyncMessageEntry[];
  resolvedGraph: ResolvedModuleGraph;
  moduleDefinition: ModuleDefinition;
  roleRecordId: string;
  root: SyncMessageEntry;
  rootCid: string;
};

type DelegatedRoleReadParams = {
  actorDid: string;
  delegateDid?: string;
  permissionsApi: PermissionsApi;
  module: string;
};

type RoleReplicationSupportParams = DelegatedRoleReadParams & {
  agent: EnboxPlatformAgent;
  contextId: string;
  dwnUrl: string;
  expectedRoot?: RecordsDeleteMessage | RecordsWriteMessage;
  modulePath: string;
  moduleRole: string;
  rootData?: Uint8Array;
  runRemoteRequest?: SyncRemoteRequestRunner;
  shouldContinue?: () => boolean;
  sourceDid: string;
  /** Read an already admitted replica through the same actor/role authorization boundary. */
  isLocal?: boolean;
};

type ExactRoleReadFilter = {
  contextId: string;
  module: string;
  modulePath: string;
  recordId: string;
};

type SupportValidationParams = {
  actorDid: string;
  contextId: string;
  module: string;
  modulePath: string;
  moduleRole: string;
  replyRoleId: string | undefined;
  root: RecordsWriteMessage;
  rootDelete: RecordsDeleteMessage | undefined;
  rootInitialWrite: RecordsWriteMessage | undefined;
  sourceDid: string;
  support: readonly RecordsReadReplicationSupportEntry[];
};

type ResolvedSupportValidationParams = SupportValidationParams & {
  graph: ResolvedModuleGraph;
  graphsByModule: Map<string, ResolvedModuleGraph>;
  resolvedRole: ResolvedRoleReference;
  roleIdentity: RoleRecordIdentity;
};

type ExpectedAncestor = { contextId: string; module: string; modulePath: string };

type SupportScan = {
  audienceKeyIds: Set<string>;
  currentModuleConfigure?: ModulesConfigureMessage;
  currentModuleConfigureMatches: number;
  deliveredKeyIds: Set<string>;
  role?: RecordsWriteMessage;
};

/** The role is valid, but its audience key material is not ready for this member. */
export class FollowedSourceNotReadyError extends Error {
  public constructor(detail: string) {
    super(`Followed source is not ready: ${detail}`);
    this.name = 'FollowedSourceNotReadyError';
  }
}

/** Every matching role record is absent from one verified remote response. */
export class FollowedSourceRoleAbsentError extends Error {
  public constructor(detail: string) {
    super(`Followed source role is absent: ${detail}`);
    this.name = 'FollowedSourceRoleAbsentError';
  }
}

/** The remote DWN returned an unusable replication-support closure. */
export class RoleReplicationSupportError extends Error {
  public constructor(detail: string) {
    super(`Role replication support is invalid: ${detail}`);
    this.name = 'RoleReplicationSupportError';
  }
}

/**
 * Reads one exact record as a role holder and converts the returned closure to
 * the sync engine's existing admission entries. The response's unsigned role
 * ID is accepted only when it names the signed role record in the closure.
 */
export async function readRoleReplicationSupport(
  params: RoleReplicationSupportParams,
): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);
  const recordId = params.contextId.split('/').at(-1);
  if (recordId === undefined || recordId.length === 0) {
    throw new TypeError('Role replication support requires an exact context ID.');
  }
  const { modulePath } = params;

  const delegatedGrant = await resolveDelegatedRoleReadGrant(params, params.contextId, modulePath);

  const filter: ExactRoleReadFilter = {
    contextId : params.contextId,
    module    : params.module,
    modulePath,
    recordId,
  };
  const message = await createRoleReplicationSupportReadMessage(params, filter, delegatedGrant, true);

  assertCurrent(params.shouldContinue);
  const reply = await requestRoleReplicationSupport(params, filter, delegatedGrant, message);
  const responseData = reply.entry?.data;
  try {
    return await consumeRoleReplicationSupportReply(params, filter, message, reply);
  } catch (error: unknown) {
    await responseData?.cancel().catch((): void => {});
    throw error;
  }
}

async function createRoleReplicationSupportReadMessage(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  delegatedGrant: DwnDataEncodedRecordsWriteMessage | undefined,
  includeReplicationSupport: boolean,
): Promise<RecordsReadMessage> {
  const { message } = await params.agent.dwn.processRequest({
    author        : params.actorDid,
    granteeDid    : params.delegateDid,
    messageParams : {
      filter,
      includeReplicationSupport,
      moduleRole: params.moduleRole,
      ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
    },
    messageType : DwnInterface.RecordsRead,
    store       : false,
    target      : params.sourceDid,
  });
  if (message === undefined) {
    throw new Error('Role replication support read did not produce a signed request.');
  }
  return message;
}

async function requestRoleReplicationSupport(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  delegatedGrant: DwnDataEncodedRecordsWriteMessage | undefined,
  message: RecordsReadMessage,
): Promise<RecordsReadReply> {
  const requestDwnUrl = params.isLocal === true ? params.dwnUrl : await resolveRoleReadUrl(params);
  if (params.rootData !== undefined) {
    const reply = await sendRecordsRead(params, requestDwnUrl, message);
    if (reply.status.code === 200 && reply.entry !== undefined) {
      await reply.entry.data?.cancel().catch((): void => {});
      reply.entry.data = dataStreamFromBytes(params.rootData);
    }
    return reply;
  }
  if (isRecordsDeleteMessage(params.expectedRoot)) {
    return sendRecordsRead(params, requestDwnUrl, message);
  }
  const dataMessage = await createRoleReplicationSupportReadMessage(params, filter, delegatedGrant, false);
  const [supportResult, dataResult] = await Promise.allSettled([
    sendRecordsRead(params, requestDwnUrl, message),
    sendRecordsRead(params, params.dwnUrl, dataMessage),
  ]);
  return mergeSplitRoleReadReplies(supportResult, dataResult);
}

async function resolveRoleReadUrl(params: RoleReplicationSupportParams): Promise<string> {
  if (params.runRemoteRequest !== undefined) {
    return params.dwnUrl;
  }
  try {
    return await resolveDwnWebSocketUrl(params.dwnUrl, params.agent.rpc);
  } catch {
    return params.dwnUrl;
  }
}

function sendRecordsRead(
  params: RoleReplicationSupportParams,
  dwnUrl: string,
  message: RecordsReadMessage,
): Promise<RecordsReadReply> {
  if (params.isLocal === true) {
    return params.agent.dwn.processRequest({
      author: params.actorDid, target: params.sourceDid, messageType: DwnInterface.RecordsRead, rawMessage: message,
    }).then(result => result.reply);
  }
  return runSyncRemoteRequest(params.runRemoteRequest, (signal): Promise<RecordsReadReply> =>
    params.agent.rpc.sendDwnRequest({
      dwnUrl,
      message,
      targetDid: params.sourceDid,
      ...(signal === undefined ? {} : { signal }),
    }) as Promise<RecordsReadReply>
  );
}

async function mergeSplitRoleReadReplies(
  supportResult: PromiseSettledResult<RecordsReadReply>,
  dataResult: PromiseSettledResult<RecordsReadReply>,
): Promise<RecordsReadReply> {
  if (supportResult.status === 'rejected') {
    if (dataResult.status === 'fulfilled') {
      await dataResult.value.entry?.data?.cancel().catch((): void => {});
    }
    throw supportResult.reason;
  }
  if (dataResult.status === 'rejected') {
    await supportResult.value.entry?.data?.cancel().catch((): void => {});
    throw dataResult.reason;
  }

  const supportReply = supportResult.value;
  const dataReply = dataResult.value;
  const data = dataReply.entry?.data;
  if (
    supportReply.status.code === 200 &&
    supportReply.entry !== undefined &&
    dataReply.status.code === 200 &&
    data !== undefined
  ) {
    if (supportReply.entry.data !== data) {
      await supportReply.entry.data?.cancel().catch((): void => {});
    }
    supportReply.entry.data = data;
  } else {
    await data?.cancel().catch((): void => {});
  }
  return supportReply;
}

async function consumeRoleReplicationSupportReply(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  message: RecordsReadMessage,
  reply: RecordsReadReply,
): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);
  const expectsDelete = isRecordsDeleteMessage(params.expectedRoot);
  assertSuccessfulRoleReplicationSupport(reply, expectsDelete);

  const rootMessage = expectsDelete ? reply.entry?.recordsDelete : reply.entry?.recordsWrite;
  const rootWrite = expectsDelete ? reply.entry?.initialWrite : reply.entry?.recordsWrite;
  const rootData = reply.entry?.data;
  if (rootMessage === undefined || rootWrite === undefined || (!expectsDelete && rootData === undefined)) {
    throw new RoleReplicationSupportError('the response did not contain a readable root record.');
  }
  assertRoot(rootWrite, filter);

  const rootCid = await Message.getCid(rootMessage);
  if (params.expectedRoot !== undefined) {
    const expectedRootCid = await Message.getCid(params.expectedRoot);
    if (rootCid !== expectedRootCid) {
      throw new RoleReplicationSupportError(`root CID '${rootCid}' does not match '${expectedRootCid}'.`);
    }
  }

  const support = reply.support ?? [];
  const { moduleDefinition, roleRecordId, resolvedGraph } = await validateSupport({
    actorDid         : params.actorDid,
    contextId        : params.contextId,
    module           : params.module,
    modulePath       : params.modulePath,
    moduleRole       : params.moduleRole,
    replyRoleId      : reply.roleRecordId,
    root             : rootWrite,
    rootDelete       : expectsDelete ? rootMessage as RecordsDeleteMessage : undefined,
    rootInitialWrite : reply.entry?.initialWrite,
    sourceDid        : params.sourceDid,
    support,
  });
  const dependencies = await collectSupportDependencies(reply, support, rootCid);

  await verifyRemoteDwnResponse({
    didResolver : params.agent.did,
    message,
    reply,
    targetDid   : params.sourceDid,
  });
  const verifiedRootData = reply.entry?.data;
  if (!expectsDelete && verifiedRootData === undefined) {
    throw new RoleReplicationSupportError('the verified response omitted the root record data.');
  }

  return {
    dependencies,
    resolvedGraph,
    moduleDefinition,
    roleRecordId,
    root: {
      message: rootMessage,
      ...(verifiedRootData === undefined
        ? {}
        : { dataStream: verifiedRootData }),
      isLatestBaseState: true,
    },
    rootCid,
  };
}

function assertSuccessfulRoleReplicationSupport(reply: RecordsReadReply, expectsDelete: boolean): void {
  if (reply.status.code === 200 || (expectsDelete && reply.status.code === 404)) {
    return;
  }
  const detail = reply.status.detail ?? 'Unknown error';
  const missingRole = DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound;
  if (reply.status.code === 401 && (detail === missingRole || detail.startsWith(`${missingRole}:`))) {
    throw new FollowedSourceRoleAbsentError(detail);
  }
  const unsupported = DwnErrorCode.RecordsReadReplicationSupportUnsupported;
  if (reply.status.code === 400 && (detail === unsupported || detail.startsWith(`${unsupported}:`))) {
    throw new RoleReplicationSupportError(detail);
  }
  throw new Error(`Role replication support read failed (${reply.status.code}): ${detail}`);
}

async function collectSupportDependencies(
  reply: RecordsReadReply,
  support: readonly RecordsReadReplicationSupportEntry[],
  rootCid: string,
): Promise<SyncMessageEntry[]> {
  const entries: SyncMessageEntry[] = [];
  if (reply.entry?.initialWrite !== undefined) {
    entries.push({ message: reply.entry.initialWrite, isLatestBaseState: false });
  }
  for (const entry of support) {
    entries.push(toSyncEntry(entry));
  }
  const cids = await Promise.all(entries.map(entry => Message.getCid(entry.message)));
  const dependencies = new Map<string, SyncMessageEntry>();
  for (let index = 0; index < entries.length; index++) {
    const cid = cids[index]!;
    if (cid !== rootCid) {
      dependencies.set(cid, entries[index]!);
    }
  }
  return [...dependencies.values()];
}

function assertRoot(
  root: RecordsWriteMessage,
  expected: ExactRoleReadFilter,
): void {
  if (
    root.recordId !== expected.recordId ||
    root.contextId !== expected.contextId ||
    root.descriptor.module !== expected.module ||
    root.descriptor.modulePath !== expected.modulePath
  ) {
    throw new RoleReplicationSupportError('the response root does not match the exact requested context record.');
  }
}

/** Collect tenant-owned current definitions, rejecting malformed historical entries and duplicate current versions. */
function collectCurrentModuleDefinitions(
  sourceDid: string,
  support: readonly RecordsReadReplicationSupportEntry[],
): ReadonlyMap<string, ModuleDefinition> {
  const currentDefinitions = new Map<string, ModuleDefinition>();
  for (const entry of support) {
    const message = entry.message as ModulesConfigureMessage;
    if (message.descriptor.interface !== DwnInterfaceName.Modules || message.descriptor.method !== DwnMethodName.Configure) {
      continue;
    }
    const definition = message.descriptor.definition;
    if (!isTenantModuleConfig(sourceDid, definition.module)(message) ||
        typeof entry.isLatestBaseState !== 'boolean' || entry.encodedData !== undefined) {
      throw unsupportedEntry(entry);
    }
    if (!entry.isLatestBaseState) {
      continue;
    }
    if (currentDefinitions.has(definition.module)) {
      throw new RoleReplicationSupportError(`the response must contain exactly one current module configuration for '${definition.module}'.`);
    }
    currentDefinitions.set(definition.module, definition);
  }
  return currentDefinitions;
}

async function validateSupport(
  params: SupportValidationParams,
): Promise<{ moduleDefinition: ModuleDefinition; roleRecordId: string; resolvedGraph: ResolvedModuleGraph }> {
  const currentDefinitions = collectCurrentModuleDefinitions(params.sourceDid, params.support);
  const definition = currentDefinitions.get(params.module);
  if (definition === undefined) {
    throw new RoleReplicationSupportError('the response must contain exactly one current module configuration.');
  }
  const graph = resolveModuleGraph(definition, uri => currentDefinitions.get(uri));
  const rootNode = graph.nodesByDeclaredPath.get(params.modulePath);
  if (rootNode === undefined || rootNode.kind !== 'record') {
    throw new RoleReplicationSupportError('the requested root is not a concrete module record.');
  }
  const contextSegments = params.contextId.split('/');
  if (contextSegments.length !== rootNode.physicalDepth) {
    throw new RoleReplicationSupportError('the requested context does not match its physical module ancestry.');
  }
  const ancestorIds = new Map<string, ExpectedAncestor>(rootNode.physicalAncestors.map((ancestor, index) => [
    contextSegments[index],
    {
      contextId  : contextSegments.slice(0, index + 1).join('/'),
      module     : ancestor.owningModuleUri,
      modulePath : ancestor.owningModulePath,
    },
  ]));
  const resolvedRole = graph.resolveInvokedRole(params.moduleRole);
  const resolvedParams: ResolvedSupportValidationParams = {
    ...params,
    graph,
    graphsByModule : new Map([[graph.rootModuleUri, graph]]),
    resolvedRole,
    roleIdentity   : getRoleRecordIdentity({ role: resolvedRole, contextId: params.contextId, recipient: params.actorDid }),
  };
  const audienceContextId = getRoleAudienceContextId(resolvedRole, params.contextId);
  const wrappedKeyIds = new Set(params.root.encryption?.keyEncryption
    .filter(entry => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
      'module' in entry && entry.module === resolvedRole.owningModuleUri && entry.rolePath === resolvedRole.owningModulePath)
    .map(entry => entry.keyId) ?? []);
  const authorRoles = expectedAuthorRoleProofs(resolvedParams, ancestorIds);
  const scan = await scanSupport(resolvedParams, ancestorIds, audienceContextId, authorRoles);

  if (params.replyRoleId === undefined) {
    throw new RoleReplicationSupportError('the response did not identify its active role record.');
  }
  if (scan.role === undefined) {
    throw new RoleReplicationSupportError(`role '${params.replyRoleId}' has no signed active assignment.`);
  }
  if (scan.currentModuleConfigure === undefined || scan.currentModuleConfigureMatches !== 1) {
    throw new RoleReplicationSupportError('the response must contain exactly one current module configuration.');
  }

  assertRoleAudienceReady(resolvedParams, wrappedKeyIds, scan);
  return {
    resolvedGraph    : graph,
    moduleDefinition : scan.currentModuleConfigure.descriptor.definition,
    roleRecordId     : params.replyRoleId,
  };
}

async function scanSupport(
  params: ResolvedSupportValidationParams,
  ancestorIds: ReadonlyMap<string, ExpectedAncestor>,
  audienceContextId: string | undefined,
  authorRoles: ReadonlySet<string>,
): Promise<SupportScan> {
  const scan: SupportScan = {
    audienceKeyIds                : new Set(),
    currentModuleConfigureMatches : 0,
    deliveredKeyIds               : new Set(),
  };


  for (const entry of params.support) {
    const definition = (entry.message as ModulesConfigureMessage).descriptor.definition;
    if (definition !== undefined && params.graph.definitionsByUri.has(definition.module) &&
        isTenantModuleConfig(params.sourceDid, definition.module)(entry.message)) {
      if (typeof entry.isLatestBaseState !== 'boolean' || entry.encodedData !== undefined) {
        throw unsupportedEntry(entry);
      }
      if (entry.isLatestBaseState === true && definition.module === params.module) {
        scan.currentModuleConfigure = entry.message;
        scan.currentModuleConfigureMatches++;
      }
      continue;
    }
    if (!Records.isRecordsWrite(entry.message)) {
      throw unsupportedEntry(entry);
    }
    await scanRecordsWriteSupport(scan, params, entry, entry.message, ancestorIds, audienceContextId, authorRoles);
  }
  return scan;
}

async function scanRecordsWriteSupport(
  scan: SupportScan,
  params: ResolvedSupportValidationParams,
  entry: RecordsReadReplicationSupportEntry,
  message: RecordsWriteMessage,
  ancestorIds: ReadonlyMap<string, ExpectedAncestor>,
  audienceContextId: string | undefined,
  authorRoles: ReadonlySet<string>,
): Promise<void> {
  const isAncestor = isExpectedAncestor(entry, message, ancestorIds);
  const identity = getRecordsWriteRoleIdentity(message);
  const isRoleVersion = message.recordId === params.replyRoleId && identity?.key === params.roleIdentity.key;
  const isAuthorCandidate = identity !== undefined && authorRoles.has(identity.key);
  const isInitialCandidate = (isRoleVersion || isAuthorCandidate) &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined &&
    await RecordsWrite.isInitialWrite(message);
  const isRole = isRoleVersion &&
    entry.isLatestBaseState === true &&
    typeof entry.encodedData === 'string';
  const isInitialRole = isRoleVersion && isInitialCandidate;
  const isAuthorRole = isAuthorCandidate && isInitialCandidate;
  const isRoleAudience = isTaggedEncryptionControl(
    message,
    ENCRYPTION_CONTROL_AUDIENCE_PATH,
    params.resolvedRole.owningModuleUri,
    params.resolvedRole.owningModulePath,
    audienceContextId,
  );
  const isAudience = isRoleAudience || isRootAudienceControl(message, params);
  const isUsableAudience = isAudience &&
    entry.isLatestBaseState === true && typeof entry.encodedData === 'string';
  const isDelivery = isTaggedEncryptionControl(
    message,
    ENCRYPTION_CONTROL_DELIVERY_PATH,
    params.resolvedRole.owningModuleUri,
    params.resolvedRole.owningModulePath,
    audienceContextId,
  ) && message.descriptor.recipient === params.actorDid &&
    entry.isLatestBaseState === true && typeof entry.encodedData === 'string';

  if (isRole) {
    scan.role = message;
  }
  if (isUsableAudience && isRoleAudience) {
    scan.audienceKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (isDelivery) {
    scan.deliveredKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (!isAncestor && !isRole && !isInitialRole && !isAuthorRole && !isUsableAudience && !isDelivery) {
    throw unsupportedEntry(entry);
  }
}

function expectedAuthorRoleProofs(
  params: ResolvedSupportValidationParams,
  ancestorIds: ReadonlyMap<string, ExpectedAncestor>,
): Set<string> {
  const records = [params.root];
  if (params.rootInitialWrite !== undefined) {
    records.push(params.rootInitialWrite);
  }
  for (const entry of params.support) {
    if (Records.isRecordsWrite(entry.message) && isExpectedAncestor(entry, entry.message, ancestorIds)) {
      records.push(entry.message);
    }
  }

  const proofs = new Set<string>();
  const addProof = (module: string, modulePath: string | undefined, recipient: string | undefined, contextId: string | undefined): void => {
    if (modulePath === undefined) {
      return;
    }
    if (recipient === undefined) {
      throw new RoleReplicationSupportError('a role-authored record has no logical author.');
    }
    const authorGraph = resolveSupportModuleGraph(params, module);
    if (authorGraph === undefined) {
      throw new RoleReplicationSupportError(`missing author-role module '${module}'.`);
    }
    const identity = getRoleRecordIdentity({ role: authorGraph.resolveInvokedRole(modulePath), contextId, recipient });
    if (identity.key === params.roleIdentity.key) {
      return;
    }
    proofs.add(identity.key);
  };
  for (const record of records) {
    addProof(record.descriptor.module, getRecordModuleRole(record), getRecordAuthor(record), record.contextId);
  }
  if (params.rootDelete !== undefined) {
    addProof(params.root.descriptor.module, getRecordModuleRole(params.rootDelete), getRecordAuthor(params.rootDelete), params.root.contextId);
  }
  return proofs;
}

function isRecordsDeleteMessage(
  message: RecordsDeleteMessage | RecordsWriteMessage | undefined,
): message is RecordsDeleteMessage {
  return message?.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
}

function isExpectedAncestor(
  entry: RecordsReadReplicationSupportEntry,
  message: RecordsWriteMessage,
  ancestorIds: ReadonlyMap<string, ExpectedAncestor>,
): boolean {
  const ancestor = ancestorIds.get(message.recordId);
  return ancestor !== undefined &&
    message.contextId === ancestor.contextId &&
    message.descriptor.module === ancestor.module &&
    message.descriptor.modulePath === ancestor.modulePath &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined;
}

function assertRoleAudienceReady(
  params: ResolvedSupportValidationParams,
  wrappedKeyIds: ReadonlySet<string>,
  scan: SupportScan,
): void {
  const roleRuleSet = params.resolvedRole.ruleSet;
  const deliveryRequired = roleRuleSet?.$role === true && roleRuleSet.$keyAgreement !== undefined;
  const missingAudience = (params.rootDelete === undefined && deliveryRequired && scan.audienceKeyIds.size === 0) ||
    hasMissingKey(wrappedKeyIds, scan.audienceKeyIds);
  const missingDelivery = params.rootDelete === undefined &&
    hasMissingKey(scan.audienceKeyIds, scan.deliveredKeyIds);
  if (missingAudience || missingDelivery) {
    throw new FollowedSourceNotReadyError(
      missingAudience
        ? 'the role audience key is unavailable.'
        : `the audience key has not been delivered to ${params.actorDid}.`,
    );
  }
}

function hasMissingKey(required: ReadonlySet<string>, present: ReadonlySet<string>): boolean {
  for (const keyId of required) {
    if (!present.has(keyId)) {
      return true;
    }
  }
  return false;
}

function resolveSupportModuleGraph(
  params: ResolvedSupportValidationParams,
  module: string,
): ResolvedModuleGraph | undefined {
  const cached = params.graphsByModule.get(module);
  if (cached !== undefined) {
    return cached;
  }
  const definition = params.graph.definitionsByUri.get(module);
  if (definition === undefined) {
    return undefined;
  }
  const resolved = resolveModuleGraph(definition, uri => params.graph.definitionsByUri.get(uri));
  params.graphsByModule.set(module, resolved);
  return resolved;
}

function isTaggedEncryptionControl(
  message: RecordsWriteMessage,
  modulePath: string,
  module: string,
  rolePath: string,
  contextId: string | undefined,
): boolean {
  return contextId !== undefined &&
    isEncryptionControlRecordFor(message, modulePath, { module, rolePath, contextId });
}

function isRootAudienceControl(
  message: RecordsWriteMessage,
  params: ResolvedSupportValidationParams,
): boolean {
  const tags = message.descriptor.tags;
  if (message.descriptor.modulePath !== ENCRYPTION_CONTROL_AUDIENCE_PATH ||
      tags?.module !== message.descriptor.module || typeof tags.rolePath !== 'string' ||
      typeof tags.contextId !== 'string' || typeof tags.keyId !== 'string') {
    return false;
  }
  const roleGraph = resolveSupportModuleGraph(params, message.descriptor.module);
  if (roleGraph === undefined) {
    return false;
  }
  const role = roleGraph.resolveInvokedRole(tags.rolePath);
  return params.root.encryption?.keyEncryption.some(entry =>
    entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME && 'module' in entry &&
    entry.module === role.owningModuleUri && entry.rolePath === role.owningModulePath && entry.keyId === tags.keyId &&
    getRoleAudienceContextId(role, params.root.contextId) === tags.contextId
  ) === true;
}

function unsupportedEntry(entry: RecordsReadReplicationSupportEntry): Error {
  const { interface: interfaceName, method } = entry.message.descriptor;
  return new RoleReplicationSupportError(`the response contains unrelated entry ${interfaceName}/${method}.`);
}

function toSyncEntry(entry: RecordsReadReplicationSupportEntry): SyncMessageEntry {
  const syncEntry: SyncMessageEntry = {
    message           : entry.message,
    isLatestBaseState : entry.isLatestBaseState,
  };
  if (entry.encodedData !== undefined) {
    const dataSize = Records.isRecordsWrite(entry.message)
      ? entry.message.descriptor.dataSize
      : DwnConstant.maxDataSizeAllowedToBeEncoded;
    const maxBytes = Math.min(dataSize, DwnConstant.maxDataSizeAllowedToBeEncoded);
    if (entry.encodedData.length > Math.ceil(maxBytes * 4 / 3)) {
      throw new RoleReplicationSupportError('an entry\'s inline data exceeds its declared bound.');
    }
    syncEntry.bufferedData = Encoder.base64UrlToBytes(entry.encodedData);
  }
  return syncEntry;
}

function assertCurrent(shouldContinue: (() => boolean) | undefined): void {
  if (shouldContinue?.() === false) {
    throw new SyncWorkInterruptedError();
  }
}

async function resolveDelegatedRoleReadGrant(
  params: DelegatedRoleReadParams,
  contextId: string,
  modulePath: string,
): Promise<DwnDataEncodedRecordsWriteMessage | undefined> {
  if (params.delegateDid === undefined) {
    return undefined;
  }
  const { message } = await params.permissionsApi.getPermissionForRequest({
    connectedDid : params.actorDid,
    contextId,
    delegate     : true,
    delegateDid  : params.delegateDid,
    forceRefresh : true,
    messageType  : DwnInterface.RecordsRead,
    module       : params.module,
    modulePath,
  });
  return message;
}
