import { describe, expect, it } from 'bun:test';

import { AppStore } from '../src/mainview/state/app-store.js';

describe('AppStore', () => {
  describe('ToastStore', () => {
    it('should create a toast entry with default neutral tone', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: 'hello' });
      expect(entry).not.toBeNull();
      expect(entry!.message).toBe('hello');
      expect(entry!.tone).toBe('neutral');
      expect(entry!.duration).toBe(5000);
    });

    it('should trim message whitespace', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: '  trimmed  ' });
      expect(entry!.message).toBe('trimmed');
    });

    it('should return null for empty messages', () => {
      const store = new AppStore();
      expect(store.toast.notify({ message: '' })).toBeNull();
      expect(store.toast.notify({ message: '   ' })).toBeNull();
    });

    it('should use 7000ms duration for danger tone', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: 'error', tone: 'danger' });
      expect(entry!.tone).toBe('danger');
      expect(entry!.duration).toBe(7000);
    });

    it('should normalize unknown tones to neutral', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: 'msg', tone: 'bogus' });
      expect(entry!.tone).toBe('neutral');
    });

    it('should accept valid tone values', () => {
      const store = new AppStore();
      for (const tone of ['brand', 'success', 'warning', 'danger'] as const) {
        const entry = store.toast.notify({ message: `msg-${tone}`, tone, allowDuplicate: true });
        expect(entry!.tone).toBe(tone);
      }
    });

    it('should respect a custom duration', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: 'custom', duration: 1234 });
      expect(entry!.duration).toBe(1234);
    });

    it('should ignore invalid duration values', () => {
      const store = new AppStore();
      expect(store.toast.notify({ message: 'a', duration: -1 })!.duration).toBe(5000);
      expect(store.toast.notify({ message: 'b', duration: 0, allowDuplicate: true })!.duration).toBe(5000);
      expect(store.toast.notify({ message: 'c', duration: Infinity, allowDuplicate: true })!.duration).toBe(5000);
    });

    it('should deduplicate identical toasts within the default window', () => {
      const store = new AppStore();
      const first = store.toast.notify({ message: 'dup' });
      const second = store.toast.notify({ message: 'dup' });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('should allow duplicates when allowDuplicate is true', () => {
      const store = new AppStore();
      const first = store.toast.notify({ message: 'dup', allowDuplicate: true });
      const second = store.toast.notify({ message: 'dup', allowDuplicate: true });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.id).not.toBe(second!.id);
    });

    it('should add entries to the signal and consume removes them', () => {
      const store = new AppStore();
      const entry = store.toast.notify({ message: 'tracked' })!;
      expect(store.toast.entries.get()).toHaveLength(1);
      expect(store.toast.entries.get()[0].id).toBe(entry.id);

      store.toast.consume(entry.id);
      expect(store.toast.entries.get()).toHaveLength(0);
    });

    it('should clear all entries', () => {
      const store = new AppStore();
      store.toast.notify({ message: 'a', allowDuplicate: true });
      store.toast.notify({ message: 'b', allowDuplicate: true });
      expect(store.toast.entries.get().length).toBeGreaterThanOrEqual(2);

      store.toast.clear();
      expect(store.toast.entries.get()).toHaveLength(0);
    });

    it('should assign incrementing IDs', () => {
      const store = new AppStore();
      const a = store.toast.notify({ message: 'a', allowDuplicate: true })!;
      const b = store.toast.notify({ message: 'b', allowDuplicate: true })!;
      expect(b.id).toBeGreaterThan(a.id);
    });
  });

  describe('ConnectionStore', () => {
    it('should start in connecting state', () => {
      const store = new AppStore();
      expect(store.connection.snapshot.get().state).toBe('connecting');
    });

    it('should transition to online', () => {
      const store = new AppStore();
      store.connection.markOnline({
        endpoint      : 'http://localhost:3000',
        updatedAt     : '12:00:00',
        serverUrl     : 'http://localhost:3000',
        serverName    : '@enbox/dwn-server',
        serverVersion : '1.0.0',
        wsSupport     : 'Enabled',
      });

      const snap = store.connection.snapshot.get();
      expect(snap.state).toBe('online');
      expect(snap.serverName).toBe('@enbox/dwn-server');
    });

    it('should transition to offline', () => {
      const store = new AppStore();
      store.connection.markOffline({ endpoint: 'http://localhost:3000' });
      const snap = store.connection.snapshot.get();
      expect(snap.state).toBe('offline');
      expect(snap.endpoint).toBe('http://localhost:3000');
      expect(snap.serverName).toBe('--');
    });

    it('should compute badge label from state', () => {
      const store = new AppStore();
      expect(store.connection.badgeLabel.get()).toBe('Connecting...');

      store.connection.markOnline({
        endpoint      : 'http://localhost:3000',
        updatedAt     : '12:00:00',
        serverUrl     : 'http://localhost:3000',
        serverName    : 'srv',
        serverVersion : '1',
        wsSupport     : 'Enabled',
      });
      expect(store.connection.badgeLabel.get()).toBe('Online');

      store.connection.markOffline();
      expect(store.connection.badgeLabel.get()).toBe('Offline');
    });

    it('should compute badge variant from state', () => {
      const store = new AppStore();
      expect(store.connection.badgeVariant.get()).toBe('warning');

      store.connection.markOnline({
        endpoint      : 'http://localhost:3000',
        updatedAt     : '12:00:00',
        serverUrl     : 'http://localhost:3000',
        serverName    : 'srv',
        serverVersion : '1',
        wsSupport     : 'Enabled',
      });
      expect(store.connection.badgeVariant.get()).toBe('success');

      store.connection.markOffline();
      expect(store.connection.badgeVariant.get()).toBe('danger');
    });
  });

  describe('ResolverStore', () => {
    it('should start with an empty DID', () => {
      const store = new AppStore();
      expect(store.resolver.currentDid.get()).toBe('');
    });

    it('should set and trim the current DID', () => {
      const store = new AppStore();
      store.resolver.setCurrentDid('  did:dht:abc123  ');
      expect(store.resolver.currentDid.get()).toBe('did:dht:abc123');
    });
  });

  describe('IdentityStore', () => {
    it('should start with null wallet snapshot', () => {
      const store = new AppStore();
      expect(store.identity.walletSnapshot.get()).toBeNull();
      expect(store.identity.identities.get()).toEqual([]);
      expect(store.identity.activeManagedDidUri.get()).toBe('');
    });

    it('should compute active managed DID from snapshot', () => {
      const store = new AppStore();
      store.identity.setSnapshot({
        authState           : 'connected' as any,
        isConnected         : true,
        isLocked            : false,
        isConnecting        : false,
        activeManagedDidUri : 'did:dht:active',
        identities          : [],
        lastUpdatedAt       : new Date().toISOString(),
      });
      expect(store.identity.activeManagedDidUri.get()).toBe('did:dht:active');
    });

    it('should clear the snapshot', () => {
      const store = new AppStore();
      store.identity.setSnapshot({
        authState     : 'connected' as any,
        isConnected   : true,
        isLocked      : false,
        isConnecting  : false,
        identities    : [],
        lastUpdatedAt : new Date().toISOString(),
      });
      store.identity.clear();
      expect(store.identity.walletSnapshot.get()).toBeNull();
    });
  });

  describe('AppsStore', () => {
    it('should start with default placeholder connections', () => {
      const store = new AppStore();
      const connections = store.apps.connections.get();
      expect(connections.length).toBeGreaterThan(0);
    });

    it('should accept valid connections via setConnections', () => {
      const store = new AppStore();
      store.apps.setConnections([
        { id: 'test-1', name: 'Test App', url: 'https://test.example' },
      ]);
      const connections = store.apps.connections.get();
      expect(connections).toHaveLength(1);
      expect(connections[0].id).toBe('test-1');
      expect(connections[0].name).toBe('Test App');
    });

    it('should filter out invalid connections', () => {
      const store = new AppStore();
      store.apps.setConnections([
        { id: 'valid', name: 'Valid', url: 'https://valid.example' },
        { id: '', name: 'No ID', url: 'https://noid.example' },
        null,
        'not-an-object',
        { id: 'also-valid', name: 'Also Valid', url: 'https://also.example' },
      ]);
      const connections = store.apps.connections.get();
      expect(connections).toHaveLength(2);
      expect(connections[0].id).toBe('valid');
      expect(connections[1].id).toBe('also-valid');
    });

    it('should fall back to defaults when all connections are invalid', () => {
      const store = new AppStore();
      store.apps.setConnections([null, undefined, '', 42]);
      const connections = store.apps.connections.get();
      // Falls back to default placeholder connections
      expect(connections.length).toBeGreaterThan(0);
    });

    it('should trim connection fields', () => {
      const store = new AppStore();
      store.apps.setConnections([
        { id: '  a  ', name: '  App  ', url: '  https://app.example  ', status: '  Active  ' },
      ]);
      const conn = store.apps.connections.get()[0];
      expect(conn.id).toBe('a');
      expect(conn.name).toBe('App');
      expect(conn.url).toBe('https://app.example');
      expect(conn.status).toBe('Active');
    });

    it('should clone scopes arrays to prevent external mutation', () => {
      const store = new AppStore();
      const original = ['read', 'write'];
      store.apps.setConnections([
        { id: 'x', name: 'X', url: 'https://x.example', scopes: original },
      ]);
      const scopes = store.apps.connections.get()[0].scopes;
      expect(scopes).toEqual(['read', 'write']);
      // Mutating the original should not affect the store
      original.push('delete');
      expect(store.apps.connections.get()[0].scopes).toEqual(['read', 'write']);
    });
  });

  describe('RouteStore', () => {
    it('should start with home as active route', () => {
      const store = new AppStore();
      expect(store.route.active.get()).toBe('home');
    });

    it('should update the active route', () => {
      const store = new AppStore();
      store.route.setActive('resolver');
      expect(store.route.active.get()).toBe('resolver');
    });
  });

  describe('navigation', () => {
    it('should delegate navigate to the registered router', () => {
      const store = new AppStore();
      const navigated: string[] = [];
      store.setRouter({
        navigate(route: string): void {
          navigated.push(route);
        },
      });
      store.navigate('identity');
      expect(navigated).toEqual(['identity']);
    });

    it('should not throw when navigating without a router', () => {
      const store = new AppStore();
      expect(() => store.navigate('home')).not.toThrow();
    });
  });
});
