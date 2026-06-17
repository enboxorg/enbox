import type { AbstractLevel } from 'abstract-level';

import type { ProtocolReference, SyncIdentityOptions } from './types/sync.js';

import { lexicographicalCompare, normalizeSyncProtocols } from './types/sync.js';

const KEY_SEP = '^';
const WILDCARD_PROTOCOL = '*';

type LevelBatchOperation =
  | { type: 'del'; key: string }
  | { type: 'put'; key: string; value: string };

/**
 * Device-local protocol reference index. Rows are keyed by tenant, protocol,
 * and referencer; active visibility is simply row existence.
 */
export class ProtocolReferenceIndex {
  private readonly _sublevel: AbstractLevel<string | Buffer | Uint8Array, string, string>;

  public static readonly wildcardProtocol = WILDCARD_PROTOCOL;

  public constructor(db: AbstractLevel<string | Buffer | Uint8Array>) {
    this._sublevel = db.sublevel('protocolReferences') as unknown as AbstractLevel<string | Buffer | Uint8Array, string, string>;
  }

  public async assertSelfReference(tenantDid: string, protocol: string): Promise<void> {
    await this.putReference({
      tenantDid,
      protocol,
      kind       : 'self',
      referencer : ProtocolReferenceIndex.selfReferencer(),
    });
  }

  public async deleteSelfReference(tenantDid: string, protocol: string): Promise<void> {
    await this.deleteReference(tenantDid, protocol, ProtocolReferenceIndex.selfReferencer());
  }

  public async replaceScopeReferences(
    tenantDid: string,
    identityDid: string,
    protocols: SyncIdentityOptions['protocols'],
  ): Promise<void> {
    const referencer = ProtocolReferenceIndex.scopeReferencer(identityDid);
    const batch = await this.deleteReferencesByReferencerBatch(tenantDid, referencer);

    if (protocols === 'all') {
      batch.push(this.putReferenceOperation({
        tenantDid,
        protocol : WILDCARD_PROTOCOL,
        kind     : 'scope-all',
        referencer,
      }));
    } else {
      for (const protocol of normalizeSyncProtocols(protocols)) {
        batch.push(this.putReferenceOperation({
          tenantDid,
          protocol,
          kind: 'scope',
          referencer,
        }));
      }
    }

    await this.applyBatch(batch);
  }

  public async deleteScopeReferences(tenantDid: string, identityDid: string): Promise<void> {
    await this.deleteReferencesByReferencer(tenantDid, ProtocolReferenceIndex.scopeReferencer(identityDid));
  }

  public async replaceClosureReferences(
    tenantDid: string,
    sourceProtocol: string,
    targetProtocols: Iterable<string>,
  ): Promise<void> {
    const referencer = ProtocolReferenceIndex.closureReferencer(sourceProtocol);
    const batch = await this.deleteReferencesByReferencerBatch(tenantDid, referencer);
    const targets = [...new Set(targetProtocols)].sort(lexicographicalCompare);

    for (const protocol of targets) {
      if (protocol === sourceProtocol) {
        continue;
      }
      batch.push(this.putReferenceOperation({
        tenantDid,
        protocol,
        kind: 'closure',
        referencer,
        sourceProtocol,
      }));
    }

    await this.applyBatch(batch);
  }

  public async clearDerivedReferences(tenantDid: string): Promise<void> {
    const batch: LevelBatchOperation[] = [];
    for await (const [key, value] of this.iterateTenantRows(tenantDid)) {
      const reference = JSON.parse(value) as ProtocolReference;
      if (reference.kind !== 'self') {
        batch.push({ type: 'del', key });
      }
    }
    await this.applyBatch(batch);
  }

  public async getReferences(tenantDid: string): Promise<ProtocolReference[]> {
    const references: ProtocolReference[] = [];
    for await (const [, value] of this.iterateTenantRows(tenantDid)) {
      references.push(JSON.parse(value) as ProtocolReference);
    }

    references.sort((a, b) =>
      lexicographicalCompare(a.protocol, b.protocol) ||
      lexicographicalCompare(a.referencer, b.referencer)
    );
    return references;
  }

  public async getSelfReferencedProtocols(tenantDid: string): Promise<string[]> {
    const protocols: string[] = [];
    for (const reference of await this.getReferences(tenantDid)) {
      if (reference.kind === 'self') {
        protocols.push(reference.protocol);
      }
    }
    return protocols;
  }

