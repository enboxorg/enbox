import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type {
  ContextRecordsApi,
  ContextRootPath,
  Enbox,
  ModuleAttachmentPaths,
  ModuleContextAttachmentPath,
  ModulePaths,
  TypedModule,
} from '@enbox/api';

import { defineModule, recordCodecs } from '@enbox/api';

type Assert<Condition extends true> = Condition;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;

const Notebook = defineModule({
  definition: {
    module    : 'https://example.com/attachments/notebook',
    published : true,
    types     : {
      notebook : { dataFormats: ['application/json'] },
      page     : { dataFormats: ['application/json'], encryptionRequired: true },
      member   : { dataFormats: ['application/json'] },
    },
    structure: {
      notebook: {
        page: {
          $actions : [{ role: 'notebook/page/member', can: ['read'] }],
          member   : { $role: true },
        },
      },
    },
  },
  codecs: {
    notebook : recordCodecs.json<{ title: string }>(),
    page     : recordCodecs.json<{ title: string }>(),
    member   : recordCodecs.json<object>(),
  },
});

const OtherNotebook = defineModule({
  definition : { ...Notebook.definition, module: 'https://example.com/attachments/other-notebook' },
  codecs     : Notebook.codecs,
});

// @ts-expect-error Graphs are derived from definitions; artifacts do not retain a second graph representation.
Notebook.resolvedGraph;

const Realtime = defineModule({
  definition: {
    module    : 'https://example.com/attachments/realtime',
    published : true,
    uses      : { base: Notebook.definition.module },
    types     : {
      live    : { dataFormats: ['application/json'], encryptionRequired: true },
      session : { dataFormats: ['application/json'] },
      marker  : { dataFormats: ['text/plain'] },
    },
    structure: {
      page: {
        $ref : 'base:notebook/page',
        live : {
          $recordLimit : { max: 1 },
          $actions     : [{ role: 'base:notebook/page/member', can: ['read'] }],
          session      : { $actions: [{ role: 'base:notebook/page/member', can: ['create', 'read'] }] },
        },
      },
      folder: { $ref: 'base:notebook', marker: {} },
    },
  },
  codecs: {
    live    : recordCodecs.json<{ topic: string }>(),
    session : recordCodecs.json<{ peerKey: string }>(),
    marker  : recordCodecs.text(),
  },
  dependencies: { base: Notebook },
});

const _Activity = defineModule({
  definition: {
    module    : 'https://example.com/attachments/activity',
    published : true,
    uses      : { realtime: Realtime.definition.module, base: OtherNotebook.definition.module },
    types     : { event: { dataFormats: ['text/plain'] } },
    structure : {
      note : { $ref: 'realtime:page', event: {} },
      room : { $ref: 'realtime:page/live', event: {} },
    },
  },
  codecs       : { event: recordCodecs.text() },
  dependencies : { realtime: Realtime, base: OtherNotebook },
});

type _DeepAttachment = Assert<Equal<
  ModuleAttachmentPaths<typeof Realtime, typeof Notebook.definition.module, 'notebook/page'>,
  'page'
>>;
type _RootAttachment = Assert<Equal<
  ModuleAttachmentPaths<typeof Realtime, typeof Notebook.definition.module, 'notebook'>,
  'folder'
>>;
type _AliasChainUsesItsOwnDependencies = Assert<Equal<
  ModuleAttachmentPaths<typeof _Activity, typeof Notebook.definition.module, 'notebook/page'>,
  'note'
>>;
type _OuterAliasDoesNotRetargetTheChain = Assert<Equal<
  ModuleAttachmentPaths<typeof _Activity, typeof OtherNotebook.definition.module, 'notebook/page'>,
  never
>>;
type _ConcreteConsumerDescendantOwnsItsAddress = Assert<Equal<
  ModuleAttachmentPaths<typeof _Activity, typeof Realtime.definition.module, 'page/live'>,
  'room'
>>;
type _PhysicalParentDoesNotOwnTheConsumerRecord = Assert<Equal<
  ModuleAttachmentPaths<typeof _Activity, typeof Notebook.definition.module, 'notebook/page/live'>,
  never
>>;
type _WrongOwningPath = Assert<Equal<
  ModuleAttachmentPaths<typeof Realtime, typeof Notebook.definition.module, 'page'>,
  never
>>;
type _NativeRecordsAreNotAttachments = Assert<Equal<
  ModuleAttachmentPaths<typeof Notebook, typeof Notebook.definition.module, 'notebook/page'>,
  never
>>;
type _MatchingRootUnion = Assert<Equal<
  ModuleAttachmentPaths<typeof Realtime, typeof Notebook.definition.module, 'notebook' | 'notebook/page'>,
  'page' | 'folder'
>>;
type _ContextAttachmentDirect = Assert<Equal<
  ModuleContextAttachmentPath<typeof Realtime, typeof Notebook.definition.module, 'notebook/page'>,
  'page'
>>;
type _ContextAttachmentAmbiguousMultiRefUnderSameRootIsNever = Assert<Equal<
  ModuleContextAttachmentPath<typeof Realtime, typeof Notebook.definition.module, 'notebook'>,
  never
