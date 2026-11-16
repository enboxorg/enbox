import type { EnboxTestContext } from '@enbox/api/testing';

import { BelongingsModule } from '../src/belongings.js';
import { CollaborationDefinition } from '../src/collaboration.js';
import { createEnboxTestContext } from '@enbox/api/testing';
import { createHousehold } from '../examples/household.js';
import { createYjs1Doc } from '@enbox/crdt/yjs1';
import { defineApplicationManifest } from '@enbox/api';
import { Enbox } from '@enbox/api';
import { FinancialAccountsModule } from '../src/financial-accounts.js';
import { GroceriesSchemas } from '../src/groceries.js';
import { InvestmentHoldingsModule } from '../src/investment-holdings.js';
import { MaintenanceModule } from '../src/maintenance.js';
import { NotebookModule } from '../src/notebook.js';
import { ShoppingWishlistsModule } from '../src/shopping-wishlists.js';
import { TransactionsModule } from '../src/transactions.js';
import { createNotebookPage, notebookApplication } from '../examples/notebook.js';
import { createPortfolio, portfolioApplication } from '../examples/portfolio.js';
import { describe, expect, it } from 'bun:test';
import { DevicesCodecs, DevicesModule } from '../src/devices.js';
import { GiftsCodecs, GiftsModule } from '../src/gifts.js';
import { listHouseholdShopping, managedHouseholdApplication } from '../examples/household-contexts.js';
import { resolveModuleContextRoles, resolveModuleGraph } from '@enbox/dwn-sdk-js';
import { SharedGroceriesModule, SharedGroceriesSchemas } from '../src/shared-groceries.js';

async function usingApplication(
  application: Parameters<typeof createEnboxTestContext>[0]['application'],
  run: (context: EnboxTestContext) => Promise<void>,
): Promise<void> {
  const context = await createEnboxTestContext({ application });
  try {
    await run(context);
  } finally {
    await context.close();
  }
}

describe('functional module applications', () => {
  it('links private gift planning to a wishlist item without duplicating product metadata', async () => {
    const application = defineApplicationManifest({ modules: [GiftsModule, ShoppingWishlistsModule] });
    await usingApplication(application, async ({ enbox }): Promise<void> => {
      const list = await enbox.using(ShoppingWishlistsModule).records.create('list', { data: { name: 'Ideas' } });
      const product = await enbox.using(ShoppingWishlistsModule).records.create('list/item', {
        parentContextId : list.contextId,
        data            : { name: 'Cookbook', state: 'wanted' },
      });
      const plan = await enbox.using(GiftsModule).records.create('plan', { data: { name: 'Birthday', recipientName: 'Sam' } });
      const idea = await enbox.using(GiftsModule).records.create('plan/idea', {
        parentContextId : plan.contextId,
        data            : { wishlistItem: { recordId: product.id, moduleUri: ShoppingWishlistsModule.definition.module }, state: 'idea' },
      });
      expect((await idea.value()).wishlistItem!.recordId).toBe(product.id);
      expect(() => GiftsCodecs.idea.encode({ name: 'Duplicated title', wishlistItem: { recordId: product.id }, state: 'idea' })).toThrow();
      await plan.delete({ prune: true });
      expect(await enbox.using(ShoppingWishlistsModule).records.read('list/item', product.id)).toBeDefined();
    });
  }, 30_000);

  it('lets independent household clients share the same list records and canonical payload contract', async () => {
    await usingApplication(managedHouseholdApplication, async ({ enbox, session }): Promise<void> => {
      const created = await createHousehold(enbox, 'Home');
      expect(await listHouseholdShopping(enbox, created.contextId)).toEqual([created.listId]);
      const otherClient = Enbox.fromSession(session);
      try {
        const item = await otherClient.using(SharedGroceriesModule).records.read('space/list/item', created.itemId);
        expect((await item!.value()).name).toBe('Oat milk');
        await item!.update({ data: { name: 'Oat milk', state: 'purchased' } });
        expect((await (await enbox.using(SharedGroceriesModule).records.read('space/list/item', created.itemId))!.value()).state).toBe(
          'purchased',
        );
        expect(SharedGroceriesSchemas.item).toEqual(GroceriesSchemas.item);
        const graph = resolveModuleGraph(CollaborationDefinition, (): undefined => undefined, { requireKeyAgreement: false });
        expect(resolveModuleContextRoles(graph, 'space')).toEqual(['space/admin', 'space/editor', 'space/viewer']);
      } finally {
        otherClient.close();
      }
    });
  }, 30_000);

  it('uses one account for holdings and optional ledger entries without creating duplicate account identities', async () => {
    await usingApplication(portfolioApplication, async ({ enbox }): Promise<void> => {
      const portfolio = await createPortfolio(enbox, '2026-11-16T12:00:00Z');
      expect((await enbox.dwn.modules.query({ filter: { module: TransactionsModule.definition.module } })).modules).toHaveLength(0);
      await enbox.using(TransactionsModule).ensureReady('account/transaction');
      const transaction = await enbox.using(TransactionsModule).records.create('account/transaction', {
        parentContextId : portfolio.accountContextId,
        data            : { kind: 'expense', amount: { amount: '100', currency: 'USD' }, occurredAt: '2026-11-16T12:00:00Z' },
      });
      expect(transaction.contextId!.startsWith(portfolio.accountContextId + '/')).toBe(true);
      const position = await enbox.using(InvestmentHoldingsModule).records.read('account/position', portfolio.positionId);
      expect((await position!.value()).quantity).toBe('10.5');
      expect((await enbox.using(FinancialAccountsModule).records.query('account')).records).toHaveLength(1);
    });
  }, 30_000);

  it('uses the canonical notebook representation across note-taking clients', async () => {
    await usingApplication(notebookApplication, async ({ enbox }): Promise<void> => {
      const saved = await createNotebookPage(enbox, 'One note, shared across applications.');
      const record = await enbox.using(NotebookModule).records.read('notebook/page/delta', saved.deltaId);
      const document = createYjs1Doc();
      try {
        document.applyDurable(await record!.value(), { recordId: record!.id });
        expect(document.getText()).toBe('One note, shared across applications.');
      } finally {
        document.destroy();
      }
    });
  }, 30_000);

  it('keeps device identity on Belongings and records repairs once through Maintenance', async () => {
    const application = defineApplicationManifest({ modules: [DevicesModule, MaintenanceModule] });
    await usingApplication(application, async ({ enbox }): Promise<void> => {
      const item = await enbox.using(BelongingsModule).records.create('item', {
        data: { name: 'Laptop', state: 'owned', manufacturer: 'Example', model: 'Portable', serialNumber: 'ABC123' },
      });
      const device = await enbox.using(DevicesModule).records.create('item/device', {
        parentContextId : item.contextId,
        data            : { kind: 'computer', operatingState: 'active' },
      });
      const service = await enbox.using(MaintenanceModule).records.create('item/service', {
        parentContextId : item.contextId,
        data            : { description: 'Replaced battery', performedAt: '2026-11-16T12:00:00Z' },
      });
      expect(device.contextId!.split('/')[0]).toBe(service.contextId!.split('/')[0]);
      expect(() => DevicesCodecs.device.encode({ kind: 'computer', model: 'A second identity' } as never)).toThrow();
      expect(DevicesModule.definition.types).not.toHaveProperty('service');
    });
  }, 30_000);
});
