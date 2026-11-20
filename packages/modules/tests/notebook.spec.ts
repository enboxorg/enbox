import type { ModuleTestActor } from './utils/module-test-world.js';
import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { createYjs1Doc } from '@enbox/crdt/yjs1';
import { ModuleTestWorld } from './utils/module-test-world.js';
import { readFile } from 'node:fs/promises';
import { recordCodecs } from '@enbox/api';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, RecordsDelete, RecordsRead, RecordsWrite } from '@enbox/dwn-sdk-js';
import { exampleValue, expectExample, recordData } from './utils/record-examples.js';
import { NotebookCatalog, NotebookCodecs, NotebookDefinition } from '../src/notebook.js';
import { NotebookRealtimeCodecs, NotebookRealtimeDefinition } from '../src/notebook-realtime.js';

function deltaBytes(): Uint8Array {
  return exampleValue(NotebookCatalog.examples.find((example): boolean => example.path === 'notebook/page/delta')!) as Uint8Array;
}

describe('notesd interoperability', () => {
  it('preserves the executable notesd v1 wire definitions at the pinned source commit', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/notesd-notebook-v1.json', import.meta.url), 'utf8'));
    expect(fixture.commit).toBe('377645c881b0d1a86710130957cc5d583b249c8f');
    expect(NotebookDefinition).toEqual(fixture.notebook);
    expect(NotebookRealtimeDefinition).toEqual(fixture.realtime);
    expect(NotebookCodecs.attachment.maxEncodedBytesFor(50_000_000)).toBe(fixture.attachmentMaxBytes);
  });

  it('materializes the published delta example through the same CRDT implementation as notesd', () => {
    const document = createYjs1Doc();
    try {
      document.applyDurable(deltaBytes(), { recordId: 'example' });
      expect(document.getText()).toBe('Take the morning train.');
    } finally {
      document.destroy();
    }
  });

  it('exchanges attachment envelopes with notesd and rejects raw unframed bytes', async () => {
    const notesdCodec = recordCodecs.fileEnvelope({ formatId: 'notesd', maxContentBytes: 50_000_000 });
    const example = NotebookCatalog.examples.find((example): boolean => example.path === 'notebook/page/attachment')!;
    const value = exampleValue(example) as Parameters<typeof notesdCodec.encode>[0];
    const encoded = await NotebookCodecs.attachment.encode(value);
    await expectExample(await notesdCodec.decode(recordData(encoded.data), encoded.dataFormat), value, example);
    const fromNotesd = await notesdCodec.encode(value);
    await expectExample(await NotebookCodecs.attachment.decode(recordData(fromNotesd.data), fromNotesd.dataFormat), value, example);
    await expect(NotebookCodecs.attachment.decode(recordData(new Blob(['raw content'])), 'application/octet-stream')).rejects.toThrow();
  });

  it('accepts notesd empty page titles and transport-neutral rendezvous keys', async () => {
    expect(await (await NotebookCodecs.page.encode({ title: '' })).data.text()).toBe('{"title":""}');
    expect(() =>
      NotebookRealtimeCodecs.live.encode({
        transport : 'custom',
        endpoint  : 'local',
        topic     : 'page',
        topicKey  : 'base64-secret',
        peerKey   : 'peer',
      }),
    ).not.toThrow();
  });
});

