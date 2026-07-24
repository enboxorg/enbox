import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordView } from '../src/record-view.js';
import type { DwnApi, RecordsQueryRequest, RecordsQueryResponse } from '../src/dwn-api.js';
import type { MaterializedRecord, Record } from '../src/record.js';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthManager, MemoryStorage } from '@enbox/auth';
import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const ViewIntegrationDefinition = {
  protocol  : 'https://example.com/protocols/record-view-integration',
  published : true,
  types     : {
    note: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-integration-note',
    },
    label: {
      dataFormats: ['text/plain'],
    },
    preference: {
      dataFormats: ['text/plain'],
    },
  },
  structure: {
    note: {
      $tags: {
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      label: {
        $recordLimit: { max: 1 },
      },
    },
    preference: {
      $recordLimit: { max: 1 },
    },
  },
} as const satisfies ProtocolDefinition;

type NoteData = { title: string };

const ViewIntegrationProtocol = defineProtocol(
  ViewIntegrationDefinition,
  {
    label      : recordCodecs.text(),
    note       : recordCodecs.json<NoteData>(),
    preference : recordCodecs.text(),
  },
);
const LABEL_PATH = 'note/label';
const TEST_PASSWORD = 'test-password';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the observed record view.');
}

function captureRecordQueries(dwn: DwnApi): { dwn: DwnApi; requests: RecordsQueryRequest[] } {
  const requests: RecordsQueryRequest[] = [];
  return {
    dwn: new Proxy(dwn, {
      get(target, property, receiver): unknown {
        if (property !== 'records') {
          return Reflect.get(target, property, receiver);
        }

        const records = target.records;
        return {
          ...records,
          query: async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
            requests.push(request);
            return records.query(request);
          },
        };
      },
    }),
    requests,
  };
}

