import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { defineApplicationManifest, getApplicationProtocolRequests } from '../src/application-manifest.js';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/notes',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ body: string }>(),
});

const PhotosDefinition = {
  protocol  : 'https://example.com/protocols/photos',
  published : true,
  types     : {
    photo: { dataFormats: ['image/jpeg'] },
  },
  structure: {
    photo: {},
  },
} as const satisfies ProtocolDefinition;

const PhotosProtocol = defineProtocol(PhotosDefinition, {
  photo: recordCodecs.blob('image/jpeg'),
});

describe('application manifest', () => {
  it('should normalize typed protocol shorthands and explicit permission policies', () => {
    const application = defineApplicationManifest({
      protocols: [
        NotesProtocol,
        { protocol: PhotosProtocol, permissions: ['read'] },
      ],
    } as const);

    expect(application.protocols).toHaveLength(2);
    expect(application.protocols[0].protocol).toBe(NotesProtocol);
    expect(application.protocols[0].permissions).toBeUndefined();
    expect(application.protocols[1].protocol).toBe(PhotosProtocol);
    expect(application.protocols[1].permissions).toEqual(['read']);
  });

  it('should project only raw definitions and fresh permission arrays for auth', () => {
    const application = defineApplicationManifest({
      protocols: [
        NotesProtocol,
        { protocol: PhotosProtocol, permissions: ['read'] },
      ],
    } as const);

    const first = getApplicationProtocolRequests(application);
    expect(first[0]).toBe(NotesDefinition);
    expect(first[1]).toEqual({ definition: PhotosDefinition, permissions: ['read'] });
    expect(first[1]).not.toHaveProperty('codecs');
    expect((first[1] as { definition: object }).definition).not.toHaveProperty('codecs');

    const explicit = first[1] as { permissions: Array<'read' | 'write' | 'delete'> };
    explicit.permissions.push('write');

    const second = getApplicationProtocolRequests(application);
    expect(second).not.toBe(first);
    expect(second[1]).toEqual({ definition: PhotosDefinition, permissions: ['read'] });
  });

  it('should freeze copied manifest containers without freezing caller-owned protocols', () => {
    const permissions = Object.freeze(['read'] as const);
    const application = defineApplicationManifest({
      protocols: [{ protocol: NotesProtocol, permissions }],
    } as const);

    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.protocols)).toBe(true);
    expect(Object.isFrozen(application.protocols[0])).toBe(true);
    expect(Object.isFrozen(application.protocols[0].permissions)).toBe(true);
    expect(application.protocols[0].permissions).not.toBe(permissions);
    expect(permissions).toEqual(['read']);
    expect(Object.isFrozen(NotesProtocol)).toBe(false);
    expect(Object.isFrozen(NotesProtocol.definition)).toBe(false);
    expect(Object.isFrozen(NotesProtocol.codecs)).toBe(false);
  });

  it('should reject a raw definition because application manifests require typed protocols', () => {
    expect(() => defineApplicationManifest({
      protocols: [NotesDefinition as unknown as typeof NotesProtocol],
    })).toThrow('defineApplicationManifest: protocols[0] must be a TypedProtocol.');
  });

  it('should reject malformed runtime permission policies with deterministic paths', () => {
    const defineWithPermissions = (permissions: unknown): unknown => defineApplicationManifest({
      protocols: [{
        permissions : permissions as readonly ('read' | 'write' | 'delete')[],
        protocol    : NotesProtocol,
      }],
    });

    expect(() => defineWithPermissions('read')).toThrow(
      'defineApplicationManifest: protocols[0].permissions must be an array.',
    );
    expect(() => defineWithPermissions(['admin'])).toThrow(
      'defineApplicationManifest: protocols[0].permissions[0] has unsupported permission \'admin\'. ' +
      'Supported permissions: read, write, delete.',
    );
    expect(() => defineWithPermissions(['write', 'read', 'write'])).toThrow(
      'defineApplicationManifest: protocols[0].permissions contains duplicate permission \'write\' at indexes 0 and 2.',
    );
  });

  it('should reject malformed runtime TypedProtocol values at their stable index', () => {
    const malformedProtocols = [
      {
        definition : { structure: NotesDefinition.structure, types: NotesDefinition.types },
        codecs     : NotesProtocol.codecs,
      },
      {
        definition : { protocol: NotesDefinition.protocol, structure: NotesDefinition.structure },
        codecs     : NotesProtocol.codecs,
      },
      {
        definition : { ...NotesDefinition, types: [] },
        codecs     : NotesProtocol.codecs,
      },
      {
        definition : { protocol: NotesDefinition.protocol, types: NotesDefinition.types },
        codecs     : NotesProtocol.codecs,
      },
      {
        definition : NotesDefinition,
        codecs     : { note: { encode: NotesProtocol.codecs.note.encode } },
      },
      {
        definition : NotesDefinition,
        codecs     : {},
      },
      {
        definition: {
          protocol  : NotesDefinition.protocol,
          structure : NotesDefinition.structure,
          types     : NotesDefinition.types,
        },
        codecs: NotesProtocol.codecs,
      },
      {
        definition : { ...NotesDefinition, types: {} },
        codecs     : NotesProtocol.codecs,
      },
      {
        definition : { ...NotesDefinition, structure: { note: true } },
        codecs     : NotesProtocol.codecs,
      },
    ];

    for (const malformed of malformedProtocols) {
      expect(() => defineApplicationManifest({
        protocols: [NotesProtocol, malformed as unknown as typeof NotesProtocol],
      })).toThrow('defineApplicationManifest: protocols[1] must be a TypedProtocol.');
    }
  });

  it('should reject duplicate protocol URIs with stable indexes', () => {
    const reorderedDefinition = {
      structure : NotesDefinition.structure,
      types     : NotesDefinition.types,
      published : NotesDefinition.published,
      protocol  : NotesDefinition.protocol,
    } as const satisfies ProtocolDefinition;
    const reorderedProtocol = defineProtocol(reorderedDefinition, NotesProtocol.codecs);

    expect(() => defineApplicationManifest({
      protocols: [NotesProtocol, reorderedProtocol],
    })).toThrow(
      'defineApplicationManifest: duplicate protocol URI \'https://example.com/protocols/notes\' at indexes 0 and 1.',
    );
  });

  it('should reject conflicting definitions for the same protocol URI with stable indexes', () => {
    const conflictingDefinition = {
      ...NotesDefinition,
      published: false,
    } as const satisfies ProtocolDefinition;
    const conflictingProtocol = defineProtocol(conflictingDefinition, NotesProtocol.codecs);

    expect(() => defineApplicationManifest({
      protocols: [NotesProtocol, conflictingProtocol],
    })).toThrow(
      'defineApplicationManifest: conflicting definitions for protocol URI \'https://example.com/protocols/notes\' at indexes 0 and 1.',
    );
  });
});
