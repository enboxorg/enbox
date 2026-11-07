# Module inheritance and composition

Data modules share record structure and access rules through explicit dependencies.
Each record keeps one owning module, declared path, and tenant. A dependency does
not grant access to its data or copy its action rules into another module.

This format requires the [module vocabulary cutover](MODULE-CUTOVER.md).

## Attach records to an existing parent

An extension declares `uses` aliases and a root `$ref` attachment. Its local
children retain the extension's module URI. The referenced parent keeps its
original module URI, path, record ID, and context.

```json
{
  "module": "https://example.org/modules/notes/discussion/v1",
  "published": true,
  "uses": { "core": "https://example.org/modules/notes/core/v1" },
  "types": {
    "comment": { "dataFormats": ["application/json"], "encryptionRequired": true }
  },
  "structure": {
    "note": {
      "$ref": "core:notebook/note",
      "comment": {
        "$actions": [
          { "role": "core:notebook/editor", "can": ["create", "read", "update", "delete"] }
        ]
      }
    }
  }
}
```

Only root structure nodes can declare `$ref`. A target can be a deep path or a
record in another extension. References add no context segment and do not import
the provider's undeclared child paths. An attachment must declare local children;
no record can be written at the attachment itself, including by the tenant.
Explicit attachment `$actions` do not grant authority over the provider record.

Aliases resolve in the definition declaring them. Each alias names a distinct
module URI, and each attachment in a definition must resolve to a distinct
physical parent. Put multiple local feature types under the same attachment when
they share a parent. Dependency cycles and attachments to squashable ancestry
are rejected.

The example's comment has declared path `note/comment` but physical context
`notebookId/noteId/commentId`. Parent validation, role scope, encryption,
replication, and typed queries use the resolved physical ancestry. Trees are
limited to ten physical record levels.

## Typed definitions and operations

`defineModule` accepts one options object. Supply a codec for each reachable local
record type, including local roles. Attachments and unused type declarations need
no codec. Supply exactly the typed dependency artifacts named by `uses`.

```ts
type CommentData = { text: string };

const Discussion = defineModule({
  definition: DiscussionDefinition,
  codecs: { comment: recordCodecs.json<CommentData>() },
  dependencies: { core: Core },
});

const discussion = enbox.using(Discussion);
const comment = await discussion.records.create('note/comment', {
  from: aliceDid,
  parentContextId: noteContextId,
  moduleRole: 'core:notebook/editor',
  data: { text: 'A comment on the existing note.' },
});
const comments = await discussion.records.query('note/comment', {
  from: aliceDid,
  within: noteContextId,
  moduleRole: 'core:notebook/editor',
});
```

Use the owning module binding for operations on the base note. Extension queries
return that extension's records; they do not automatically combine every module
attached to a parent. Dependency installation runs providers before consumers
and does not issue operation grants or private key material implicitly.

## Sharing and updates

Role and actor references resolve to an exact owning URI/path and actual context.
An actor's `of` target can be an ordinary record. A role target must be a role
record. Roles from sibling contexts cannot supply authority. Root roles apply
within their source tenant without creating a physical parent.

Encrypted consumers use the provider's exact role-audience namespace. Plaintext
modules declaring roles still receive the key-agreement metadata needed by
encrypted consumers. Delegates need approved access to the provider when fetching
its role records or key deliveries; a consumer grant is not reused as a provider
grant. Previously accepted audience keys remain usable within their scope.

A same-URI update preserves imported parent representations, physical bindings,
role identities, and actor ancestry. Updates that break direct or transitive
dependents are rejected, even before child records exist. Unrelated policies and
runtime key metadata are not whole-definition pins. Existing alias bindings and
attachment identities cannot be renamed or retargeted in place. A different
versioned URI is a different module.

Historical configurations retain governing-time validation. A historical import
that does not become active is not substituted into current dependents. A first
installation that becomes active must also have a valid current dependency graph.

Owner sync must include the provider and consumer modules. Application-backed
`ConnectionStore` defaults resolve the typed dependency graph and retained local
configuration history, then reconcile the scope after installation and pulls.
Explicit URI arrays remain exact. Delegates need approved feed grants for every
module in the scope and provider read access for role verification and key
delivery; installing a dependency does not grant access to its records.

The transport integration tests use separate local stores and a real HTTP and
WebSocket DWN. They cover cold replication, missing-reference repair, encrypted
owner and delegated reads, sync-engine restart with durable checkpoints, queued
offline ciphertext, cross-module pruning, and writes committed during a socket
disconnect. Typed API tests exercise scoped observation and child mutations on
the replicated graph. All four examples below also round-trip through cold owner
replicas using their literal JSON definitions.

## Follow a context with selected extensions

The managed context root and its roles stay in the provider module. Applications
can explicitly select extensions attached to that exact root:

```ts
const contexts = enbox.using(NotebookModule).contexts.withModules({
  realtime: NotebookRealtimeModule,
});
const page = await contexts.follow('notebook/page', { ownerDid, id: pageContextId });
const realtime = page.using(NotebookRealtimeModule);
const adverts = await realtime.records.observe('page/live', {
  pagination: { limit: 1 },
});
```

`withModules` also applies to owned contexts, invitation acceptance, and contexts
restored by `list` or `observe`. Selection and `using` do not follow a context or
write a follow decision. The recipient still has one root follow/forget journal
and one local acceptance. Another device restores that root decision and applies
its own application's explicit module selection. Installed reverse dependencies
are never selected implicitly.

For a member, each extension gets a separate replication link at the root's
accepted owner endpoint. The owner must publish the extension definition. The SDK
verifies its dependency graph, exact attachment, and readable concrete paths
against the same owner-hosted role record used for the root. A delegate also needs
approved consumer feed and record-read grants; provider grants are not repurposed
as consumer grants. Empty extensions can be verified before their first record
is written.

Encrypted consumers also need query access to the provider definitions used by
the audience-key loader. Public providers satisfy this requirement. Private
provider metadata received through replication support alone is currently
insufficient for that loader ([tracked separately](https://github.com/enboxorg/enbox/issues/1834)).

Root readiness is independent of optional extensions. Missing metadata, grants,
or keys leave an extension unavailable without blocking the root. Consumer views
report their own readiness and currentness, then recover through sync events when
the extension becomes available. Retained records and direct bindings remain
fenced to their verified authority. Forgetting or replacing the root acceptance
retires every associated link and handle.

Bindings constrain child operations to that context and use the consumer's
declared paths, such as `page/live/session`. A `$ref` attachment is still not a
record. Observe provider and consumer records with separate views;
`materialize.children` remains within one module. This managed API supports
extensions attached to the exact selected root, including reference chains that
resolve to it, rather than arbitrary descendant attachments.

Composition does not add a cross-owner tree, exact path-and-context grant
intersections, historical role membership, or narrower private-key custody.
Unsupported authority or proof combinations fail explicitly. Signed offline
messages keep their timestamps, identities, and ciphertext under the existing
shared-engine rules.

## Complete examples

The checked-in fixtures are exercised by resolver and integration tests:

- [Notes](../packages/dwn-sdk-js/tests/vectors/module-composition/notes): core notebooks and notes, optional files, and discussion.
- [Project board](../packages/dwn-sdk-js/tests/vectors/module-composition/project-board): workspace, boards/tasks, and activity.
- [Team chat](../packages/dwn-sdk-js/tests/vectors/module-composition/team-chat): teams/channels, messages, and message extras.
- [Event planner](../packages/dwn-sdk-js/tests/vectors/module-composition/event-planner): plaintext role provider and encrypted planning, agenda, and session comments.
