/** Generate the published module artifacts from the per-module source directories. */
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import { format } from 'prettier';
import ts from 'typescript';
import { generateModuleCode } from '../../module-codegen/src/codegen.js';
import { bundleSchema } from '../src/authoring/schema-bundle.js';
import { sharedSchemas } from '../src/schema-values.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const sourceRoot = join(packageRoot, 'modules');
const generatedRoot = join(packageRoot, 'src/generated');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(argument => argument !== '--check')) {
  throw new Error('Usage: bun build/generate.mjs [--check]');
}

const lint = new ESLint({
  cwd: workspaceRoot,
  fix: true,
  overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { project: false } } }],
});

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const directories = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const inputs = new Map();
const expected = new Map();
for (const id of directories) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid module directory name: ${id}`);
  }
  const directory = join(sourceRoot, id);
  const authored = await import(pathToFileURL(join(directory, 'source/definition.ts')).href);
  const definition = authored.definition;
  const catalog = await json(join(directory, 'catalog.json'));
  const examples = await json(join(directory, 'examples.json'));
  if (catalog.id !== id || catalog.moduleUri !== definition.module || !/^[A-Z][A-Za-z0-9]*Module$/.test(catalog.exportName)) {
    throw new Error(`Module metadata does not identify its definition: ${id}`);
  }
  if (JSON.stringify(catalog.dependencies) !== JSON.stringify(definition.uses ?? {})) {
    throw new Error(`Module metadata has different dependencies: ${id}`);
  }
  if (typeof catalog.capture?.identity !== 'string' || catalog.capture.identity.length === 0 ||
      typeof catalog.capture?.workflow !== 'string' || catalog.capture.workflow.length === 0 ||
      !Array.isArray(catalog.capture?.exclude) || catalog.capture.exclude.length === 0 ||
      catalog.capture.exclude.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`Module lacks a complete semantic capture contract: ${id}`);
  }
  if (inputs.has(definition.module)) {
    throw new Error(`Duplicate module URI: ${definition.module}`);
  }
  expected.set(join(directory, 'definition.json'), JSON.stringify(definition, null, 2) + '\n');
  inputs.set(definition.module, { id, directory, definition, catalog, examples, schemaSources: authored.schemas,
    name: catalog.exportName.slice(0, -'Module'.length) });
}

async function codeWithSchemas(input, schemas) {
  const staging = await mkdtemp(join(tmpdir(), 'enbox-module-schemas-'));
  try {
    for (const record of input.catalog.records.filter(record => record.schemaFile !== undefined)) {
      await writeFile(join(staging, record.schemaFile.slice('schemas/'.length)), JSON.stringify(schemas[record.type]));
    }
    return await generateModuleCode(input.definition, {
      schemasDir: staging, moduleName: input.name, dependencies: dependenciesFor(input),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function dependenciesFor(input, ancestors = new Set()) {
  if (ancestors.has(input.definition.module)) {
    throw new Error(`Cyclic module dependency: ${input.id}`);
  }
  const next = new Set([...ancestors, input.definition.module]);
  return Object.fromEntries(Object.entries(input.definition.uses ?? {}).map(([alias, uri]) => {
    const provider = inputs.get(uri);
    if (provider === undefined) {
      throw new Error(`Missing provider '${uri}' required by '${input.id}'.`);
    }
    return [alias, {
      definition: provider.definition,
      importPath: `./${provider.id}.js`,
      exportName: provider.catalog.exportName,
      dependencies: dependenciesFor(provider, next),
    }];
  }));
}

function localPaths(structure, prefix = '') {
  return Object.entries(structure).flatMap(([key, rule]) => {
    if (key.startsWith('$')) { return []; }
    const path = prefix === '' ? key : `${prefix}/${key}`;
    return [...(rule.$ref === undefined ? [path] : []), ...localPaths(rule, path)];
  });
}

function ruleAt(definition, path) {
  return path.split('/').reduce((rule, segment) => rule[segment], definition.structure);
}

function codecOverrides(source, catalog, name) {
  const overrides = catalog.records.filter(record => record.codec !== undefined);
  if (overrides.length === 0) { return source; }
  const syntaxTree = ts.createSourceFile(`${catalog.id}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements = [];
  for (const record of overrides) {
    const { kind, formatId, maxContentBytes } = record.codec;
    if (kind !== 'file-envelope' || !/^[\x21-\x7e]{6}$/.test(formatId) || !Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
      throw new Error(`Invalid file-envelope codec: ${catalog.id}/${record.path}`);
    }
    const typeName = record.type[0].toUpperCase() + record.type.slice(1) + 'Data';
    const type = syntaxTree.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName);
    const declaration = syntaxTree.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
      .find(declaration => declaration.name.getText(syntaxTree) === `${name}Codecs`);
    const initializer = declaration?.initializer;
    const object = initializer !== undefined && ts.isAsExpression(initializer) ? initializer.expression : initializer;
    const codec = object?.properties?.find(property => property.name?.getText(syntaxTree) === record.type);
    if (type?.type.getText(syntaxTree) !== 'Uint8Array' || codec?.initializer?.getText(syntaxTree) !== 'recordCodecs.bytes()') {
      throw new Error(`File-envelope override must target a binary codec: ${catalog.id}/${record.path}`);
    }
    replacements.push({ start: type.type.getStart(syntaxTree), end: type.type.end, text: 'FileEnvelopeData' });
    replacements.push({ start: codec.initializer.getStart(syntaxTree), end: codec.initializer.end,
      text: `recordCodecs.fileEnvelope(${JSON.stringify({ formatId, maxContentBytes })})` });
  }
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
  }
  return `import type { FileEnvelopeData } from '@enbox/api';\n${source}`;
}