  public async getExactReferencedProtocols(tenantDid: string): Promise<string[]> {
    const protocols = new Set<string>();
    for (const reference of await this.getReferences(tenantDid)) {
      if (reference.protocol !== WILDCARD_PROTOCOL) {
        protocols.add(reference.protocol);
      }
    }
    return [...protocols].sort(lexicographicalCompare);
  }

  public async hasReference(tenantDid: string, protocol: string): Promise<boolean> {
    if (await this.hasProtocolRow(tenantDid, WILDCARD_PROTOCOL)) {
      return true;
    }
    return this.hasProtocolRow(tenantDid, protocol);
  }

  public static scopeReferencer(identityDid: string): string {
    return `scope:${identityDid}`;
  }

  public static closureReferencer(sourceProtocol: string): string {
    return `closure:${sourceProtocol}`;
  }

  public static selfReferencer(): string {
    return 'self';
  }

  private async putReference(reference: Omit<ProtocolReference, 'createdAt'>): Promise<void> {
    await this._sublevel.put(
      ProtocolReferenceIndex.buildKey(reference.tenantDid, reference.protocol, reference.referencer),
      JSON.stringify({
        ...reference,
        createdAt: new Date().toISOString(),
      } satisfies ProtocolReference),
    );
  }

  private putReferenceOperation(reference: Omit<ProtocolReference, 'createdAt'>): LevelBatchOperation {
    return {
      type  : 'put',
      key   : ProtocolReferenceIndex.buildKey(reference.tenantDid, reference.protocol, reference.referencer),
      value : JSON.stringify({
        ...reference,
        createdAt: new Date().toISOString(),
      } satisfies ProtocolReference),
    };
  }

  private async deleteReference(tenantDid: string, protocol: string, referencer: string): Promise<void> {
    await this._sublevel.del(ProtocolReferenceIndex.buildKey(tenantDid, protocol, referencer));
  }

  private async deleteReferencesByReferencer(tenantDid: string, referencer: string): Promise<void> {
    await this.applyBatch(await this.deleteReferencesByReferencerBatch(tenantDid, referencer));
  }

  private async deleteReferencesByReferencerBatch(tenantDid: string, referencer: string): Promise<LevelBatchOperation[]> {
    const batch: LevelBatchOperation[] = [];
    for await (const [key, value] of this.iterateTenantRows(tenantDid)) {
      const reference = JSON.parse(value) as ProtocolReference;
      if (reference.referencer === referencer) {
        batch.push({ type: 'del', key });
      }
    }
    return batch;
  }

  private async hasProtocolRow(tenantDid: string, protocol: string): Promise<boolean> {
    for await (const [, value] of this.iterateProtocolRows(tenantDid, protocol)) {
      const reference = JSON.parse(value) as ProtocolReference;
      if (reference.tenantDid === tenantDid && reference.protocol === protocol) {
        return true;
      }
    }
    return false;
  }

  private iterateTenantRows(tenantDid: string): AsyncIterable<[string, string]> {
    const prefix = ProtocolReferenceIndex.tenantKeyPrefix(tenantDid);
    return this._sublevel.iterator({
      gte : prefix,
      lt  : `${prefix}\xff`,
    }) as AsyncIterable<[string, string]>;
  }

  private iterateProtocolRows(tenantDid: string, protocol: string): AsyncIterable<[string, string]> {
    const prefix = ProtocolReferenceIndex.protocolKeyPrefix(tenantDid, protocol);
    return this._sublevel.iterator({
      gte : prefix,
      lt  : `${prefix}\xff`,
    }) as AsyncIterable<[string, string]>;
  }

  private async applyBatch(batch: LevelBatchOperation[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    await this._sublevel.batch(batch);
  }

  private static tenantKeyPrefix(tenantDid: string): string {
    return `${ProtocolReferenceIndex.encodeKeyPart(tenantDid)}${KEY_SEP}`;
  }

  private static protocolKeyPrefix(tenantDid: string, protocol: string): string {
    return `${ProtocolReferenceIndex.tenantKeyPrefix(tenantDid)}${ProtocolReferenceIndex.encodeKeyPart(protocol)}${KEY_SEP}`;
  }

  private static buildKey(tenantDid: string, protocol: string, referencer: string): string {
    return `${ProtocolReferenceIndex.protocolKeyPrefix(tenantDid, protocol)}${ProtocolReferenceIndex.encodeKeyPart(referencer)}`;
  }

  private static encodeKeyPart(value: string): string {
    return encodeURIComponent(value);
  }
}
