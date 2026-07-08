import type { LocalNodePairingSessionRecord } from '@enbox/dwn-server';

import { homedir } from 'node:os';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LOCAL_NODE_PAIRING_SESSIONS_FILENAME = 'local-node-sessions.json';

const localNodePairingSessionsVersion = 1;

export interface LocalNodePairingSessionStore {
  readonly path: string;
  read(): Promise<LocalNodePairingSessionRecord[]>;
  remove(): Promise<void>;
  write(sessions: LocalNodePairingSessionRecord[]): Promise<void>;
}

export class LocalNodePairingSessionFile implements LocalNodePairingSessionStore {
  readonly #filePath: string;

  public constructor(filePath?: string) {
    this.#filePath = filePath ?? join(homedir(), '.enbox', LOCAL_NODE_PAIRING_SESSIONS_FILENAME);
  }

  public get path(): string {
    return this.#filePath;
  }

  public async read(): Promise<LocalNodePairingSessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.remove();
      return [];
    }

    if (!isValidPairingSessionsFile(parsed)) {
      await this.remove();
      return [];
    }

    return parsed.sessions.map((session: SerializedPairingSession): LocalNodePairingSessionRecord => ({
      createdAt : session.createdAt,
      origin    : session.origin,
      token     : session.token,
    }));
  }

  public async write(sessions: LocalNodePairingSessionRecord[]): Promise<void> {
    const browserSessions = sessions.filter((session): session is SerializedPairingSession => session.origin !== undefined);
    const serialized = {
      sessions : browserSessions,
      version  : localNodePairingSessionsVersion,
    };
    const json = JSON.stringify(serialized, null, 2);
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;

    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
    await rename(tempPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
  }

  public async remove(): Promise<void> {
    await rm(this.#filePath, { force: true });
  }
}

type SerializedPairingSession = {
  createdAt : number;
  origin : string;
  token : string;
};

type SerializedPairingSessionsFile = {
  sessions : SerializedPairingSession[];
  version : typeof localNodePairingSessionsVersion;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isValidPairingSessionsFile(value: unknown): value is SerializedPairingSessionsFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const file = value as Record<string, unknown>;
  return file.version === localNodePairingSessionsVersion
    && Array.isArray(file.sessions)
    && file.sessions.every(isValidPairingSession);
}

function isValidPairingSession(value: unknown): value is SerializedPairingSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const session = value as Record<string, unknown>;
  const createdAt = session.createdAt;
  return typeof createdAt === 'number'
    && Number.isInteger(createdAt)
    && createdAt > 0
    && typeof session.token === 'string'
    && session.token.length > 0
    && typeof session.origin === 'string'
    && isValidHttpOrigin(session.origin);
}

function isValidHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === origin;
  } catch {
    return false;
  }
}
