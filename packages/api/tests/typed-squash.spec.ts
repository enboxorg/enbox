import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnApi, RecordsWriteRequest } from '../src/dwn-api.js';

import { beforeEach, describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { TypedEnbox } from '../src/typed-enbox.js';

// ---------------------------------------------------------------------------
// Offline unit coverage for #972 — the typed `create` MUST forward `squash`
// to the low-level `records.write`. These tests don't touch a DWN, agent, or
// network: they capture the request handed to `_dwn.records.write` via a fake
// DwnApi, so they verify the forwarding contract directly and deterministically.
// (End-to-end squash *behavior* — compaction, backstop — is covered against a
// real DWN in typed-protocol.spec.ts and exhaustively in dwn-sdk-js's
// records-squash.spec.ts.)
// ---------------------------------------------------------------------------

const SquashDefinition = {
  protocol  : 'https://example.com/protocols/squash-unit',
  published : true,
  types     : {
    doc      : { schema: 'https://example.com/schemas/doc', dataFormats: ['application/json'] },
    snapshot : { schema: 'https://example.com/schemas/snapshot', dataFormats: ['application/json'] },
  },
  structure: {
    doc: {
      $actions : [{ who: 'anyone', can: ['create', 'read'] }],
      snapshot : {
        $immutable : true,
        $squash    : true,
        $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
      },
    },
  },
} as const satisfies ProtocolDefinition;

type SquashSchemaMap = { doc: { n?: string }; snapshot: { v?: string } };

const SquashProtocol = defineProtocol(SquashDefinition, {} as SquashSchemaMap);

/** A fake DwnApi that records every `records.write` request and returns 202. */
function makeCapturingDwn(): { dwn: DwnApi; writes: RecordsWriteRequest[] } {
  const writes: RecordsWriteRequest[] = [];
  const dwn = {
    records: {
      write: async (request: RecordsWriteRequest) => {
        writes.push(request);
        return { status: { code: 202, detail: 'Accepted' }, record: undefined };
      },
    },
  } as unknown as DwnApi;
  return { dwn, writes };
}

describe('TypedEnbox create() — squash forwarding (#972)', () => {
  let dwn: DwnApi;
  let writes: RecordsWriteRequest[];
  let typed: TypedEnbox<typeof SquashDefinition, SquashSchemaMap>;

  beforeEach(() => {
    ({ dwn, writes } = makeCapturingDwn());
    typed = new TypedEnbox(dwn, SquashProtocol);
    // Skip auto-configure: _ensureReady() then only validates the path against
    // the in-memory definition (no agent/DWN calls).
    (typed as unknown as { _configured: boolean })._configured = true;
  });

  it('forwards squash: true to the low-level records.write', async () => {
    const { status } = await typed.records.create('doc/snapshot', {
      data   : { v: 's1' },
      squash : true,
    });

    expect(status.code).toBe(202);
    expect(writes).toHaveLength(1);
    expect(writes[0].squash).toBe(true);
  });

  it('passes squash as undefined (never a falsy false) when not requested', async () => {
    await typed.records.create('doc/snapshot', { data: { v: 's1' } });

    expect(writes[0].squash).toBeUndefined();
    // explicitly NOT `false` — parity with omitting the field entirely
    expect(writes[0].squash).not.toBe(false);
  });

  it('forwards squash alongside every other create field (none dropped)', async () => {
    await typed.records.create('doc/snapshot', {
      data            : { v: 's1' },
      squash          : true,
      parentContextId : 'parent-ctx',
      recipient       : 'did:example:bob',
      protocolRole    : 'collaborator',
      tags            : { kind: 'snapshot' },
      published       : true,
      dataFormat      : 'application/json',
    });

    const req = writes[0];
    expect(req.squash).toBe(true);
    expect(req.parentContextId).toBe('parent-ctx');
    expect(req.recipient).toBe('did:example:bob');
    expect(req.protocolRole).toBe('collaborator');
    expect(req.tags).toEqual({ kind: 'snapshot' });
    expect(req.published).toBe(true);
    expect(req.dataFormat).toBe('application/json');
    // protocol + path are auto-injected from the definition
    expect(req.protocol).toBe(SquashDefinition.protocol);
    expect(req.protocolPath).toBe('doc/snapshot');
  });

  it('scopes squash per-call — only the create that sets it carries it', async () => {
    await typed.records.create('doc', { data: { n: 'd' } });                 // no squash
    await typed.records.create('doc/snapshot', { data: { v: 's' }, squash: true });
    await typed.records.create('doc/snapshot', { data: { v: 's2' } });        // no squash

    expect(writes.map((w) => w.squash)).toEqual([undefined, true, undefined]);
  });
});
