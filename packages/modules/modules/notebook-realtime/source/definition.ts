import { definition as provider } from '../../notebook/source/definition.js';
import { realtimeDefinition } from '../../../src/authoring/realtime.js';

export const definition = realtimeDefinition({
  module     : 'https://enbox.id/modules/notebook-realtime/v1',
  schemaBase : 'https://enbox.id/schemas/notebook-realtime/v1',
  provider,
  alias      : 'notebook',
  parentPath : 'notebook/page',
  attachment : 'page',
  readers    : ['notebook/page/admin', 'notebook/page/editor', 'notebook/page/viewer'],
  writers    : ['notebook/page/admin', 'notebook/page/editor'],
});
