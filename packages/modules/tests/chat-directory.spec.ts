import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { PayloadSchema } from '../src/catalog-types.js';

import cases from '../directory/routing-examples.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { resolveModuleGraph } from '@enbox/dwn-sdk-js';
import { chatDirectory, chatTargetsFor } from '../src/chat-directory.js';
import { describe, expect, it } from 'bun:test';
import { getModuleCatalogEntry, moduleCatalog, standardModules } from '../src/catalog.js';

type BriandBundle = {
  id: string;
  description: string;
  definition: ModuleDefinition;
  schemas: Record<string, PayloadSchema>;
  capturePaths: string[];
  workflow?: string;
};

async function readBundles(): Promise<BriandBundle[]> {
  return JSON.parse(await readFile(new URL('../directory/briand.json', import.meta.url), 'utf8'));
}

describe('conversation directory', () => {
  it('publishes identical module identities in typed modules, the catalogue, the artifact index, chat discovery and Briand', async () => {
    const index: { modules: { id: string; moduleUri: string }[] } =
      JSON.parse(await readFile(new URL('../modules/index.json', import.meta.url), 'utf8'));
    const bundles = await readBundles();
    const expected = moduleCatalog.map(entry => [entry.id, entry.uri]);
    expect(new Set(moduleCatalog.map(entry => entry.uri)).size).toBe(expected.length);
    expect(standardModules.map(module => module.definition.module)).toEqual(moduleCatalog.map(entry => entry.uri));
    expect(index.modules.map(entry => [entry.id, entry.moduleUri])).toEqual(expected);
    expect(chatDirectory.map(entry => [entry.id, entry.module])).toEqual(expected);
    expect(bundles.map(bundle => [bundle.id, bundle.definition.module])).toEqual(expected);
  });

  it('offers only concrete encrypted JSON payloads and resolves required parents across module boundaries', async () => {
    const bundles = await readBundles();
    const definitions = new Map(bundles.map(bundle => [bundle.definition.module, bundle.definition]));
    expect(new Set(bundles.map(bundle => bundle.id)).size).toBe(chatDirectory.length);
    for (const entry of chatDirectory) {
      const bundle = bundles.find(bundle => bundle.id === entry.id)!;
      const catalog = getModuleCatalogEntry(entry.id)!;
      expect(bundle.definition).toEqual(catalog.definition);
      const allSchemas = Object.fromEntries(catalog.records.filter(record => record.schema !== undefined)
        .map(record => [record.schemaUri!, record.schema!]));
      expect(bundle.schemas).toEqual(allSchemas);
      expect(bundle.description).toBe(entry.summary);
      expect(bundle.capturePaths).toEqual(entry.paths.map(target => target.path));
      expect(bundle.workflow).toBe(entry.workflow);
      if (entry.paths.length === 0) {
        expect(entry.workflow?.trim().length, entry.id).toBeGreaterThan(0);
        expect(chatTargetsFor(entry.module)).toEqual([]);
      }
      const graph = resolveModuleGraph(definitions.get(entry.module)!, uri => definitions.get(uri), { requireKeyAgreement: false });
      const schemas = new Map(Object.entries(bundle.schemas));
      for (const target of entry.paths) {
        const node = graph.nodesByDeclaredPath.get(target.path)!;
        expect(node.kind).toBe('record');
        expect(node.ruleSet.$role).not.toBe(true);
        expect(node.recordType.encryptionRequired).toBe(true);
        expect(node.recordType.dataFormats).toContain('application/json');
        expect(schemas.get(target.schemaUri)).toEqual(catalog.records.find(r => r.path === target.path)!.schema);
        if (target.parent) {
          expect(target.parent).toEqual({ module: node.expectedParent!.owningModuleUri, path: node.expectedParent!.owningModulePath });
          expect(chatTargetsFor(entry.module)).not.toContain(target);
        }
        expect(chatTargetsFor(entry.module, target.parent)).toContain(target);
      }
    }
  });

  it('requires an existing financial account to present a position', () => {
    const holdings = getModuleCatalogEntry('investment-holdings')!.uri;
    expect(chatTargetsFor(holdings)).toEqual([]);
    expect(chatTargetsFor(holdings, { module: getModuleCatalogEntry('transactions')!.uri, path: 'account' })).toEqual([]);
    expect(chatTargetsFor(holdings, { module: getModuleCatalogEntry('financial-accounts')!.uri, path: 'account' }).map(t => t.path))
      .toEqual(['account/position']);
    expect(chatTargetsFor('https://example.org/missing')).toEqual([]);
  });

  it('keeps contrasting chat examples tied to offered paths and includes abstention and clarification examples', () => {
    const paths = new Set(chatDirectory.flatMap(entry => entry.paths.map(target => entry.id + '#' + target.path)));
    for (const example of cases) {
      if (example.decision === 'propose') {
        expect(example.targets.length).toBeGreaterThan(0);
        for (const target of example.targets) { expect(paths.has(target.id + '#' + target.path)).toBe(true); }
      } else {
        expect(example.targets).toEqual([]);
        if (example.decision === 'workflow') {
          const destination = chatDirectory.find(module => module.id === example.module);
          expect(destination?.workflow?.trim().length, example.text).toBeGreaterThan(0);
        }
      }
    }
    expect(new Set(cases.map(example => example.decision))).toEqual(new Set(['propose', 'clarify', 'abstain', 'workflow']));
  });
});
