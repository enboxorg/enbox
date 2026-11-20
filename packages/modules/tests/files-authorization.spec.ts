import type { ModuleTestActor } from './utils/module-test-world.js';
import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { FilesModule } from '../src/files.js';
import { ModuleTestWorld } from './utils/module-test-world.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, Encoder, RecordsDelete, RecordsRead, RecordsWrite } from '@enbox/dwn-sdk-js';

describe('Files participant authority', () => {
  let world: ModuleTestWorld;
  let owner: ModuleTestActor;
  let viewer: ModuleTestActor;
  let otherViewer: ModuleTestActor;
  let editor: ModuleTestActor;
  let fileContextId: string;
  let viewerRole: RecordsWriteMessage;
  let otherViewerRole: RecordsWriteMessage;

  async function remove(recordId: string, who: ModuleTestActor, moduleRole?: string, prune = false): Promise<number> {
    const request = await RecordsDelete.create({ recordId, signer: who.signer, moduleRole, prune });
    const reply = await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message);
    return reply.status.code;
  }

  async function content(who: ModuleTestActor): Promise<RecordsWriteMessage> {
    const result = await world.write({
      actor           : who,
      definition      : FilesModule.definition,
      path            : 'file/content',
      parentContextId : fileContextId,
      data            : new Blob(['a revision'], { type: 'application/octet-stream' }),
      moduleRole      : who === owner ? undefined : 'file/editor',
    });
    expect(result.reply.status.code, result.reply.status.detail).toBe(202);
    return result.message!;
  }

  async function readAsOwner(recordId: string): Promise<number> {
    const request = await RecordsRead.create({ filter: { recordId }, signer: owner.signer });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }

  beforeAll(async () => {
    world = await ModuleTestWorld.create([FilesModule.definition]);
    [owner, editor, viewer, otherViewer] = world.actors;
    const file = await world.write({
      actor      : owner,
      definition : FilesModule.definition,
      path       : 'file',
      data       : new Blob([JSON.stringify({ name: 'shared.txt', mediaType: 'text/plain' })], { type: 'application/json' }),
    });
    expect(file.reply.status.code, file.reply.status.detail).toBe(202);
    fileContextId = file.message!.contextId!;
    viewerRole = await world.assign(FilesModule.definition, 'file/viewer', fileContextId, viewer);
    otherViewerRole = await world.assign(FilesModule.definition, 'file/viewer', fileContextId, otherViewer);
    await world.assign(FilesModule.definition, 'file/editor', fileContextId, editor);
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it('does not let a viewer delete another viewer, with or without role invocation', async () => {
    expect(await remove(otherViewerRole.recordId, viewer)).toBe(401);
    expect(await remove(otherViewerRole.recordId, viewer, 'file/viewer')).toBe(401);
    expect(await remove(otherViewerRole.recordId, editor, 'file/editor')).toBe(401);
    expect(await readAsOwner(otherViewerRole.recordId)).toBe(200);
  });

  it('does not let a viewer mint membership or edit another role assignment', async () => {
    const bytes = Encoder.objectToBytes({});
    const forged = await RecordsWrite.create({
      module          : FilesModule.definition.module,
      modulePath      : 'file/editor',
      parentContextId : fileContextId,
      recipient       : viewer.did,
      schema          : FilesModule.definition.types.editor.schema,
      dataFormat      : 'application/json',
      data            : bytes,
      signer          : viewer.signer,
    });
    const denied = await world.owner.harness.agent.dwn.node.processMessage(owner.did, forged.message, {
      dataStream: DataStream.fromBytes(bytes),
    });
    expect(denied.status.code).toBe(401);
    const updated = await RecordsWrite.createFrom({ recordsWriteMessage: otherViewerRole, signer: viewer.signer });
    const updateReply = await world.owner.harness.agent.dwn.node.processMessage(owner.did, updated.message);
    expect(updateReply.status.code).not.toBe(202);
  });

  it('lets a viewer read content but never delete or prune it', async () => {
    const revision = await content(owner);
    const read = await RecordsRead.create({ filter: { recordId: revision.recordId }, signer: viewer.signer, moduleRole: 'file/viewer' });
    const reply = await world.owner.harness.agent.dwn.node.processMessage(owner.did, read.message);
    expect(reply.status.code).toBe(200);
    expect(await remove(revision.recordId, viewer, 'file/viewer')).toBe(401);
    expect(await remove(revision.recordId, viewer, 'file/viewer', true)).toBe(401);
  });

  it('lets an editor delete only revisions it authored', async () => {
    const theirs = await content(owner);
    expect(await remove(theirs.recordId, editor, 'file/editor')).toBe(401);
    const mine = await content(editor);
    expect(await remove(mine.recordId, editor, 'file/editor')).toBe(202);
    expect(await remove(fileContextId, editor, 'file/editor', true)).toBe(401);
  });

  it('lets the recipient leave its own role and keeps owner revocation authority', async () => {
    expect(await remove(viewerRole.recordId, viewer)).toBe(202);
    expect(await readAsOwner(otherViewerRole.recordId)).toBe(200);
    expect(await remove(otherViewerRole.recordId, owner)).toBe(202);
  });
});
