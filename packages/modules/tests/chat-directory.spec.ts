import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { PayloadSchema } from '../src/catalog-types.js';

import cases from '../directory/routing-examples.json' with { type: 'json' };
import { getModuleCatalogEntry } from '../src/catalog.js';
import { readFile } from 'node:fs/promises';
import { resolveModuleGraph } from '@enbox/dwn-sdk-js';
import { chatDirectory, chatTargetsFor } from '../src/chat-directory.js';
import { describe, expect, it } from 'bun:test';

describe('conversation directory', () => {
  it('offers only concrete encrypted JSON payloads and resolves required parents across module boundaries', async () => {
    const bundles: { id: string; description: string; definition: ModuleDefinition; schemas: Record<string, PayloadSchema> }[] =
      JSON.parse(await readFile(new URL('../directory/briand.json', import.meta.url), 'utf8'));
    const definitions = new Map(bundles.map(bundle => [bundle.definition.module, bundle.definition]));
    expect(new Set(bundles.map(bundle => bundle.id)).size).toBe(chatDirectory.length);
    for (const entry of chatDirectory) {
      const bundle = bundles.find(bundle => bundle.id === entry.id)!;
      expect(bundle.definition).toEqual(getModuleCatalogEntry(entry.id)!.definition);
      expect(bundle.description).toBe(entry.summary);
      const graph = resolveModuleGraph(definitions.get(entry.module)!, uri => definitions.get(uri), { requireKeyAgreement: false });
      const schemas = new Map(Object.entries(bundle.schemas));
      for (const target of entry.paths) {
        const node = graph.nodesByDeclaredPath.get(target.path)!;
        expect(node.kind).toBe('record');
        expect(node.ruleSet.$role).not.toBe(true);
        expect(node.recordType.encryptionRequired).toBe(true);
        expect(node.recordType.dataFormats).toContain('application/json');
        expect(schemas.get(target.schemaUri)).toEqual(getModuleCatalogEntry(entry.id)!.records.find(r => r.path === target.path)!.schema);
        if (target.parent) {
          expect(target.parent).toEqual({ module: node.expectedParent!.owningModuleUri, path: node.expectedParent!.owningModulePath });
          expect(chatTargetsFor(entry.module)).not.toContain(target);
        }
        expect(chatTargetsFor(entry.module, target.parent)).toContain(target);
      }
    }
  });

  it('requires an existing financial account to present a position and omits app-only alternatives', () => {
    const holdings = getModuleCatalogEntry('investment-holdings')!.uri;
    expect(chatTargetsFor(holdings)).toEqual([]);
    expect(chatTargetsFor(holdings, { module: getModuleCatalogEntry('transactions')!.uri, path: 'account' })).toEqual([]);
    expect(chatTargetsFor(holdings, { module: getModuleCatalogEntry('financial-accounts')!.uri, path: 'account' }).map(t => t.path))
      .toEqual(['account/position']);
    expect(chatTargetsFor('https://example.org/missing')).toEqual([]);
    const ids = new Set(chatDirectory.map(entry => entry.id));
    for (const id of ['shared-groceries', 'conversations', 'profile', 'connect', 'notebook-realtime', 'credentials']) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('keeps contrasting chat examples tied to offered paths and includes abstention and clarification examples', () => {
    const paths = new Set(chatDirectory.flatMap(entry => entry.paths.map(target => entry.id + '#' + target.path)));
    for (const example of cases) {
      if (example.decision === 'propose') {
        expect(example.targets.length).toBeGreaterThan(0);
        for (const target of example.targets) { expect(paths.has(target.id + '#' + target.path)).toBe(true); }
      } else { expect(example.targets).toEqual([]); }
    }
    expect(new Set(cases.map(example => example.decision))).toEqual(new Set(['propose', 'clarify', 'abstain']));
  });
});
