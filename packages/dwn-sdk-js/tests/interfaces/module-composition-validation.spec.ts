import type { ModuleDefinition, ModuleRuleSet } from '../../src/types/modules-types.js';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { ModulesConfigure } from '../../src/interfaces/modules-configure.js';
import { describe, expect, it } from 'bun:test';

const provider = 'https://example.com/modules/provider';

function consumer(): ModuleDefinition {
  return {
    module    : 'https://example.com/modules/consumer',
    published : true,
    uses      : { core: provider },
    types     : { comment: { dataFormats: ['text/plain'] } },
    structure : {
      note: {
        $ref    : 'core:workspace/note',
        comment : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read'] }] },
      },
    },
  };
}

describe('Module composition stateless validation', () => {
  it('defers qualified role and local attachment actor resolution without loading providers', () => {
    const definition = consumer();
    (definition.structure.note.comment as ModuleRuleSet).$actions!.push({ who: 'author', of: 'note', can: ['create'] });
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).not.toThrow();
  });

  it('rejects duplicate dependency URIs and noncanonical dependency identifiers', () => {
    const definition = consumer();
    definition.uses!.alias = provider;
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureDuplicateUsesModule);
    definition.uses!.alias = `${provider}/`;
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl);
  });

  it('requires local child records at every attachment', () => {
    const definition = consumer();
    definition.structure.note = { $ref: 'core:workspace/note' };
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureInvalidRefWithoutChildren);
  });

  it('allows explicit attachment actions without admitting record policy overrides', () => {
    const definition = consumer();
    definition.structure.note.$actions = [{ who: 'anyone', can: ['read'] }];
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).not.toThrow();
    definition.structure.note.$immutable = true;
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureInvalidRefNodeHasDirectives);
  });

  it('rejects an attachment beneath a local record', () => {
    const definition = consumer();
    definition.types.root = {};
    definition.structure = { root: { note: definition.structure.note } };
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot);
  });

  it('distinguishes a ref name from a same-named local record type elsewhere', () => {
    const definition = consumer();
    definition.types.note = {};
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureInvalidRefTypeCollision);
    definition.types.folder = {};
    definition.structure.folder = { note: {} };
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).not.toThrow();
  });

  it('allows authored encrypted definitions without keys while installed definitions still require them', () => {
    const definition = consumer();
    definition.types.comment.encryptionRequired = true;
    expect(() => ModulesConfigure.validateModuleDefinition(definition, { requireKeyAgreement: false })).not.toThrow();
    expect(() => ModulesConfigure.validateModuleDefinition(definition)).toThrow(DwnErrorCode.ModulesConfigureMissingTopLevelKeyAgreement);
  });

  it('does not relax encrypted public-read policy when authoring without tenant keys', () => {
    const definition = consumer();
    definition.types.comment.encryptionRequired = true;
    (definition.structure.note.comment as ModuleRuleSet).$actions = [{ who: 'anyone', can: ['read'] }];
    expect(() => ModulesConfigure.validateModuleDefinition(definition, { requireKeyAgreement: false }))
      .toThrow(DwnErrorCode.ModulesConfigureInvalidEncryptedAnyoneRead);
  });
});
