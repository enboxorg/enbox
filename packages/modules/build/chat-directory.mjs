import { resolveModuleGraph } from '@enbox/dwn-sdk-js';

/** Project the same standard modules into a prompt index and self-contained Briand bundles.
 * The capturePaths allowlist controls generic writes. An empty list requires the named workflow.
 * Complete definitions and URI-keyed schemas support interchange and specialized applications.
 */
export function chatDirectory(inputs) {
  const modules = [];
  const bundles = [];
  for (const { catalog, definition, schemas, id, chat } of inputs.values()) {
    const { summary, targets, hints, interchange, workflow } = chat;
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 180 || !Array.isArray(targets) ||
        !Array.isArray(hints?.keywords) || !hints.keywords.length || typeof hints.sensitive !== 'boolean') {
      throw new Error(`Invalid chat discovery metadata for ${id}`);
    }
    if (workflow !== undefined && (typeof workflow !== 'string' || !workflow.trim())) {
      throw new Error(`Invalid application workflow for ${id}`);
    }
    if (targets.length === 0 && workflow === undefined) {
      throw new Error(`Module ${id} must name its application workflow when it has no generic capture paths.`);
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
    const applicationWorkflow = workflow === undefined ? {} : { workflow };
    const bundle = { id, label: catalog.name, description: summary, source: 'catalog', definition, schemas: byUri,
      capture: hints, capturePaths: paths.map(target => target.path), ...applicationWorkflow };
    if (Buffer.byteLength(JSON.stringify(bundle)) > 131072) {
      throw new Error(`Chat bundle exceeds the consumer's 128 KiB import limit: ${id}`);
    }
    modules.push({ id, module, label: catalog.name, category: catalog.category, summary,
      keywords: hints.keywords, sensitive: hints.sensitive, identity: catalog.capture.identity,
      exclude: catalog.capture.exclude, paths, ...applicationWorkflow, ...(interchange ? { interchange } : {}) });
    bundles.push(bundle);
  }
  return { index: { version: 1, modules }, bundles };
}
