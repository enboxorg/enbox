import type { BrowserApplicationOptions } from '../src/application.js';

import { describe, expect, it } from 'bun:test';

import { createConnectionStore, defineProtocol, defineStore, recordCodecs } from '@enbox/api';

import { createApplication, getApplicationWalletOptions } from '../src/application.js';

const Notes = defineProtocol({
  protocol  : 'https://example.com/browser-application',
  published : false,
  types     : { note: { dataFormats: ['application/json'] } },
  structure : { note: {} },
} as const, { note: recordCodecs.json<{ title: string }>() });

describe('browser applications', () => {
  it('derives its manifest without running features and retains immutable wallet defaults', async () => {
    let factories = 0;
    const feature = defineStore({ protocols: { notes: Notes }, create: (): object => { factories++; return {}; } });
    const wallet = { appName: 'Notes', appIcon: '/notes.svg' };
    const app = createApplication({ stores: { feature }, wallet });
    try {
      expect(factories).toBe(0);
      expect(app.connection.getSnapshot().phase).toBe('initializing');
      expect(app.manifest.protocols).toHaveLength(1);
      wallet.appName = 'Changed after construction';
      expect(getApplicationWalletOptions(app)).toEqual({ appName: 'Notes', appIcon: '/notes.svg' });
      expect(Object.isFrozen(getApplicationWalletOptions(app))).toBe(true);
    } finally { await app.dispose(); }
  });

  it('preserves a custom native connect handler without browser wallet overrides', async () => {
    const feature = defineStore({ protocols: { notes: Notes }, create: (): object => ({}) });
    let connects = 0;
    const app = createApplication({
      stores         : { feature },
      connectHandler : { requestAccess: async () => { connects++; return undefined; } },
    });
    try {
      expect(connects).toBe(0);
      expect(getApplicationWalletOptions(app)).toBeUndefined();
    } finally { await app.dispose(); }
  });

  it('constructs one supplied native connection from the derived manifest', async () => {
    let constructions = 0;
    const feature = defineStore({ protocols: { notes: Notes }, create: (): object => ({}) });
    const app = createApplication({
      stores     : { feature },
      connection : (manifest) => {
        constructions++;
        expect(manifest.protocols).toHaveLength(1);
        return createConnectionStore({ application: manifest });
      },
    });
    try {
      expect(constructions).toBe(1);
      expect(app.connection.getSnapshot().phase).toBe('initializing');
      expect(getApplicationWalletOptions(app)).toBeUndefined();
    } finally { await app.dispose(); }
  });

  it('rejects competing owners of the derived manifest or browser handler', () => {
    const stores = { feature: defineStore({ protocols: { notes: Notes }, create: (): object => ({}) }) };
    expect(() => createApplication({
      stores, wallet: {}, connectHandler: { requestAccess: async () => undefined },
    } as unknown as BrowserApplicationOptions)).toThrow('choose wallet options or a connectHandler');
    expect(() => createApplication({
      stores, wallet: {}, connection: () => { throw new Error('Must not construct.'); },
    } as unknown as BrowserApplicationOptions)).toThrow('a native connection factory owns its connect handler');
    for (const key of ['application', 'connectHandler', 'auth', 'agent']) {
      expect(() => createApplication({
        stores, connection: { [key]: undefined },
      } as unknown as BrowserApplicationOptions)).toThrow(`connection.${key} is owned by the application`);
    }
  });
});
