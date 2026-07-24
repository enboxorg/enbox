import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordView } from '../src/record-view.js';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthManager, MemoryStorage } from '@enbox/auth';
import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { Enbox } from '../src/enbox.js';

const ViewIntegrationDefinition = {
  protocol  : 'https://example.com/protocols/record-view-integration',
  published : true,
  types     : {
    note: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-integration-note',
    },
  },
  structure: {
    note: {
      $tags: {
        status: { type: 'string', enum: ['draft', 'published'] },
      },
    },
  },
} as const satisfies ProtocolDefinition;

type ViewIntegrationSchemaMap = {
  note: { title: string };
};

const ViewIntegrationProtocol = defineProtocol(
  ViewIntegrationDefinition,
  {} as ViewIntegrationSchemaMap,
);

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the observed record view.');
}

describe('RecordView local DWN integration', () => {
  it('rematerializes real selection changes and stops publishing after close', async () => {
    const platform = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/record-view-integration',
    });
    let auth: AuthManager | undefined;
    let view: RecordView<ViewIntegrationSchemaMap['note']> | undefined;

    try {
      await platform.clearStorage();
      await platform.agent.initialize({ password: 'test-password' });
      await platform.agent.start({ password: 'test-password' });
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
      expect(await observed.data.json()).toEqual({ title: 'Created' });

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
});