function actionDescription(action) {
  const actor = action.role === undefined
    ? action.who === 'anyone' ? 'anyone' : `${action.who}${action.of === undefined ? ' of this record' : ` of ${action.of}`}`
    : `role ${action.role}`;
  return `${actor}: ${action.can.join(', ')}`;
}

async function typescript(source, filePath) {
  // DTOs use type aliases in this package. Transform generated interfaces with
  // the TypeScript AST, preserving their complete structural type contracts.
  const syntaxTree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const replacements = [];
  for (const statement of syntaxTree.statements) {
    if (!ts.isInterfaceDeclaration(statement)) { continue; }
    const inherited = (statement.heritageClauses ?? []).flatMap(clause => clause.types.map(type =>
      ts.factory.createTypeReferenceNode(type.expression.getText(syntaxTree), type.typeArguments)));
    const body = statement.members.length === 0
      ? ts.factory.createTypeReferenceNode('Record', [ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword), ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)])
      : ts.factory.createTypeLiteralNode(statement.members);
    const alias = ts.factory.createTypeAliasDeclaration(statement.modifiers, statement.name, statement.typeParameters,
      inherited.length === 0 ? body : ts.factory.createIntersectionTypeNode([...inherited, body]));
    replacements.push({ start: statement.getStart(syntaxTree), end: statement.end, text: printer.printNode(ts.EmitHint.Unspecified, alias, syntaxTree) });
  }
  for (const replacement of replacements.reverse()) {
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
  }
  source = source.replace(
    "import { defineModule, recordCodecs, type RecordValidator } from '@enbox/api';",
    "import type { RecordValidator } from '@enbox/api';\nimport { defineModule, recordCodecs } from '@enbox/api';",
  );
  const imports = [...source.matchAll(/^import .*;$/gm)].map(match => match[0]);
  source = source.replace(/^import .*;\n?/gm, '');
  const key = statement => {
    const members = statement.match(/\{([^}]+)\}/)?.[1].split(',').map(member => member.trim()) ?? [];
    const syntax = members.length === 1 ? 2 : members.length > 1 ? 3 : 1;
    return [statement.startsWith('import type ') ? 0 : 1, syntax, (members[0]?.split(/\s+as\s+/).at(-1) ?? statement).toLowerCase()];
  };
  imports.sort((left, right) => {
    const a = key(left), b = key(right);
    return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
  });
  source = imports.filter(value => value.startsWith('import type ')).join('\n') + '\n\n' +
    imports.filter(value => !value.startsWith('import type ')).join('\n') + '\n\n' + source;
  // Keep the generated validator on one line, as required by its type-contract
  // directive. Format and lint the readable types, definitions, and metadata.
  const protectedSource = source.replace('// @ts-expect-error -- Ajv emits', '// prettier-ignore\n// @ts-expect-error -- Ajv emits');
  const formatted = await format(protectedSource, { parser: 'typescript', singleQuote: true, printWidth: 140, tabWidth: 2, trailingComma: 'all' });
  const [result] = await lint.lintText(formatted, { filePath });
  if (result.errorCount !== 0) {
    throw new Error(`${filePath}: ${result.messages.map(message => `${message.line}: ${message.message}`).join('\n')}`);
  }
  return result.output ?? formatted;
}

