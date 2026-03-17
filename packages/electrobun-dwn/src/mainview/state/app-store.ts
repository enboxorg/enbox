import type { IdentityWalletSnapshot } from '../identity-runtime.js';

import { computed, signal } from '@lit-labs/signals';

export type RouteId =
  | 'home'
  | 'identity'
  | 'data'
  | 'apps'
  | 'permissions'
  | 'resolver';

export type ToastTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export type ToastOptions = {
  message: string;
  tone?: string;
  duration?: number;
  dedupeWindowMs?: number;
  allowDuplicate?: boolean;
};

export type ToastEntry = {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  createdAt: number;
};

export type ConnectionState = 'connecting' | 'online' | 'offline';

export type ConnectionSnapshot = {
  state: ConnectionState;
  endpoint: string;
  serverName: string;
  serverVersion: string;
  wsSupport: string;
  updatedAt: string;
  serverUrl: string;
};

export type AppConnection = {
  id: string;
  name: string;
  url: string;
  iconUrl?: string;
  status?: string;
  description?: string;
  connectedAt?: string;
  lastActivityAt?: string;
  scopes?: string[];
};

type RouteNavigator = {
  navigate(route: RouteId): void;
  getActiveRoute?: () => RouteId | null;
};

const defaultConnectionSnapshot: ConnectionSnapshot = {
  state         : 'connecting',
  endpoint      : '--',
  serverName    : '--',
  serverVersion : '--',
  wsSupport     : '--',
  updatedAt     : '--',
  serverUrl     : '',
};

// TODO: Remove placeholder app connections once real connection data is
// populated from protocol grants / DWN permission records.
const defaultAppConnections: AppConnection[] = [
  {
    id             : 'google-photos',
    name           : 'Google Photos',
    url            : 'https://photos.google.com',
    status         : 'Connected',
    description    : 'Photo and video library sync with album organization and search.',
    connectedAt    : '2026-02-17T14:08:00Z',
    lastActivityAt : '2026-03-07T23:41:00Z',
    scopes         : ['read profile', 'read media', 'upload media'],
  },
  {
    id             : 'dropbox',
    name           : 'Dropbox',
    url            : 'https://www.dropbox.com',
    status         : 'Connected',
    description    : 'File storage and backup sync for documents and media.',
    connectedAt    : '2026-01-21T09:30:00Z',
    lastActivityAt : '2026-03-07T22:10:00Z',
    scopes         : ['read files', 'write files', 'sync backups'],
  },
  {
    id             : 'notion',
    name           : 'Notion',
    url            : 'https://www.notion.so',
    status         : 'Limited',
    description    : 'Workspace integration for notes, tasks, and linked records.',
    connectedAt    : '2025-12-03T20:15:00Z',
    lastActivityAt : '2026-03-06T18:55:00Z',
    scopes         : ['read profile', 'read notes', 'write notes'],
  },
];

function cloneConnection(connection: AppConnection): AppConnection {
  return {
    ...connection,
    scopes: Array.isArray(connection.scopes) ? [...connection.scopes] : undefined,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeToastTone(tone: string): ToastTone {
  if (tone === 'brand' || tone === 'success' || tone === 'warning' || tone === 'danger') {
    return tone;
  }

  return 'neutral';
}

function defaultDurationForTone(tone: ToastTone): number {
  return tone === 'danger' ? 7000 : 5000;
}

function normalizeAppConnection(value: unknown): AppConnection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.name) || !isNonEmptyString(candidate.url)) {
    return null;
  }

  const normalized: AppConnection = {
    id   : candidate.id.trim(),
    name : candidate.name.trim(),
    url  : candidate.url.trim(),
  };

  if (isNonEmptyString(candidate.iconUrl)) {
    normalized.iconUrl = candidate.iconUrl.trim();
  }

  if (isNonEmptyString(candidate.status)) {
    normalized.status = candidate.status.trim();
  }

  if (isNonEmptyString(candidate.description)) {
    normalized.description = candidate.description.trim();
  }

  if (isNonEmptyString(candidate.connectedAt)) {
    normalized.connectedAt = candidate.connectedAt.trim();
  }

  if (isNonEmptyString(candidate.lastActivityAt)) {
    normalized.lastActivityAt = candidate.lastActivityAt.trim();
  }

  if (Array.isArray(candidate.scopes)) {
    normalized.scopes = candidate.scopes.filter(isNonEmptyString).map((scope) => scope.trim());
  }

  return normalized;
}

function normalizeAppConnections(connections: unknown[]): AppConnection[] {
  return connections
    .map(normalizeAppConnection)
    .filter((connection): connection is AppConnection => connection !== null)
    .map(cloneConnection);
}

class ToastStore {
  readonly entries = signal<ToastEntry[]>([]);

  private _nextId = 1;
  private _lastToastKey = '';
  private _lastToastShownAt = 0;

