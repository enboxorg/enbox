import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { defineModule } from '../src/define-module.js';
import { normalizeModuleRequests } from '@enbox/auth';
import { recordCodecs } from '../src/record-codec.js';
import { defineApplicationManifest, getApplicationModuleRequests } from '../src/application-manifest.js';

const NotesDefinition = {
  module    : 'https://example.com/modules/notes',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const satisfies ModuleDefinition;

const NotesModule = defineModule({ definition : NotesDefinition, codecs     : {
  note: recordCodecs.json<{ body: string }>(),
} });

const PhotosDefinition = {
  module    : 'https://example.com/modules/photos',
  published : true,
  types     : {
    photo: { dataFormats: ['image/jpeg'] },
  },
  structure: {
    photo: {},
  },
} as const satisfies ModuleDefinition;

const PhotosModule = defineModule({ definition : PhotosDefinition, codecs     : {
  photo: recordCodecs.blob('image/jpeg'),
} });

describe('application manifest', () => {
  it('should normalize typed module shorthands and explicit permission policies', () => {
    const application = defineApplicationManifest({
      modules: [
        NotesModule,
        { module: PhotosModule, permissions: ['read'] },
      ],
    } as const);

    expect(application.modules).toHaveLength(2);
    expect(application.modules[0].module).toBe(NotesModule);
    expect(application.modules[0].permissions).toEqual(['read', 'write', 'delete']);
    expect(Object.isFrozen(application.modules[0].permissions)).toBe(true);
    expect(application.modules[1].module).toBe(PhotosModule);
    expect(application.modules[1].permissions).toEqual(['read']);
  });

  it('should project raw definitions and fresh normalized permission arrays', () => {
    const application = defineApplicationManifest({
      modules: [
        NotesModule,
        { module: PhotosModule, permissions: ['read'] },
      ],
    } as const);

    const first = getApplicationModuleRequests(application);
    expect(first[0]).toEqual({ definition: NotesDefinition, permissions: ['read', 'write', 'delete'] });
    expect(first[1]).toEqual({ definition: PhotosDefinition, permissions: ['read'] });
    expect(first[0]).not.toHaveProperty('codecs');
    expect(first[1]).not.toHaveProperty('codecs');
    expect((first[1] as { definition: object }).definition).not.toHaveProperty('codecs');
    expect(normalizeModuleRequests(first).map(({ permissionScopes }) => permissionScopes.length)).toEqual([5, 3]);

    const explicit = first[1] as { permissions: Array<'read' | 'write' | 'delete'> };
    explicit.permissions.push('write');

    const second = getApplicationModuleRequests(application);
    expect(second).not.toBe(first);
    expect(second[1]).toEqual({ definition: PhotosDefinition, permissions: ['read'] });
  });

  it('should include transitive installation-only providers before consumers without granting provider feeds', () => {
    const Comments = defineModule({
      definition: {
        module    : 'https://example.com/modules/comments',
        published : true,
        uses      : { notes: NotesModule.definition.module },
        types     : { comment: { dataFormats: ['text/plain'] } },
        structure : { note: { $ref: 'notes:note', comment: {} } },
      },
      codecs       : { comment: recordCodecs.text() },
      dependencies : { notes: NotesModule },
    });
    const Reactions = defineModule({
      definition: {
        module    : 'https://example.com/modules/reactions',
        published : true,
        uses      : { comments: Comments.definition.module },
        types     : { reaction: { dataFormats: ['text/plain'] } },
        structure : { comment: { $ref: 'comments:note/comment', reaction: {} } },
      },
      codecs       : { reaction: recordCodecs.text() },
      dependencies : { comments: Comments },
    });
    const application = defineApplicationManifest({ modules: [{ module: Reactions, permissions: ['read'] }] });
    const requests = getApplicationModuleRequests(application);
    expect(requests).toEqual([
      { definition: NotesModule.definition, permissions: [], installationOnly: true },
      { definition: Comments.definition, permissions: [], installationOnly: true },
      { definition: Reactions.definition, permissions: ['read'] },
    ]);
    const wire = normalizeModuleRequests(requests);
    expect(wire.map(request => request.permissionScopes.length)).toEqual([0, 0, 3]);
    expect(wire.flatMap(request => request.permissionScopes).every(scope => scope.module === Reactions.definition.module)).toBe(true);
    expect(JSON.stringify(wire)).not.toContain('codecs');
    expect(JSON.stringify(wire)).not.toContain('installationOnly');

    const explicitProvider = defineApplicationManifest({
      modules: [{ module: Reactions, permissions: ['read'] }, { module: NotesModule, permissions: [] }],
    });
    const explicitRequests = getApplicationModuleRequests(explicitProvider);
    expect(explicitRequests).toHaveLength(3);
    expect(explicitRequests[0]).toEqual({ definition: NotesModule.definition, permissions: [] });
    // Explicitly registered empty policies retain auth's existing sync-only meaning.
    expect(normalizeModuleRequests(explicitRequests).map(request => request.permissionScopes.length)).toEqual([2, 0, 3]);
  });

  it('should freeze copied manifest containers and retain immutable module artifacts', () => {
    const permissions = Object.freeze(['read'] as const);
    const application = defineApplicationManifest({
      modules: [{ module: NotesModule, permissions }],
    } as const);

    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.modules)).toBe(true);
    expect(Object.isFrozen(application.modules[0])).toBe(true);
    expect(Object.isFrozen(application.modules[0].permissions)).toBe(true);
    expect(application.modules[0].permissions).not.toBe(permissions);
    expect(permissions).toEqual(['read']);
    expect(application.modules[0].module).toBe(NotesModule);
    expect(Object.isFrozen(NotesModule)).toBe(true);
    expect(Object.isFrozen(NotesModule.definition)).toBe(true);
    expect(Object.isFrozen(NotesModule.codecs)).toBe(true);
    expect(Object.isFrozen(NotesDefinition)).toBe(false);
  });

  it('should reject a raw definition because application manifests require typed modules', () => {
    expect(() => defineApplicationManifest({
      modules: [NotesDefinition as unknown as typeof NotesModule],
    })).toThrow('defineApplicationManifest: modules[0] must be a TypedModule.');
  });

  it('should reject malformed runtime permission policies with deterministic paths', () => {
    const defineWithPermissions = (permissions: unknown): unknown => defineApplicationManifest({
      modules: [{
        permissions : permissions as readonly ('read' | 'write' | 'delete')[],
        module      : NotesModule,
      }],
    });

    expect(() => defineWithPermissions('read')).toThrow(
      'defineApplicationManifest: modules[0].permissions must be an array.',
    );
    expect(() => defineWithPermissions(['admin'])).toThrow(
      'defineApplicationManifest: modules[0].permissions[0] has unsupported permission \'admin\'. ' +
      'Supported permissions: read, write, delete.',
    );
    expect(() => defineWithPermissions(['write', 'read', 'write'])).toThrow(
      'defineApplicationManifest: modules[0].permissions contains duplicate permission \'write\' at indexes 0 and 2.',
    );
  });

  it('should reject malformed runtime TypedModule values at their stable index', () => {
    const malformedModules = [
      {
        definition : { structure: NotesDefinition.structure, types: NotesDefinition.types },
        codecs     : NotesModule.codecs,
      },
      {
        definition : { module: NotesDefinition.module, structure: NotesDefinition.structure },
        codecs     : NotesModule.codecs,
      },
      {
        definition : { ...NotesDefinition, types: [] },
        codecs     : NotesModule.codecs,
      },
      {
        definition : { module: NotesDefinition.module, types: NotesDefinition.types },
        codecs     : NotesModule.codecs,
      },
      {
        definition : NotesDefinition,
        codecs     : { note: { encode: NotesModule.codecs.note.encode } },
      },
      {
        definition : NotesDefinition,
        codecs     : {},
      },
      {
        definition: {
          module    : NotesDefinition.module,
          structure : NotesDefinition.structure,
          types     : NotesDefinition.types,
        },
        codecs: NotesModule.codecs,
      },
      {
        definition : { ...NotesDefinition, types: {} },
        codecs     : NotesModule.codecs,
      },
      {
        definition : { ...NotesDefinition, structure: { note: true } },
        codecs     : NotesModule.codecs,
      },
    ];

    for (const malformed of malformedModules) {
      expect(() => defineApplicationManifest({
        modules: [NotesModule, malformed as unknown as typeof NotesModule],
      })).toThrow('defineApplicationManifest: modules[1] must be a TypedModule.');
    }
  });

  it('should reject duplicate module URIs with stable indexes', () => {
    const reorderedDefinition = {
      structure : NotesDefinition.structure,
      types     : NotesDefinition.types,
      published : NotesDefinition.published,
      module    : NotesDefinition.module,
    } as const satisfies ModuleDefinition;
    const reorderedModule = defineModule({ definition: reorderedDefinition, codecs: NotesModule.codecs });

    expect(() => defineApplicationManifest({
      modules: [NotesModule, reorderedModule],
    })).toThrow(
      'defineApplicationManifest: duplicate module URI \'https://example.com/modules/notes\' at indexes 0 and 1.',
    );
  });

  it('should reject conflicting definitions for the same module URI with stable indexes', () => {
    const conflictingDefinition = {
      ...NotesDefinition,
      published: false,
    } as const satisfies ModuleDefinition;
    const conflictingModule = defineModule({ definition: conflictingDefinition, codecs: NotesModule.codecs });

    expect(() => defineApplicationManifest({
      modules: [NotesModule, conflictingModule],
    })).toThrow(
      'defineApplicationManifest: conflicting definitions for module URI \'https://example.com/modules/notes\' at indexes 0 and 1.',
    );
  });
});
