import type { Enbox } from '@enbox/api';

import { createYjs1Doc } from '@enbox/crdt/yjs1';
import { defineApplicationManifest } from '@enbox/api';

import { NotebookModule } from '../src/notebook.js';
import { NotebookRealtimeModule } from '../src/notebook-realtime.js';

export const notebookApplication = defineApplicationManifest({ modules: [NotebookModule, NotebookRealtimeModule] });

/** Persist text using the existing notesd CRDT contract, rather than a second note format. */
export async function createNotebookPage(enbox: Enbox, text: string): Promise<{ notebookId: string; pageId: string; deltaId: string }> {
  const notebook = await enbox.using(NotebookModule).records.create('notebook', { data: { name: 'Personal notes' } });
  const page = await enbox.using(NotebookModule).records.create('notebook/page', {
    parentContextId : notebook.contextId,
    data            : { title: 'Research' },
  });
  const document = createYjs1Doc();
  try {
    document.insertText(0, text);
    const delta = await enbox.using(NotebookModule).records.create('notebook/page/delta', {
      parentContextId : page.contextId,
      data            : document.encodeFullState(),
    });
    return { notebookId: notebook.id, pageId: page.id, deltaId: delta.id };
  } finally {
    document.destroy();
  }
}
