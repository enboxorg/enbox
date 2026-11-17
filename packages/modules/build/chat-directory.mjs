import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveModuleGraph } from '@enbox/dwn-sdk-js';

/** The prompt index includes only the personally asserted facts chosen for chat capture.
 * The bundle projection keeps the full authored definition and URI-keyed payload schemas.
 * The PoC validates capture hints separately and fingerprints them along with those artifacts.
 */
export async function chatDirectory(inputs) {
  const modules = [];
  const bundles = [];
  const selected = new Set();
  for (const input of inputs.values()) {
    const metadata = await readFile(resolve(input.directory, 'chat.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (metadata === undefined) { continue; }
    const { summary, targets, hints, interchange } = JSON.parse(metadata);
    const { catalog, definition, schemas, id } = input;
    if (!summary || summary.length > 180 || !targets?.length || !hints?.keywords?.length || typeof hints.sensitive !== 'boolean') {
      throw new Error(`Invalid chat discovery metadata for ${id}`);
    }
    if (Object.keys(hints).some(key => !['keywords', 'sensitive', 'sensitiveFields', 'identityFields'].includes(key))) {
      throw new Error(`Unrecognized chat capture hint for ${id}`);
    }
    const seen = new Set();
    const graph = resolveModuleGraph(definition, uri => inputs.get(uri)?.definition, { requireKeyAgreement: false });
    const paths = targets.map(({ path, utterance, distinguish }) => {
      const node = graph.nodesByDeclaredPath.get(path);
      const record = catalog.records.find(record => record.path === path);
      const schema = schemas[record?.type];
      if (!utterance || !distinguish || seen.has(path) || node?.kind !== 'record' ||
          node.ruleSet.$role || !record?.encryptionRequired || !schema || !record.dataFormats.includes('application/json')) {
        throw new Error(`Invalid chat capture target: ${id}/${path}`);
      }
      seen.add(path);
      const p = node.expectedParent;
      return { path, schemaUri: schema.$id, utterance, distinguish,
        ...(p ? { parent: { module: p.owningModuleUri, path: p.owningModulePath } } : {}) };
    });
    for (const [path, fields] of Object.entries(hints.identityFields ?? {})) {
      const record = catalog.records.find(record => record.path === path);
      if (!seen.has(path) || !Array.isArray(fields) || !fields.length ||
          fields.some(field => !Object.hasOwn(schemas[record.type].properties, field))) {
        throw new Error(`Invalid capture identity fields: ${id}/${path}`);
      }
    }
    const byUri = Object.fromEntries(Object.values(schemas).map(schema => [schema.$id, schema]));
    const module = definition.module;
    const bundle = { id, label: catalog.name, description: summary, source: 'catalog', definition, schemas: byUri, capture: hints };
    if (Buffer.byteLength(JSON.stringify(bundle)) > 131072) {
      throw new Error(`Chat bundle exceeds the consumer's 128 KiB import limit: ${id}`);
    }
    modules.push({ id, module, label: catalog.name, category: catalog.category, summary,
      keywords: hints.keywords, sensitive: hints.sensitive, identity: catalog.capture.identity,
      exclude: catalog.capture.exclude, paths, ...(interchange ? { interchange } : {}) });
    bundles.push(bundle);
    selected.add(module);
  }
  for (const bundle of bundles) {
    for (const uri of Object.values(bundle.definition.uses ?? {})) {
      if (!selected.has(uri)) { throw new Error(`Missing chat bundle dependency: ${uri}`); }
    }
  }
  return { index: { version: 1, modules }, bundles };
}
