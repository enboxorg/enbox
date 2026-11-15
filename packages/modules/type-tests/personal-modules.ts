import type { Enbox } from '@enbox/api';
import type { GroceriesItemData } from '@enbox/modules';

import groceryDefinition from '@enbox/modules/artifacts/groceries/definition.json' with { type: 'json' };
import grocerySchema from '@enbox/modules/artifacts/groceries/schemas/item.json' with { type: 'json' };
import { GroceriesModule as SubpathGroceries } from '@enbox/modules/groceries';
import {
  GroceriesModule,
  IdentityDocumentsModule,
  InvestmentHoldingsModule,
  NotebookModule,
  NotebookRealtimeModule,
  WarrantiesModule,
} from '@enbox/modules';

declare const enbox: Enbox;
const groceries = enbox.using(GroceriesModule);
const item: GroceriesItemData = { name: 'Lemons', state: 'needed', quantity: { value: '2', unit: 'piece' } };
const value: Promise<GroceriesItemData> = groceries.records
  .create('list/item', { parentContextId: 'list', data: item })
  .then((record): Promise<GroceriesItemData> => record.value());
void value;
void SubpathGroceries;
void groceryDefinition.module;
void grocerySchema.properties;

// @ts-expect-error the payload is required to identify the item and its state.
groceries.records.create('list/item', { parentContextId: 'list', data: {} });
// @ts-expect-error invalid states are rejected by the literal-preserving codec type.
groceries.records.create('list/item', { parentContextId: 'list', data: { name: 'Milk', state: 'watching' } });
// @ts-expect-error quantities use explicit decimal strings and units.
groceries.records.create('list/item', { parentContextId: 'list', data: { name: 'Milk', state: 'needed', quantity: 2 } });
// @ts-expect-error imported attachment paths belong to the provider.
enbox.using(WarrantiesModule).records.create('item', { data: {} });
// @ts-expect-error imported account paths are not holding records.
enbox.using(InvestmentHoldingsModule).records.read('account', 'id');
enbox
  .using(IdentityDocumentsModule)
  // @ts-expect-error schema-defined document kinds are finite.
  .records.create('document', { data: { label: 'ID', documentType: 'invented', reviewState: 'unreviewed' } });
// @ts-expect-error role payloads are intentionally empty; the recipient is a descriptor field.
groceries.records.create('list/editor', { parentContextId: 'list', data: { did: 'did:example:someone' } });

enbox.using(NotebookModule).records.create('notebook/page/attachment', {
  parentContextId : 'page',
  data            : { filename: 'note.txt', mimeType: 'text/plain', blob: new Blob(['hello']) },
});
// @ts-expect-error notesd attachments require the file envelope value, not unframed bytes.
enbox.using(NotebookModule).records.create('notebook/page/attachment', { parentContextId: 'page', data: new Uint8Array() });
// @ts-expect-error a CRDT delta is a binary frame, not a Markdown string.
enbox.using(NotebookModule).records.create('notebook/page/delta', { parentContextId: 'page', data: 'hello' });
// @ts-expect-error the imported page is owned by Notebook, not its realtime consumer.
enbox.using(NotebookRealtimeModule).records.create('page', { data: { title: 'hello' } });
