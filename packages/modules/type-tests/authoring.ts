import type { Enbox } from '@enbox/api';

import moneySchema from '@enbox/modules/schemas/money.json' with { type: 'json' };
import { bundleSchema, roleDefinition, sharedSchemas } from '@enbox/modules/authoring';
import {
  CollaborationModule,
  DevicesModule,
  FinancialAccountsModule,
  SharedGroceriesModule,
  SharedTasksModule,
  TransactionsModule,
} from '@enbox/modules';
import { defineModule, recordCodecs } from '@enbox/api';

declare const enbox: Enbox;
const local = defineModule({
  definition: {
    module    : 'https://example.org/role-helper/v1',
    published : true,
    types     : { document: { dataFormats: ['application/json'] }, viewer: { dataFormats: ['application/json'] } },
    structure : { document: { viewer: roleDefinition('document/viewer') } },
  },
  codecs: { document: recordCodecs.json<{ title: string }>(), viewer: recordCodecs.json<Record<string, never>>() },
});
enbox.using(local).records.create('document/viewer', { parentContextId: 'document', recipient: 'did:example:reader', data: {} });
// @ts-expect-error the helper does not invent a new editor path.
enbox.using(local).records.create('document/editor', { parentContextId: 'document', data: {} });

const bundled = bundleSchema({ properties: { amount: { $ref: moneySchema.$id } } }, sharedSchemas);
void bundled;
enbox.using(FinancialAccountsModule).records.create('account', { data: { name: 'Brokerage', kind: 'investment' } });
// @ts-expect-error Transactions does not own the account attachment.
enbox.using(TransactionsModule).records.create('account', { data: { name: 'Duplicate', kind: 'bank' } });
enbox
  .using(SharedGroceriesModule)
  .records.create('space/list/item', { parentContextId: 'space/list', data: { name: 'Milk', state: 'needed' } });
// @ts-expect-error Shared Groceries imports the space; it cannot create another provider record.
enbox.using(SharedGroceriesModule).records.create('space', { data: { name: 'Wrong owner' } });
// @ts-expect-error membership is owned by Collaboration, not a copied grocery role.
enbox.using(SharedGroceriesModule).records.create('space/list/viewer', { parentContextId: 'space/list', data: {} });
// @ts-expect-error personal state does not become part of the shared subtree.
enbox.using(SharedTasksModule).records.create('state', { data: { task: { recordId: 'task' } } });
enbox.using(CollaborationModule).records.create('space/editor', { parentContextId: 'space', recipient: 'did:example:member', data: {} });
// @ts-expect-error device repairs belong to Maintenance.
enbox.using(DevicesModule).records.create('item/device/service', { parentContextId: 'item/device', data: {} });
enbox
  .using(DevicesModule)
  // @ts-expect-error device identity fields remain on Belongings.
  .records.create('item/device', { parentContextId: 'item', data: { kind: 'computer', model: 'Duplicated model' } });