const catalogImports = [];
const catalogNames = [];
const moduleImports = [];
const moduleNames = [];
const rootExports = [];
const index = [];

for (const input of inputs.values()) {
  const { id, directory, definition, catalog, examples, name } = input;
  const paths = localPaths(definition.structure).sort();
  const described = catalog.records.map(record => record.path).sort();
  const illustrated = examples.map(example => example.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(described) || JSON.stringify(paths) !== JSON.stringify(illustrated)) {
    throw new Error(`Definition, catalog, and examples have different paths: ${id}`);
  }
  const schemas = {};
  for (const record of catalog.records) {
    const type = definition.types[record.type];
    const rule = ruleAt(definition, record.path);
    if (record.type !== record.path.split('/').at(-1) ||
        record.encryptionRequired !== (type.encryptionRequired ?? false) ||
        record.role !== (rule.$role ?? false) || record.immutable !== (rule.$immutable ?? false) ||
        record.singleton !== (rule.$recordLimit?.max === 1) ||
        JSON.stringify(record.dataFormats) !== JSON.stringify(type.dataFormats) || record.schema !== type.schema) {
      throw new Error(`Record metadata disagrees with the definition: ${id}/${record.path}`);
    }
    if (record.schemaFile !== undefined) {
      const schemaName = record.type.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      if (record.schemaFile !== `schemas/${schemaName}.json`) {
        throw new Error(`Unexpected schema path: ${id}/${record.schemaFile}`);
      }
      const source = input.schemaSources?.[record.type] ?? await json(join(directory, 'source', record.schemaFile));
      const schema = bundleSchema(source, sharedSchemas, { definitionPrefix: record.type });
      if (schema.$id !== record.schema || definition.types[record.type].schema !== schema.$id) {
        throw new Error(`Mismatched schema identity: ${id}/${record.path}`);
      }
      schemas[record.type] = schema;
      expected.set(join(directory, record.schemaFile), JSON.stringify(schema, null, 2) + '\n');
    }
  }
  const { code } = await codeWithSchemas(input, schemas);
  const records = catalog.records.map(({ schema, schemaFile, ...record }) => {
    const rule = ruleAt(definition, record.path);
    return { ...record, ...(schema === undefined ? {} : { schemaUri: schema }),
      squashable: rule.$squash ?? false, maxBytes: rule.$size?.max, actions: rule.$actions ?? [] };
  });
  const metadata = {
    id, name: catalog.name, category: catalog.category, description: catalog.description,
    uri: definition.module, exportName: catalog.exportName, status: catalog.status,
    captureExamples: catalog.captureExamples, capture: catalog.capture, notes: catalog.notes ?? [], dependencies: definition.uses ?? {},
  };
  let source = `import type { ModuleCatalogEntry, PayloadSchema } from '../catalog-types.js';\n${codecOverrides(code, catalog, name)}\n`;
  source += `export const ${name}Schemas: Readonly<Record<string, PayloadSchema>> = ${JSON.stringify(schemas, null, 2)};\n`;
  source += `export const ${name}Catalog: ModuleCatalogEntry = {\n...${JSON.stringify(metadata, null, 2)},\n`;
  source += `definition: ${name}Definition,\nrecords: [\n`;
  source += records.map(record => `{ ...${JSON.stringify(record)}, ${schemas[record.type] === undefined ? '' : `schema: ${name}Schemas[${JSON.stringify(record.type)}],`} }`).join(',\n');
  source += `\n],\nexamples: ${JSON.stringify(examples, null, 2)}\n};\n`;
  const generatedPath = join(generatedRoot, `${id}.ts`);
  expected.set(generatedPath, await typescript(source, generatedPath));
  const wrapper = `/** ${catalog.name}: complete definitions, codecs, schemas, and discovery metadata. */\nexport * from './generated/${id}.js';\n`;
  expected.set(join(packageRoot, 'src', `${id}.ts`), wrapper);
  catalogImports.push(`import { ${name}Catalog } from './${id}.js';`);
  catalogNames.push(`${name}Catalog`);
  moduleImports.push(`import { ${name}Module } from './${id}.js';`);
  moduleNames.push(`${name}Module`);
  if (['profile', 'preferences', 'connect'].includes(id)) {
    rootExports.push(`export * from './${id}.js';`);
  } else {
    rootExports.push(`export { ${name}Module, ${name}Definition, ${name}Codecs, ${name}Schemas, ${name}Catalog } from './${id}.js';`);
    const typeNames = Object.keys(definition.types).map(type => type.replace(/[-_](\w)/g, (_, char) => char.toUpperCase()).replace(/^\w/, char => char.toUpperCase()) + 'Data');
    rootExports.push(`export type { ${typeNames.map(type => `${type} as ${name}${type}`).join(', ')} } from './${id}.js';`);
  }
  index.push({ id, name: catalog.name, category: catalog.category, moduleUri: definition.module,
    definition: `${id}/definition.json`, catalog: `${id}/catalog.json`, examples: `${id}/examples.json` });

  const rows = catalog.records.map(record => `| \`${record.path}\` | ${record.schemaFile ? `[JSON Schema](${record.schemaFile})` : record.codec?.kind ?? record.dataFormats.join(', ')} | ${record.encryptionRequired ? 'Encrypted' : 'Plaintext'} | ${record.role ? 'Membership' : record.immutable ? 'Immutable' : 'Mutable'} |`);
  const actionRows = records.map(record => `| \`${record.path}\` | ${record.actions.length === 0 ? 'Owner only' : record.actions.map(actionDescription).join('<br>')} |`);
  const providerLines = Object.entries(definition.uses ?? {}).map(([alias, uri]) => {
    const provider = inputs.get(uri);
    return `- \`${alias}\`: [${provider.catalog.name}](../${provider.id}/README.md) — \`${uri}\``;
  });
  const ownedExample = examples.find(example => !catalog.records.find(record => record.path === example.path).role);
  const firstPath = ownedExample.path;
  const data = ownedExample.encoding === 'json' ? JSON.stringify(ownedExample.data, null, 2) : `new Uint8Array([${[...Buffer.from(ownedExample.data, 'base64')].slice(0, 32).join(', ')}])`;
  const parentNote = firstPath.includes('/') ? '\nSupply the existing direct parent record\'s `contextId` as `parentContextId`.\n' : '';
  const usage = `const records = enbox.using(${name}Module).records;\nawait records.create('${firstPath}', {\n${firstPath.includes('/') ? '  parentContextId,\n' : ''}  data: ${data},\n});`;
  const readme = `# ${catalog.name}\n\n${catalog.description}\n\n` +
    `Module URI: \`${definition.module}\`\n\n` +
    `Import \`${name}Module\`, \`${name}Definition\`, \`${name}Codecs\`, and \`${name}Schemas\` from \`@enbox/modules/${id}\`. ` +
    `\`${name}Catalog\` includes the actual writable paths, bundled schemas, and examples.\n\n` +
    `## Artifacts\n\n- [Complete raw definition](definition.json)\n- [Authoring source](source/definition.ts)\n- [Directory metadata](catalog.json)\n- [Complete record examples](examples.json)\n\n` +
    `| Path | Representation | Data policy | Record policy |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
    `## Dependencies and ownership\n\n${providerLines.length ? providerLines.join('\n') + '\n\nOnly concrete local child paths are writable through this module; attachment aliases remain owned by their providers.\n' : 'This module has no structural module dependencies. Payload links retain their targets\' ownership and permissions.\n'}\n` +
    `The definition's \`published\` flag describes definition discovery. Record access is governed by the definition's explicit actions. ` +
    `Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is \`{}\`. ` +
    `Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.\n\n` +
    `## Actions\n\nThe owner retains tenant authority. These rules describe additional authority. ` +
    `\`update\`, \`delete\`, and \`prune\` act on the signer's own authored records; their \`co-\` variants allow acting on other authors' records. ` +
    `A \`who: recipient\` rule is scoped to that record's recipient: \`co-delete\` on a role assignment allows self-removal, never removal of another recipient. ` +
    `Self-removal uses the actor rule without invoking \`moduleRole\`. Viewers are read-only apart from leaving their own membership.\n\n` +
    `| Path | Additional authority |\n| --- | --- |\n${actionRows.join('\n')}\n\n` +
    `Immutable records reject updates. A singleton uses \`$recordLimit\` projection semantics; it does not reject every competing create. ` +
    `Pruning follows actual descendants, including composed descendants; data links do not cascade.\n\n` +
    ((catalog.notes ?? []).length === 0 ? '' : `## Contract notes\n\n${catalog.notes.map(note => `- ${note}`).join('\n')}\n\n`) +
    `## Capture contract\n\n**Identity:** ${catalog.capture.identity}\n\n**Workflow:** ${catalog.capture.workflow}\n\n` +
    `**Exclude:** ${catalog.capture.exclude.join(' ')}\n\n` +
    `## Use\n\nStart with an authenticated Enbox session and include this module in the application's module manifest. ` +
    `Dependency artifacts are carried by the typed module and installed before consumers.\n${parentNote}\n` +
    '```ts\n' + `import { ${name}Module } from '@enbox/modules/${id}';\n\n${usage}\n` + '```\n\n' +
    `The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. ` +
    `See the [package guide](../../README.md) for shared reference, money, source, and access semantics.\n`;
  expected.set(join(directory, 'README.md'), readme);
}

