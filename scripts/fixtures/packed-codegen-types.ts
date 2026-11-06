import type { Enbox } from '@enbox/api';

import { CommentsModule } from './comments.generated.js';

declare const enbox: Enbox;
const comments = enbox.using(CommentsModule);

void comments.records.create('note/comment', {
  parentContextId : 'notebook-id/note-id',
  moduleRole      : 'core:notebook/member',
  data            : { text: 'A typed comment.' },
});

// @ts-expect-error A virtual attachment is not a writable record path.
void comments.records.create('note', { data: { text: 'Invalid attachment write.' } });

// @ts-expect-error Generated JSON Schema types reject non-string text.
void comments.records.create('note/comment', { parentContextId: 'notebook-id/note-id', data: { text: 123 } });
