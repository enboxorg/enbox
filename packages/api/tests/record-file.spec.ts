import { describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { DwnApi } from '../src/dwn-api.js';

describe('File record data', () => {
  it('should preserve File bytes through native writes, updates, and fresh reads', async () => {
    const harness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/file-record-${crypto.randomUUID()}`,
    });
    const frame = typeof document === 'undefined' ? undefined : document.createElement('iframe');
    try {
      if (frame !== undefined) {
        document.body.append(frame);
      }
      const FileConstructor = frame === undefined ? File : (frame.contentWindow as Window & typeof globalThis).File;
      await harness.createAgentDid({ publish: false });
      const owner = await harness.createIdentity({ name: 'File owner', publish: false });
      const dwn = new DwnApi({ agent: harness.agent, connectedDid: owner.did.uri });
      const { status: protocolStatus } = await dwn.protocols.configure({
        definition: {
          protocol  : 'https://example.com/files',
          published : false,
          types     : { file: { dataFormats: ['application/json'] } },
          structure : { file: {} },
        },
      });
      expect(protocolStatus.code).toBe(202);

      const initial = new FileConstructor(['{"version":1}'], 'initial.json', { type: 'application/json' });
      const replacement = new FileConstructor(['{"version":2}'], 'replacement.json', { type: 'application/json' });
      if (frame !== undefined) {
        expect(initial).not.toBeInstanceOf(Blob);
        expect(replacement).not.toBeInstanceOf(Blob);
      }
      const { record, status } = await dwn.records.write({
        data         : initial,
        dataFormat   : 'application/json',
        protocol     : 'https://example.com/files',
        protocolPath : 'file',
      });
      expect(status.code).toBe(202);

      const firstRead = await dwn.records.read({ filter: { recordId: record!.id } });
      expect(firstRead.status.code).toBe(200);
      expect(firstRead.record!.dataFormat).toBe('application/json');
      expect(await firstRead.record!.data.text()).toBe(await initial.text());

      await record!.update({ data: replacement });

      const updatedRead = await dwn.records.read({ filter: { recordId: record!.id } });
      expect(updatedRead.status.code).toBe(200);
      expect(updatedRead.record!.dataFormat).toBe('application/json');
      expect(updatedRead.record!.dataSize).toBe(replacement.size);
      expect(await updatedRead.record!.data.text()).toBe(await replacement.text());
    } finally {
      frame?.remove();
      await harness.clearStorage();
      await harness.closeStorage();
    }
  });
});
