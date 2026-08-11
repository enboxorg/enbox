import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnApi, RecordsQueryRequest, RecordsQueryResponse } from '../src/dwn-api.js';

import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
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
const ViewIntegrationApplication = defineApplicationManifest({ protocols: [ViewIntegrationProtocol] });
const LABEL_PATH = 'note/label';

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
    const context = await createEnboxTestContext({ application: ViewIntegrationApplication });

    try {
      const typed = context.enbox.using(ViewIntegrationProtocol);

      const view = await typed.records.observe('note', {
        filter     : { tags: { status: 'draft' } },
        pagination : { limit: 10 },
      });
      await waitFor(() => view.getSnapshot().status === 'ready');
      expect(view.getSnapshot().records).toHaveLength(0);

      let publications = 0;
      view.subscribe((): void => { publications += 1; });

      const created = await typed.records.create('note', {
        data : { title: 'Created' },
        tags : { status: 'draft' },
      });
      await waitFor(() => view.getSnapshot().records.some((record) => record.id === created.id));
      const observed = view.getSnapshot().records[0];
      expect(await observed.value()).toEqual({ title: 'Created' });

      await created.update({ tags: { status: 'published' } });
      await waitFor(() => view.getSnapshot().records.length === 0);

      const replacement = await typed.records.create('note', {
        data : { title: 'Replacement' },
        tags : { status: 'draft' },
      });
      await waitFor(() => view.getSnapshot().records.some((record) => record.id === replacement.id));

      await replacement.delete();
      await waitFor(() => view.getSnapshot().records.length === 0);

      const stateAtClose = view.getSnapshot();
      const publicationsAtClose = publications;
      await view.close();

      await typed.records.create('note', {
        data : { title: 'After close' },
        tags : { status: 'draft' },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(view.getSnapshot()).toBe(stateAtClose);
      expect(publications).toBe(publicationsAtClose);
    } finally {
      await context.close();
    }
  });

  it('batches selected singleton children and rematerializes after a child-only write', async () => {
    const context = await createEnboxTestContext({ application: ViewIntegrationApplication });

    try {
      const captured = captureRecordQueries(context.enbox.dwn);
      const typed = new TypedEnbox(captured.dwn, ViewIntegrationProtocol);

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

      const view = await typed.records.observe('note', {
        materialize : { children: [LABEL_PATH] as const },
        pagination  : { limit: 10 },
      });
      await waitFor(() => view.getSnapshot().status === 'ready');
      const updatedLabel = await typed.records.set(LABEL_PATH, {
        data   : 'updated',
        within : first.contextId,
      });
      expect(updatedLabel.id).toBe(firstLabel.id);
      await waitFor(() => view.getSnapshot().records
        .find((record) => record.record.id === first.id)?.children.label?.value === 'updated');
    } finally {
      await context.close();
    }
  });
});