const generatedCatalog = `import type { TypedModule } from '@enbox/api';\nimport type { ModuleCatalogEntry } from '../catalog-types.js';\n\n` +
  [...catalogImports, ...moduleImports].join('\n') + '\n\n' +
  `export const moduleCatalog: readonly ModuleCatalogEntry[] = Object.freeze([${catalogNames.join(', ')}]);\n` +
  `export const standardModules: readonly TypedModule[] = Object.freeze([${moduleNames.join(', ')}]);\n`;
expected.set(join(generatedRoot, 'catalog.ts'), await typescript(generatedCatalog, join(generatedRoot, 'catalog.ts')));
const rootSource = `/** Complete standard DWN modules. Prefer subpath imports when using a small subset. */\n` +
  rootExports.join('\n') + `\nexport * from './catalog-types.js';\nexport * from './catalog.js';\nexport * from './profile-reader.js';\n`;
expected.set(join(packageRoot, 'src/index.ts'), await typescript(rootSource, join(packageRoot, 'src/index.ts')));
expected.set(join(sourceRoot, 'index.json'), JSON.stringify({ modules: index }, null, 2) + '\n');

const stale = [];
for (const [path, content] of expected) {
  if (check) {
    const current = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (current !== content) { stale.push(path); }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
if (stale.length !== 0) {
  throw new Error(`Generated module artifacts are stale:\n${stale.join('\n')}\nRun bun run generate in packages/modules.`);
}
console.log(`${check ? 'Checked' : 'Generated'} ${inputs.size} complete modules and their individual artifacts.`);