  notify(options: ToastOptions): ToastEntry | null {
    const trimmedMessage = String(options.message ?? '').trim();
    if (trimmedMessage.length === 0) {
      return null;
    }

    const tone = normalizeToastTone(String(options.tone ?? 'neutral'));
    const dedupeWindowMs = typeof options.dedupeWindowMs === 'number'
      ? Math.max(0, options.dedupeWindowMs)
      : 1200;

    if (!options.allowDuplicate) {
      const nextToastKey = `${tone}:${trimmedMessage.toLowerCase()}`;
      const now = Date.now();
      if (nextToastKey === this._lastToastKey && now - this._lastToastShownAt < dedupeWindowMs) {
        return null;
      }

      this._lastToastKey = nextToastKey;
      this._lastToastShownAt = now;
    }

    const duration = typeof options.duration === 'number' && Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : defaultDurationForTone(tone);

    const entry: ToastEntry = {
      id        : this._nextId,
      message   : trimmedMessage,
      tone,
      duration,
      createdAt : Date.now(),
    };

    this._nextId += 1;
    this.entries.set([...this.entries.get(), entry]);
    return entry;
  }

  consume(entryId: number): void {
    this.entries.set(this.entries.get().filter((entry) => entry.id !== entryId));
  }

  clear(): void {
    this.entries.set([]);
  }
}

class ConnectionStore {
  readonly snapshot = signal<ConnectionSnapshot>({ ...defaultConnectionSnapshot });
  readonly badgeLabel = computed(() => {
    const state = this.snapshot.get().state;
    if (state === 'online') {
      return 'Online';
    }

    if (state === 'offline') {
      return 'Offline';
    }

    return 'Connecting...';
  });
  readonly badgeVariant = computed(() => {
    const state = this.snapshot.get().state;
    if (state === 'online') {
      return 'success';
    }

    if (state === 'offline') {
      return 'danger';
    }

    return 'warning';
  });

  setSnapshot(snapshot: ConnectionSnapshot): void {
    this.snapshot.set({
      ...snapshot,
    });
  }

  markConnecting(endpoint = '--'): void {
    const previous = this.snapshot.get();
    this.snapshot.set({
      ...previous,
      state     : 'connecting',
      endpoint,
      serverUrl : endpoint.startsWith('http') ? endpoint : previous.serverUrl,
    });
  }

  markOnline(snapshot: Omit<ConnectionSnapshot, 'state'>): void {
    this.snapshot.set({
      ...snapshot,
      state: 'online',
    });
  }

  markOffline(snapshot: Partial<Omit<ConnectionSnapshot, 'state'>> = {}): void {
    const previous = this.snapshot.get();
    this.snapshot.set({
      ...previous,
      endpoint      : snapshot.endpoint ?? previous.endpoint,
      updatedAt     : snapshot.updatedAt ?? previous.updatedAt,
      state         : 'offline',
      serverName    : snapshot.serverName ?? '--',
      serverVersion : snapshot.serverVersion ?? '--',
      wsSupport     : snapshot.wsSupport ?? '--',
      serverUrl     : snapshot.serverUrl ?? '',
    });
  }
}

class IdentityStore {
  readonly walletSnapshot = signal<IdentityWalletSnapshot | null>(null);
  readonly identities = computed(() => this.walletSnapshot.get()?.identities ?? []);
  readonly activeManagedDidUri = computed(() => {
    const snapshot = this.walletSnapshot.get();
    return snapshot?.activeManagedDidUri
      ?? snapshot?.identities.find((identity) => identity.active)?.didUri
      ?? '';
  });

  setSnapshot(snapshot: IdentityWalletSnapshot): void {
    this.walletSnapshot.set(snapshot);
  }

  clear(): void {
    this.walletSnapshot.set(null);
  }
}

class ResolverStore {
  readonly currentDid = signal('');

  setCurrentDid(did: string): void {
    this.currentDid.set(did.trim());
  }
}

class AppsStore {
  readonly connections = signal<AppConnection[]>(normalizeAppConnections(defaultAppConnections));

  setConnections(connections: unknown[]): void {
    const normalizedConnections = normalizeAppConnections(connections);
    this.connections.set(
      normalizedConnections.length > 0
        ? normalizedConnections
        : normalizeAppConnections(defaultAppConnections),
    );
  }
}

export class AppStore {
  readonly route = {
    active    : signal<RouteId>('home'),
    setActive : (route: RouteId): void => {
      this.route.active.set(route);
    },
  };

  readonly toast = new ToastStore();
  readonly connection = new ConnectionStore();
  readonly identity = new IdentityStore();
  readonly resolver = new ResolverStore();
  readonly apps = new AppsStore();

  private _router?: RouteNavigator;

  setRouter(router: RouteNavigator): void {
    this._router = router;
    const activeRoute = router.getActiveRoute?.();
    if (activeRoute) {
      this.route.active.set(activeRoute);
    }
  }

  navigate(route: RouteId): void {
    this._router?.navigate(route);
  }
}

let appStoreSingleton: AppStore | undefined;

export function getAppStore(): AppStore {
  if (!appStoreSingleton) {
    appStoreSingleton = new AppStore();
  }

  return appStoreSingleton;
}

export function setAppConnections(connections: unknown[]): void {
  getAppStore().apps.setConnections(connections);
}