>>;
type _ContextAttachmentDescendantSingleRef = Assert<Equal<
  ModuleContextAttachmentPath<{
    readonly definition: {
      readonly module: 'https://example.com/attachments/comments';
      readonly published: true;
      readonly uses: { readonly base: typeof Notebook.definition.module };
      readonly types: { readonly comment: { readonly dataFormats: ['text/plain'] } };
      readonly structure: { readonly page: { readonly $ref: 'base:notebook/page'; readonly comment: {} } };
    };
    readonly codecs: { comment: typeof _Activity.codecs.event };
    readonly dependencies: { readonly base: typeof Notebook };
  }, typeof Notebook.definition.module, 'notebook'>,
  'page'
>>;

// An attachment exposes only its declared local descendants, never a provider's undeclared child.
type InvalidImportedChild = TypedModule<{
  readonly module: 'https://example.com/attachments/invalid-child';
  readonly published: true;
  readonly uses: { readonly realtime: typeof Realtime.definition.module };
  readonly types: { readonly event: { readonly dataFormats: ['text/plain'] } };
  readonly structure: { readonly membership: { readonly $ref: 'realtime:page/member'; readonly event: {} } };
}, { event: typeof _Activity.codecs.event }, { realtime: typeof Realtime }>;
type _CannotTraverseUndeclaredImportedChildren = Assert<Equal<
  ModuleAttachmentPaths<InvalidImportedChild, typeof Notebook.definition.module, 'notebook/page/member'>,
  never
>>;

type CyclicModule = {
  readonly definition: {
    readonly module: 'https://example.com/attachments/cycle';
    readonly published: true;
    readonly uses: { readonly self: 'https://example.com/attachments/cycle' };
    readonly types: { readonly event: { readonly dataFormats: ['text/plain'] } };
    readonly structure: { readonly page: { readonly $ref: 'self:page'; readonly event: {} } };
  };
  readonly codecs: { event: typeof _Activity.codecs.event };
  readonly dependencies: { readonly self: CyclicModule };
};
type _CyclesTerminate = Assert<Equal<
  ModuleAttachmentPaths<CyclicModule, typeof Notebook.definition.module, 'notebook/page'>,
  never
>>;
type _WidenedDefinitionIsRuntimeChecked = Assert<Equal<
  ModuleAttachmentPaths<TypedModule<ModuleDefinition>, string, string>,
  string
>>;

type _NativeContextRootsStayNative = Assert<Equal<ContextRootPath<typeof Notebook.definition>, 'notebook/page'>>;
type _AttachmentsDoNotBecomeNativeContextRoots = Assert<Equal<ContextRootPath<typeof Realtime.definition>, never>>;
type _ConsumerRecordPathsStayLocal = Assert<Equal<
  ModulePaths<typeof Realtime.definition>, 'page/live' | 'page/live/session' | 'folder/marker'
>>;
type _ConsumerCodecsRemainExact = Assert<Equal<
  Awaited<ReturnType<typeof Realtime.codecs.live.decode>>, { topic: string }
>>;


export async function contextModuleBindingContract(enbox: Enbox): Promise<void> {
  type MountPath = ModuleAttachmentPaths<typeof Realtime, typeof Notebook.definition.module, 'notebook/page'>;
  const mount: MountPath = 'page';
  const realtimeRecords: ContextRecordsApi<
    typeof Realtime.definition,
    typeof Realtime.codecs,
    MountPath
  > = enbox.using(Realtime).scope({
    allowedPaths : new Set(['page/live', 'page/live/session']),
    contextId    : 'notebook/page',
    contextPath  : mount,
  });
  const live = await realtimeRecords.query('page/live', { materialize: true, pagination: { limit: 1 } });
  const topic: string | undefined = live.records[0]?.value.topic;
  const session = await realtimeRecords.create('page/live/session', { data: { peerKey: 'peer' }, parentContextId: 'notebook/page/live' });
  const peerKey: string = (await session.value()).peerKey;
  // @ts-expect-error a reference anchor has no record surface in its consumer module
  await realtimeRecords.read('page', { filter: {} });
  // @ts-expect-error this binding excludes another physical root in the same consumer artifact
  await realtimeRecords.query('folder/marker');
  // @ts-expect-error provider-owned records stay on the root context
  await realtimeRecords.query('notebook/page');
  // @ts-expect-error the consumer codec is preserved through scoped records
  await realtimeRecords.create('page/live/session', { data: { title: 'wrong' }, parentContextId: 'notebook/page/live' });
  // @ts-expect-error observations always require an explicitly bounded request
  await realtimeRecords.observe('page/live');
  // @ts-expect-error callers cannot supply a different tenant on a bound consumer view
  await realtimeRecords.query('page/live', { from: 'did:example:other' });
  // @ts-expect-error callers cannot replace the canonical role selected for the consumer
  await realtimeRecords.query('page/live', { moduleRole: 'base:notebook/page/member' });
  await realtimeRecords.set('page/live', { data: { topic: 'owner-room' } });
  void topic;
  void peerKey;
}