describe('RecordView local DWN integration', () => {
  it('rematerializes real selection changes and stops publishing after close', async () => {
    const platform = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/record-view-integration',
    });
    let auth: AuthManager | undefined;
    let view: RecordView<Record<NoteData>> | undefined;

    try {
      await platform.clearStorage();
      await platform.agent.initialize({ password: TEST_PASSWORD });
      await platform.agent.start({ password: TEST_PASSWORD });
      const identity = await platform.agent.identity.create({
        metadata  : { name: 'Record View Integration' },
        didMethod : 'jwk',
      });
      auth = await AuthManager.create({
        agent   : platform.agent,
        storage : new MemoryStorage(),
        sync    : 'off',
      });
      const session = await auth.switchIdentity(identity.did.uri);
      const typed = Enbox.fromSession(session).using(ViewIntegrationProtocol);
      const configured = await typed.configure();
      expect(configured.status.code).toBe(202);

      view = await typed.records.observe('note', {
        filter     : { tags: { status: 'draft' } },
        pagination : { limit: 10 },
      });
      await waitFor(() => view?.getSnapshot().state === 'ready');
      expect(view.getSnapshot().records).toHaveLength(0);

      let publications = 0;
      view.subscribe((): void => { publications += 1; });

      const created = await typed.records.create('note', {
        data : { title: 'Created' },
        tags : { status: 'draft' },
      });
      await waitFor(() => view?.getSnapshot().records.some((record) => record.id === created.id) === true);
      const observed = view.getSnapshot().records[0];
      expect(await observed.value()).toEqual({ title: 'Created' });

      await created.update({ tags: { status: 'published' } });
      await waitFor(() => view?.getSnapshot().records.length === 0);

      const replacement = await typed.records.create('note', {
        data : { title: 'Replacement' },
        tags : { status: 'draft' },
      });
      await waitFor(() => view?.getSnapshot().records.some((record) => record.id === replacement.id) === true);

      await replacement.delete();
      await waitFor(() => view?.getSnapshot().records.length === 0);

      const snapshotAtClose = view.getSnapshot();
      const publicationsAtClose = publications;
      await view.close();

      await typed.records.create('note', {
        data : { title: 'After close' },
        tags : { status: 'draft' },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(view.getSnapshot()).toBe(snapshotAtClose);
      expect(publications).toBe(publicationsAtClose);
    } finally {
      await view?.close().catch((): void => {});
      await auth?.shutdown().catch((): void => {});
      await platform.closeStorage();
    }
  });

  it('batches selected singleton children and rematerializes after a child-only write', async () => {
    const platform = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/record-view-materialization-integration',
    });
    let auth: AuthManager | undefined;
    let view: RecordView<MaterializedRecord<NoteData> & Readonly<{
      children: { readonly label: MaterializedRecord<string> | undefined };
    }>> | undefined;
    let typed!: TypedEnbox<typeof ViewIntegrationDefinition, typeof ViewIntegrationProtocol.codecs>;

    try {
      await platform.clearStorage();
      await platform.agent.initialize({ password: TEST_PASSWORD });
      await platform.agent.start({ password: TEST_PASSWORD });
      const identity = await platform.agent.identity.create({
        metadata  : { name: 'Record View Materialization Integration' },
        didMethod : 'jwk',
      });
      auth = await AuthManager.create({
        agent   : platform.agent,
        storage : new MemoryStorage(),
        sync    : 'off',
      });
      const session = await auth.switchIdentity(identity.did.uri);
      const captured = captureRecordQueries(Enbox.fromSession(session).dwn);
      typed = new TypedEnbox(captured.dwn, ViewIntegrationProtocol);
      expect((await typed.configure()).status.code).toBe(202);

      const setAtRuntime = typed.records.set as unknown as (
        path: string,
        request: { data: unknown; within?: string },
      ) => Promise<unknown>;
      await expect(setAtRuntime('preference', { data: 'invalid', within: 'note-context' }))
        .rejects.toThrow('a root singleton does not accept within');
      await expect(setAtRuntime(LABEL_PATH, { data: 'invalid', within: 'too/deep/context' }))
        .rejects.toThrow('within cannot be deeper than protocol path');
      expect(captured.requests).toHaveLength(0);

      const preference = await typed.records.set('preference', { data: 'compact' });
      const updatedPreference = await typed.records.set('preference', { data: 'comfortable' });
      expect(updatedPreference.id).toBe(preference.id);
      expect(await updatedPreference.value()).toBe('comfortable');

      const first = await typed.records.create('note', { data: { title: 'First' } });
      const second = await typed.records.create('note', { data: { title: 'Second' } });
      const firstLabel = await typed.records.set(LABEL_PATH, {
        data   : 'one',
        within : first.contextId,
      });

      captured.requests.length = 0;
      const values = await typed.records.query('note', {
        materialize : true,
        pagination  : { limit: 10 },
      });
      expect(captured.requests).toHaveLength(1);
      expect(values.records.map(({ value }) => value)).toEqual([
        { title: 'First' },
        { title: 'Second' },
      ]);
      expect(values.records.map((record) => Object.keys(record).sort())).toEqual([
        ['record', 'value'],
        ['record', 'value'],
      ]);

      captured.requests.length = 0;
      const page = await typed.records.query('note', {
        materialize : { children: [LABEL_PATH] as const },
        pagination  : { limit: 10 },
      });

      expect(captured.requests).toHaveLength(2);
      expect(captured.requests[1].filter.parentId).toEqual(
        page.records.map((record) => record.record.id),
      );
      expect(page.records.find((record) => record.record.id === first.id)).toMatchObject({
        value    : { title: 'First' },
        children : { label: { value: 'one' } },
      });
      expect(Object.keys(
        page.records.find((record) => record.record.id === first.id)?.children.label ?? {},
      ).sort()).toEqual(['record', 'value']);
      const secondResult = page.records.find((record) => record.record.id === second.id);
      if (secondResult === undefined) {
        throw new Error('Expected the second parent in the materialized page.');
      }
      expect(Object.hasOwn(secondResult.children, 'label')).toBe(true);
      expect(secondResult.children.label).toBeUndefined();

      view = await typed.records.observe('note', {
        materialize : { children: [LABEL_PATH] as const },
        pagination  : { limit: 10 },
      });
      await waitFor(() => view?.getSnapshot().state === 'ready');
      const updatedLabel = await typed.records.set(LABEL_PATH, {
        data   : 'updated',
        within : first.contextId,
      });
      expect(updatedLabel.id).toBe(firstLabel.id);
      await waitFor(() => view?.getSnapshot().records
        .find((record) => record.record.id === first.id)?.children.label?.value === 'updated');
    } finally {
      await view?.close().catch((): void => {});
      await auth?.shutdown().catch((): void => {});
      await platform.closeStorage();
    }
  });
});