describe('notebook and composed realtime authority', () => {
  let world: ModuleTestWorld;
  let owner: ModuleTestActor;
  let admin: ModuleTestActor;
  let editor: ModuleTestActor;
  let viewer: ModuleTestActor;
  let page: RecordsWriteMessage;
  let sibling: RecordsWriteMessage;
  let editorRole: RecordsWriteMessage;
  let viewerRole: RecordsWriteMessage;

  async function read(who: ModuleTestActor, recordId: string, moduleRole?: string): Promise<number> {
    const request = await RecordsRead.create({ filter: { recordId }, signer: who.signer, moduleRole });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }

  async function remove(who: ModuleTestActor, recordId: string, moduleRole: string, prune = false): Promise<number> {
    const request = await RecordsDelete.create({ recordId, signer: who.signer, moduleRole, prune });
    return (await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message)).status.code;
  }

  beforeAll(async () => {
    world = await ModuleTestWorld.create([NotebookDefinition, NotebookRealtimeDefinition]);
    [owner, admin, editor, viewer] = world.actors;
    const notebook = await world.write({
      actor      : owner,
      definition : NotebookDefinition,
      path       : 'notebook',
      data       : (await NotebookCodecs.notebook.encode({ name: 'Shared notebook' })).data,
    });
    for (const title of ['Shared page', 'Private sibling']) {
      const result = await world.write({
        actor           : owner,
        definition      : NotebookDefinition,
        path            : 'notebook/page',
        parentContextId : notebook.message!.contextId,
        data            : (await NotebookCodecs.page.encode({ title })).data,
      });
      expect(result.reply.status.code, result.reply.status.detail).toBe(202);
      if (title === 'Shared page') {
        page = result.message!;
      } else {
        sibling = result.message!;
      }
    }
    await world.assign(NotebookDefinition, 'notebook/page/admin', page.contextId!, admin);
    editorRole = await world.assign(NotebookDefinition, 'notebook/page/editor', page.contextId!, editor);
    viewerRole = await world.assign(NotebookDefinition, 'notebook/page/viewer', page.contextId!, viewer);
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it('exposes writer assignments to page members without exposing another viewer or sibling page', async () => {
    expect(await read(viewer, editorRole.recordId, 'notebook/page/viewer')).toBe(200);
    expect(await read(editor, viewerRole.recordId, 'notebook/page/editor')).toBe(401);
    expect(await read(editor, sibling.recordId, 'notebook/page/editor')).toBe(401);
    expect(await remove(editor, viewerRole.recordId, 'notebook/page/editor')).toBe(401);
  });

  it('lets editors append encrypted CRDT updates, reserves compaction to admins, and rejects mutation', async () => {
    const update = {
      definition      : NotebookDefinition,
      path            : 'notebook/page/delta',
      parentContextId : page.contextId,
      data            : new Blob([Uint8Array.from(deltaBytes())]),
    };
    const result = await world.write({ ...update, actor: editor, moduleRole: 'notebook/page/editor' });
    expect(result.reply.status.code, result.reply.status.detail).toBe(202);
    const edited = await RecordsWrite.createFrom({
      recordsWriteMessage : result.message!,
      signer              : editor.signer,
      moduleRole          : 'notebook/page/editor',
    });
    const denied = await world.owner.harness.agent.dwn.node.processMessage(owner.did, edited.message);
    expect(denied.status.code).toBe(400);
    expect(denied.status.detail).toContain('Immutable');
    expect(await remove(editor, result.message!.recordId, 'notebook/page/editor')).toBe(401);
    const editorSquash = await world.write({ ...update, actor: editor, moduleRole: 'notebook/page/editor', squash: true });
    expect(editorSquash.reply.status.code).toBe(401);
    const snapshot = await world.write({ ...update, actor: admin, moduleRole: 'notebook/page/admin', squash: true });
    expect(snapshot.reply.status.code, snapshot.reply.status.detail).toBe(202);
    expect(await read(viewer, snapshot.message!.recordId, 'notebook/page/viewer')).toBe(200);
  });

  it('limits attachment deletion to its author and prevents page pruning by members', async () => {
    const encoded = await NotebookCodecs.attachment.encode({ filename: 'note.txt', mimeType: 'text/plain', blob: new Blob(['hello']) });
    const attachment = await world.write({
      actor           : editor,
      definition      : NotebookDefinition,
      path            : 'notebook/page/attachment',
      parentContextId : page.contextId,
      moduleRole      : 'notebook/page/editor',
      data            : encoded.data,
    });
    expect(attachment.reply.status.code, attachment.reply.status.detail).toBe(202);
    expect(await remove(admin, attachment.message!.recordId, 'notebook/page/admin')).toBe(401);
    expect(await remove(admin, page.recordId, 'notebook/page/admin', true)).toBe(401);
    expect(await remove(editor, attachment.message!.recordId, 'notebook/page/editor')).toBe(202);
  });

  it('reuses provider roles for realtime sessions and protects the owner rendezvous', async () => {
    const data = (await NotebookRealtimeCodecs.live.encode({
      transport : 'custom',
      endpoint  : 'local',
      topic     : 'page',
      topicKey  : 'test-key',
      peerKey   : 'owner-peer',
    })).data;
    const live = await world.write({
      actor           : owner,
      definition      : NotebookRealtimeDefinition,
      path            : 'page/live',
      parentContextId : page.contextId,
      data,
    });
    expect(live.reply.status.code, live.reply.status.detail).toBe(202);
    const otherLive = await world.write({
      actor           : owner,
      definition      : NotebookRealtimeDefinition,
      path            : 'page/live',
      parentContextId : sibling.contextId,
      data,
    });
    expect(otherLive.reply.status.code).toBe(202);
    const role = 'notebook:notebook/page/editor';
    expect(await read(editor, live.message!.recordId, role)).toBe(200);
    expect(await read(editor, otherLive.message!.recordId, role)).toBe(401);
    const hijack = await world.write({
      actor           : editor,
      definition      : NotebookRealtimeDefinition,
      path            : 'page/live',
      parentContextId : page.contextId,
      data,
      moduleRole      : role,
    });
    expect(hijack.reply.status.code).toBe(401);
    const session = await world.write({
      actor           : editor,
      definition      : NotebookRealtimeDefinition,
      path            : 'page/live/session',
      parentContextId : live.message!.contextId,
      data            : (await NotebookRealtimeCodecs.session.encode({ peerKey: 'editor-peer' })).data,
      moduleRole      : role,
    });
    expect(session.reply.status.code, session.reply.status.detail).toBe(202);
    expect(session.message!.encryption).toBeUndefined();
    expect(await remove(admin, session.message!.recordId, 'notebook:notebook/page/admin')).toBe(401);
    expect(await remove(editor, session.message!.recordId, role)).toBe(202);
    // The role recipient decrypts the actual foreign-module audience envelope.
    const request = await RecordsRead.create({ filter: { recordId: live.message!.recordId }, signer: editor.signer, moduleRole: role });
    const reply = await world.owner.harness.agent.dwn.node.processMessage(owner.did, request.message);
    const plaintext = await editor.harness.agent.dwn.decryptRecordData({
      author       : editor.did,
      target       : owner.did,
      recordsWrite : live.message!,
      moduleRole   : role,
      dataStream   : reply.entry!.data!,
    });
    expect(JSON.parse(new TextDecoder().decode(await DataStream.toBytes(plaintext))).topic).toBe('page');
  });
});
