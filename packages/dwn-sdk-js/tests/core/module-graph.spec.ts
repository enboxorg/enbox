import type { ModuleDefinition, ModuleKeyAgreement, ModuleRuleSet } from '../../src/types/modules-types.js';

import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

import { EncryptionModule } from '../../src/modules/encryption.js';
import { messageReplyFromError } from '../../src/core/message-reply.js';
import { replicationApplyResultFromReply } from '../../src/core/replication-apply.js';
import { resolveModuleGraph } from '../../src/core/module-graph.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';
import { DwnError, DwnErrorCode } from '../../src/core/dwn-error.js';
import { loadModuleGraph, preloadModuleDefinitions } from '../../src/core/module-graph-loader.js';

const baseUri = 'https://example.com/modules/base';
const messagesUri = 'https://example.com/modules/messages';
const extrasUri = 'https://example.com/modules/extras';
const keyAgreement: ModuleKeyAgreement = { publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'a'.repeat(43) } };

function definition(
  module: string,
  names: string[],
  structure: ModuleDefinition['structure'],
  uses?: Record<string, string>,
): ModuleDefinition {
  const types = Object.fromEntries(names.map(name => [name, { dataFormats: ['application/json'] }]));
  return { module, published: false, types, structure, ...(uses === undefined ? {} : { uses }) };
}

function baseDefinition(): ModuleDefinition {
  return definition(baseUri, ['workspace', 'board', 'member', 'file'], {
    workspace: {
      member : { $role: true },
      board  : {
        $actions : [{ role: 'workspace/member', can: ['read'] }],
        member   : { $role: true },
        file     : {},
      },
    },
  });
}

function messagesDefinition(): ModuleDefinition {
  return definition(messagesUri, ['comment'], {
    task: {
      $ref    : 'base:workspace/board',
      comment : {
        $actions: [
          { role: 'base:workspace/member', can: ['create', 'read'] },
          { who: 'author', of: 'task', can: ['read'] },
        ],
      },
    },
  }, { base: baseUri });
}

function lookup(...definitions: ModuleDefinition[]): (uri: string) => ModuleDefinition | undefined {
  const definitionsByUri = new Map(definitions.map(value => [value.module, value]));
  return (uri: string): ModuleDefinition | undefined => definitionsByUri.get(uri);
}

