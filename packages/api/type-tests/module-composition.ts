import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { Enbox, ModulePaths, ModuleRolePaths } from '@enbox/api';

import { defineModule, recordCodecs } from '@enbox/api';

const Base = defineModule({
  definition: {
    module    : 'https://example.com/type-tests/base',
    published : true,
    types     : {
      folder : { dataFormats: ['application/json'] },
      note   : { dataFormats: ['application/json'] },
      member : { dataFormats: ['application/json'] },
    },
    structure: {
      folder: {
        note   : {},
        member : { $role: true },
      },
    },
  },
  codecs: {
    folder : recordCodecs.json<{ title: string }>(),
    note   : recordCodecs.json<{ title: string }>(),
    member : recordCodecs.json<object>(),
  },
});

const Definition = {
  module    : 'https://example.com/type-tests/extension',
  published : true,
  uses      : { base: Base.definition.module },
  types     : {
    comment : { dataFormats: ['application/json'] },
    local   : { dataFormats: ['application/json'] },
    note    : { dataFormats: ['text/plain'] },
    unused  : { dataFormats: ['application/json'] },
  },
  structure: {
    note: {
      $ref    : 'base:folder/note',
      comment : {},
    },
    local: { note: {} },
  },
} as const satisfies ModuleDefinition;

const Codecs = {
  comment : recordCodecs.json<{ text: string }>(),
  local   : recordCodecs.json<object>(),
  note    : recordCodecs.text(),
};
const Extension = defineModule({ definition: Definition, codecs: Codecs, dependencies: { base: Base } });

declare const enbox: Enbox;
const extension = enbox.using(Extension);
const written: Promise<{ text: string }> = extension.records.create('note/comment', {
  parentContextId : 'folderId/noteId',
  data            : { text: 'hello' },
}).then(record => record.value());
const local: Promise<string> = extension.records.create('local/note', {
  parentContextId : 'localId',
  data            : 'local text representation',
}).then(record => record.value());
void written;
void local;

const path: ModulePaths<typeof Definition> = 'note/comment';
const role: ModuleRolePaths<typeof Definition, typeof Extension.dependencies> = 'base:folder/member';
void path;
void role;

// @ts-expect-error imported attachment nodes are not local record paths.
extension.records.create('note', { data: 'shadow' });
// @ts-expect-error base-record reads go through the owning module.
extension.records.read('note', 'id');
// @ts-expect-error base-record queries go through the owning module.
extension.records.query('note');
// @ts-expect-error local record values use their own codec, not the imported same-name type.
extension.records.create('local/note', { parentContextId: 'localId', data: { title: 'foreign value' } });
// @ts-expect-error unknown paths are excluded.
extension.records.query('note/unknown');
// @ts-expect-error codecs are mandatory.
defineModule({ definition: Definition, dependencies: { base: Base } });
// @ts-expect-error declared uses aliases require dependencies.
defineModule({ definition: Definition, codecs: Codecs });
// @ts-expect-error every local reachable type needs a codec.
defineModule({ definition: Definition, codecs: { comment: Codecs.comment }, dependencies: { base: Base } });
// @ts-expect-error unused type entries do not require or accept a codec.
defineModule({ definition: Definition, codecs: { ...Codecs, unused: recordCodecs.json() }, dependencies: { base: Base } });
// @ts-expect-error undeclared aliases are rejected.
defineModule({ definition: Definition, codecs: Codecs, dependencies: { base: Base, extra: Base } });
// @ts-expect-error the dependency URI must match the declared alias target.
defineModule({ definition: Definition, codecs: Codecs, dependencies: { base: Extension } });

const _RoleAttachment = defineModule({
  definition: {
    module    : 'https://example.com/type-tests/role-attachment',
    published : true,
    uses      : { base: Base.definition.module },
    types     : { receipt: { dataFormats: ['text/plain'] } },
    structure : { membership: { $ref: 'base:folder/member', receipt: {} } },
  },
  codecs       : { receipt: recordCodecs.text() },
  dependencies : { base: Base },
});
const attachedRole: ModuleRolePaths<typeof _RoleAttachment.definition, typeof _RoleAttachment.dependencies> = 'membership';
void attachedRole;