describe('resolveModuleGraph', () => {
  it('resolves the trusted encryption core definition without rewriting its strict tag rules', () => {
    const graph = resolveModuleGraph(EncryptionModule.definition, lookup());
    expect(graph.nodesByDeclaredPath.get('grantKey')?.kind).toBe('record');
    expect(graph.nodesByDeclaredPath.get('grantKey')?.ruleSet.$tags?.keyId).toEqual({
      type      : 'string',
      minLength : 43,
      maxLength : 43,
      pattern   : '^[A-Za-z0-9_-]{43}$',
    });
  });

  it('preserves local ownership and maps a renamed deep attachment to its physical parent', () => {
    const graph = resolveModuleGraph(messagesDefinition(), lookup(baseDefinition()));
    const attachment = graph.nodesByDeclaredPath.get('task')!;
    const comment = graph.nodesByDeclaredPath.get('task/comment')!;
    expect(attachment.kind).toBe('ref');
    expect(attachment.owningModuleUri).toBe(baseUri);
    expect(attachment.owningModulePath).toBe('workspace/board');
    expect(comment.kind).toBe('record');
    expect(comment.owningModuleUri).toBe(messagesUri);
    expect(comment.owningModulePath).toBe('task/comment');
    expect(comment.expectedParent).toEqual({ owningModuleUri: baseUri, owningModulePath: 'workspace/board' });
    expect(comment.physicalDepth).toBe(3);
    expect(comment.parentPhysicalDepth).toBe(2);
    expect(comment.physicalAncestors.map(step => [step.owningModuleUri, step.owningModulePath])).toEqual([
      [baseUri, 'workspace'],
      [baseUri, 'workspace/board'],
    ]);
    expect(comment.rolesByRawRef.get('base:workspace/member')?.parentPhysicalDepth).toBe(1);
    expect(comment.actions[1].resolvedActor).toEqual({
      owningModuleUri  : baseUri,
      owningModulePath : 'workspace/board',
      who              : 'author',
      rawOf            : 'task',
      physicalDepth    : 2,
    });
  });

  it('resolves A to B to C descendants without importing A children into B', () => {
    const extras = definition(extrasUri, ['reaction'], {
      comment: { $ref: 'messages:task/comment', reaction: {} },
    }, { messages: messagesUri });
    const graph = resolveModuleGraph(extras, lookup(baseDefinition(), messagesDefinition()));
    const reaction = graph.nodesByDeclaredPath.get('comment/reaction')!;
    expect(reaction.physicalDepth).toBe(4);
    expect(reaction.expectedParent).toEqual({ owningModuleUri: messagesUri, owningModulePath: 'task/comment' });
    expect(reaction.physicalAncestors.at(-1)?.owningModuleUri).toBe(messagesUri);
    extras.structure.comment.$ref = 'messages:task/file';
    expect(() => resolveModuleGraph(extras, lookup(baseDefinition(), messagesDefinition())))
      .toThrow(DwnErrorCode.ModulesConfigureInvalidRefModulePath);
  });

  it('dereferences a terminal attachment in its declaring alias namespace', () => {
    const unrelated = definition('https://example.com/modules/unrelated', ['other'], { other: {} });
    const extras = definition(extrasUri, ['reaction'], {
      board: { $ref: 'messages:task', reaction: {} },
    }, { messages: messagesUri, base: unrelated.module });
    const graph = resolveModuleGraph(extras, lookup(baseDefinition(), messagesDefinition(), unrelated));
    expect(graph.nodesByDeclaredPath.get('board')?.owningModuleUri).toBe(baseUri);
    expect(graph.nodesByDeclaredPath.get('board/reaction')?.physicalDepth).toBe(3);
  });

  it('accepts inert attachment actions without inheriting them or the provider actions', () => {
    const consumer = definition(messagesUri, ['comment'], {
      task: { $ref: 'base:workspace/board', $actions: [{ who: 'anyone', can: ['create'] }], comment: {} },
    }, { base: baseUri });
    const graph = resolveModuleGraph(consumer, lookup(baseDefinition()));
    const attachment = graph.nodesByDeclaredPath.get('task')!;
    expect(attachment.declaredRuleSet.$actions).toEqual([{ who: 'anyone', can: ['create'] }]);
    expect(attachment.ruleSet.$actions).toEqual([{ role: 'workspace/member', can: ['read'] }]);
    expect(attachment.actions.map(action => action.rule)).toEqual([{ who: 'anyone', can: ['create'] }]);
    expect(graph.nodesByDeclaredPath.get('task/comment')?.actions).toEqual([]);
  });

  it('keeps a same-named local type distinct from a reference target', () => {
    const consumer = definition(messagesUri, ['task', 'folder', 'comment'], {
      task   : { $ref: 'base:workspace/board', comment: {} },
      folder : { task: {} },
    }, { base: baseUri });
    consumer.types.task = { schema: 'https://example.com/local-task', dataFormats: ['text/plain'] };
    const graph = resolveModuleGraph(consumer, lookup(baseDefinition()));
    expect(graph.nodesByDeclaredPath.get('task')?.recordType).toEqual({ dataFormats: ['application/json'] });
    expect(graph.nodesByDeclaredPath.get('folder/task')?.recordType).toEqual(consumer.types.task);
    expect(graph.nodesByDeclaredPath.get('folder/task')?.owningModuleUri).toBe(messagesUri);
  });

  it('snapshots authoring definitions without changing their contents', () => {
    const base = baseDefinition();
    const consumer = messagesDefinition();
    const before = structuredClone([base, consumer]);
    const graph = resolveModuleGraph(consumer, lookup(base));
    expect([base, consumer]).toEqual(before);
    (base.structure.workspace.board as ModuleRuleSet).$squash = true;
    consumer.types.comment.schema = 'https://example.com/changed';
    expect(graph.nodesByDeclaredPath.get('task')?.ruleSet.$squash).toBeUndefined();
    expect(graph.nodesByDeclaredPath.get('task/comment')?.recordType.schema).toBeUndefined();
  });

  it('supports a foreign root role without adding structural ancestry', () => {
    const roles = definition(baseUri, ['member'], { member: { $role: true } });
    const consumer = definition(messagesUri, ['note'], {
      note: { $actions: [{ role: 'base:member', can: ['read'] }] },
    }, { base: baseUri });
    const graph = resolveModuleGraph(consumer, lookup(roles));
    expect(graph.nodesByDeclaredPath.get('note')?.physicalAncestors).toEqual([]);
    expect(graph.resolveInvokedRole('base:member').parentPhysicalDepth).toBe(0);
  });

  it('derives a local role below a deep reference from its immediate physical parent', () => {
    const consumer = definition(messagesUri, ['moderator', 'comment'], {
      board: {
        $ref      : 'base:workspace/board',
        moderator : { $role: true },
        comment   : { $actions: [{ role: 'board/moderator', can: ['read'] }] },
      },
    }, { base: baseUri });
    const role = resolveModuleGraph(consumer, lookup(baseDefinition())).resolveInvokedRole('board/moderator');
    expect(role.physicalDepth).toBe(3);
    expect(role.parentPhysicalDepth).toBe(2);
    expect(role.parentAncestor).toEqual({ owningModuleUri: baseUri, owningModulePath: 'workspace/board' });
  });

  it('resolves local attachment and qualified references to the same canonical role', () => {
    const consumer = definition(messagesUri, ['note'], {
      member: { $ref: 'base:workspace/member', note: { $actions: [{ role: 'member', can: ['read'] }] } },
    }, { base: baseUri });
    const graph = resolveModuleGraph(consumer, lookup(baseDefinition()));
    const local = graph.resolveInvokedRole('member');
    const qualified = graph.resolveInvokedRole('base:workspace/member');
    expect(local.owningModuleUri).toBe(qualified.owningModuleUri);
    expect(local.owningModulePath).toBe(qualified.owningModulePath);
    expect(local.parentAncestor).toEqual(qualified.parentAncestor);
  });

  it('rejects duplicate canonical roles even when their reference strings differ', () => {
    const consumer = definition(messagesUri, ['note'], {
      member: {
        $ref : 'base:workspace/member',
        note : { $actions: [{ role: 'member', can: ['read'] }, { role: 'base:workspace/member', can: ['create'] }] },
      },
    }, { base: baseUri });
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureDuplicateRoleInRuleSet);
  });

  it('rejects duplicate canonical actors but keeps absent-of and recipient-of-self distinct', () => {
    const consumer = messagesDefinition();
    const comment = consumer.structure.task.comment as ModuleRuleSet;
    comment.$actions = [
      { who: 'author', of: 'task', can: ['create'] },
      { who: 'author', of: 'base:workspace/board', can: ['read'] },
    ];
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureDuplicateActorInRuleSet);
    comment.$actions = [
      { who: 'recipient', can: ['co-delete'] },
      { who: 'recipient', of: 'task/comment', can: ['read'] },
    ];
    expect(resolveModuleGraph(consumer, lookup(baseDefinition())).nodesByDeclaredPath.get('task/comment')?.actions).toHaveLength(2);
  });

  it('rejects roles on a sibling branch even when their parent is at a shallower depth', () => {
    const module = definition(baseUri, ['left', 'right', 'member', 'note'], {
      left  : { member: { $role: true } },
      right : { note: { $actions: [{ role: 'left/member', can: ['read'] }] } },
    });
    expect(() => resolveModuleGraph(module, lookup())).toThrow(DwnErrorCode.ModulesConfigureInvalidRoleAncestor);
  });

  it('rejects a foreign actor target that is not in the actual ancestor chain', () => {
    const consumer = messagesDefinition();
    (consumer.structure.task.comment as ModuleRuleSet).$actions = [
      { who: 'author', of: 'base:workspace/board/file', can: ['read'] },
    ];
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureInvalidActionOfNotAnAncestor);
  });

  it('rejects a non-role target and an unresolved reference alias', () => {
    const consumer = messagesDefinition();
    const comment = consumer.structure.task.comment as ModuleRuleSet;
    comment.$actions = [{ role: 'base:workspace/board', can: ['read'] }];
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath);
    comment.$actions = [{ role: 'missing:workspace/member', can: ['read'] }];
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureInvalidRefAlias);
  });

  it('rejects a local reference nested beneath a local record', () => {
    const consumer = definition(messagesUri, ['container', 'comment'], {
      container: { task: { $ref: 'base:workspace/board', comment: {} } },
    }, { base: baseUri });
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot);
  });

  it('rejects a local node without a corresponding local type', () => {
    const consumer = definition(messagesUri, [], { note: {} });
    expect(() => resolveModuleGraph(consumer, lookup())).toThrow(DwnErrorCode.ModulesConfigureInvalidRuleSetRecordType);
  });

  it('rejects duplicate uses URIs and direct or indirect duplicate canonical attachments', () => {
    const consumer = messagesDefinition();
    consumer.uses!.duplicate = baseUri;
    expect(() => resolveModuleGraph(consumer, lookup(baseDefinition()))).toThrow(DwnErrorCode.ModulesConfigureDuplicateUsesModule);
    const extras = definition(extrasUri, ['note'], {
      first  : { $ref: 'base:workspace/board', note: {} },
      second : { $ref: 'messages:task', note: {} },
    }, { base: baseUri, messages: messagesUri });
    expect(() => resolveModuleGraph(extras, lookup(baseDefinition(), messagesDefinition())))
      .toThrow(DwnErrorCode.ModulesConfigureDuplicateRefTarget);
    extras.structure.second.$ref = 'base:workspace/board';
    expect(() => resolveModuleGraph(extras, lookup(baseDefinition(), messagesDefinition())))
      .toThrow(DwnErrorCode.ModulesConfigureDuplicateRefTarget);
  });

  it('rejects uses cycles including role-only cycles', () => {
    const first = definition(baseUri, ['member'], { member: { $role: true } }, { second: messagesUri });
    const second = definition(messagesUri, ['member'], { member: { $role: true } }, { first: baseUri });
    expect(() => resolveModuleGraph(first, lookup(second))).toThrow(DwnErrorCode.ModulesConfigureInvalidUsesCycle);
  });

  it('rejects missing and mismatched dependency definitions', () => {
    expect(() => resolveModuleGraph(messagesDefinition(), lookup())).toThrow(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled);
    expect(() => resolveModuleGraph(messagesDefinition(), (): ModuleDefinition => messagesDefinition()))
      .toThrow(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl);
  });

  it('rejects squash on either the concrete target or its imported ancestor', () => {
    const base = baseDefinition();
    (base.structure.workspace.board as ModuleRuleSet).$squash = true;
    expect(() => resolveModuleGraph(messagesDefinition(), lookup(base))).toThrow(DwnErrorCode.ModulesConfigureInvalidRefTargetSquash);
    delete (base.structure.workspace.board as ModuleRuleSet).$squash;
    base.structure.workspace.$squash = true;
    expect(() => resolveModuleGraph(messagesDefinition(), lookup(base))).toThrow(DwnErrorCode.ModulesConfigureInvalidRefTargetSquash);
  });

  it('enforces physical depth across module boundaries without counting virtual aliases', () => {
    function nested(depth: number): ModuleDefinition {
      let branch: ModuleRuleSet = {};
      for (let i = 1; i < depth; i++) {
        branch = { node: branch };
      }
      return definition(baseUri, ['node'], { node: branch });
    }
    const consumer = definition(messagesUri, ['comment'], {
      target: { $ref: `base:${Array(9).fill('node').join('/')}`, comment: {} },
    }, { base: baseUri });
    expect(resolveModuleGraph(consumer, lookup(nested(9))).nodesByDeclaredPath.get('target/comment')?.physicalDepth).toBe(10);
    consumer.structure.target.$ref = `base:${Array(10).fill('node').join('/')}`;
    expect(() => resolveModuleGraph(consumer, lookup(nested(10)))).toThrow(DwnErrorCode.ModulesConfigureMaxDepthExceeded);
  });

  it('requires installed read-role keys by default and explicitly permits authored graphs', () => {
    const base = baseDefinition();
    const consumer = messagesDefinition();
    consumer.types.comment.encryptionRequired = true;
    consumer.$keyAgreement = keyAgreement;
    (consumer.structure.task.comment as ModuleRuleSet).$keyAgreement = keyAgreement;
    expect(() => resolveModuleGraph(consumer, lookup(base))).toThrow(DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement);
    expect(() => resolveModuleGraph(consumer, lookup(base), { requireKeyAgreement: false })).not.toThrow();
    (base.structure.workspace.member as ModuleRuleSet).$keyAgreement = keyAgreement;
    expect(() => resolveModuleGraph(consumer, lookup(base))).not.toThrow();
  });

  it('does not require role encryption routes merely because a virtual attachment declares actions', () => {
    const base = baseDefinition();
    base.types.board.encryptionRequired = true;
    delete (base.structure.workspace.board as ModuleRuleSet).$actions;
    const consumer = definition(messagesUri, ['comment'], {
      task: {
        $ref     : 'base:workspace/board',
        $actions : [{ role: 'base:workspace/member', can: ['read'] }],
        comment  : {},
      },
    }, { base: baseUri });
    expect(() => resolveModuleGraph(consumer, lookup(base))).not.toThrow();
  });

  it('resolves every complete RFC fixture as an authored graph', () => {
    const directory = new URL('../vectors/module-composition/', import.meta.url).pathname;
    const definitions: ModuleDefinition[] = [];
    for (const app of readdirSync(directory)) {
      for (const file of readdirSync(join(directory, app))) {
        if (file.endsWith('.json')) {
          definitions.push(JSON.parse(readFileSync(join(directory, app, file), 'utf8')) as ModuleDefinition);
        }
      }
    }
    expect(definitions).toHaveLength(13);
    for (const module of definitions) {
      const graph = resolveModuleGraph(module, lookup(...definitions), { requireKeyAgreement: false });
      expect(graph.rootModuleUri).toBe(module.module);
      expect([...graph.nodesByDeclaredPath.values()].some(node => node.kind === 'record')).toBe(true);
    }
  });
});

describe('preloadModuleDefinitions', () => {
  it('repairs the actual missing transitive module when the runtime reader throws not-found', async () => {
    const extras = definition(extrasUri, ['reaction'], {
      comment: { $ref: 'messages:task/comment', reaction: {} },
    }, { messages: messagesUri });
    const selected = lookup(extras, messagesDefinition());
    const timestamp = '2026-01-01T00:00:00.000000Z';
    const lookups: string[] = [];
    const reader = {
      fetchModuleDefinition: async (_tenant: string, uri: string, at?: string): Promise<ModuleDefinition> => {
        expect(at).toBe(timestamp);
        lookups.push(uri);
        const value = selected(uri);
        if (value === undefined) {
          throw new DwnError(DwnErrorCode.ModuleAuthorizationModuleNotFound, `unable to find module definition for ${uri}`);
        }
        return value;
      },
    };
    let failure: unknown;
    try {
      await loadModuleGraph('did:example:tenant', extrasUri, reader, timestamp);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DwnError);
    expect((failure as DwnError).code).toBe(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled);
    expect(lookups).toEqual([extrasUri, messagesUri, baseUri]);
    const { message } = await TestDataGenerator.generateRecordsWrite({ module: extrasUri, modulePath: 'comment/reaction' });
    expect(replicationApplyResultFromReply(message, messageReplyFromError(failure, 400))).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Module', module: baseUri }],
    });
  });

  it('preserves root not-found and non-not-found dependency errors', async () => {
    const missing = new DwnError(DwnErrorCode.ModuleAuthorizationModuleNotFound, 'root missing');
    const rootMissingReader = { fetchModuleDefinition: async (): Promise<ModuleDefinition> => { throw missing; } };
    await expect(loadModuleGraph('did:example:tenant', messagesUri, rootMissingReader)).rejects.toThrow(missing.message);
    const unavailable = new Error('storage unavailable');
    const reader = {
      fetchModuleDefinition: async (_tenant: string, uri: string): Promise<ModuleDefinition> => {
        if (uri === messagesUri) {
          return messagesDefinition();
        }
        throw unavailable;
      },
    };
    await expect(loadModuleGraph('did:example:tenant', messagesUri, reader)).rejects.toThrow(unavailable.message);
  });

  it('fetches a shared diamond dependency once and includes the supplied root', async () => {
    const extras = definition(extrasUri, ['reaction'], {
      comment: { $ref: 'messages:task/comment', reaction: {} },
    }, { base: baseUri, messages: messagesUri });
    const get = lookup(baseDefinition(), messagesDefinition());
    const fetched: string[] = [];
    const definitions = await preloadModuleDefinitions(extras, async (uri): Promise<ModuleDefinition | undefined> => {
      fetched.push(uri);
      return get(uri);
    });
    expect(fetched.sort()).toEqual([baseUri, messagesUri].sort());
    expect(definitions.size).toBe(3);
    expect(resolveModuleGraph(extras, uri => definitions.get(uri)).nodesByDeclaredPath.get('comment/reaction')?.physicalDepth).toBe(4);
  });

  it('rejects missing, mismatched, and cyclic fetched definitions', async () => {
    await expect(preloadModuleDefinitions(messagesDefinition(), async (): Promise<undefined> => undefined))
      .rejects.toThrow(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled);
    await expect(preloadModuleDefinitions(messagesDefinition(), async (): Promise<ModuleDefinition> => messagesDefinition()))
      .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl);
    const base = baseDefinition();
    base.uses = { messages: messagesUri };
    await expect(preloadModuleDefinitions(messagesDefinition(), async (): Promise<ModuleDefinition> => base))
      .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidUsesCycle);
  });
});
