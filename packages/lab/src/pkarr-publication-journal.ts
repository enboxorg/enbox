import type { SQLQueryBindings } from 'bun:sqlite';

import { Database } from 'bun:sqlite';

export type AcceptedPkarrPublication = {
  acceptedAt: string;
  identifier: string;
  packet: Uint8Array;
  sequence: bigint;
};

export interface PkarrPublicationStore {
  get(identifier: string): AcceptedPkarrPublication | undefined;
  list(): AcceptedPkarrPublication[];
  set(publication: AcceptedPkarrPublication): void;
}

type PublicationRow = {
  accepted_at: string;
  identifier: string;
  packet: Uint8Array;
  sequence: string;
};

/** Durable store containing only the latest upstream-accepted signed packet per public key. */
export class PkarrPublicationJournal implements PkarrPublicationStore {
  private readonly _database: Database;

  public constructor(location: string) {
    this._database = new Database(location, { create: true, strict: true });
    this._database.run('PRAGMA journal_mode = WAL');
    this._database.run('PRAGMA synchronous = FULL');
    this._database.run(`
      CREATE TABLE IF NOT EXISTS accepted_publications (
        identifier TEXT PRIMARY KEY NOT NULL,
        sequence TEXT NOT NULL,
        packet BLOB NOT NULL,
        accepted_at TEXT NOT NULL
      ) STRICT
    `);
  }

  public close(): void {
    this._database.close();
  }

  public get(identifier: string): AcceptedPkarrPublication | undefined {
    const row = this._database
      .query<PublicationRow, [string]>(`
        SELECT identifier, sequence, packet, accepted_at
        FROM accepted_publications
        WHERE identifier = ?
      `)
      .get(identifier);

    return row === null ? undefined : PkarrPublicationJournal.fromRow(row);
  }

  public list(): AcceptedPkarrPublication[] {
    return this._database
      .query<PublicationRow, []>(`
        SELECT identifier, sequence, packet, accepted_at
        FROM accepted_publications
        ORDER BY identifier
      `)
      .all()
      .map(PkarrPublicationJournal.fromRow);
  }

  public set(publication: AcceptedPkarrPublication): void {
    const current = this.get(publication.identifier);
    if (current !== undefined && publication.sequence < current.sequence) {
      throw new Error(`Pkarr publication '${publication.identifier}' would regress its durable sequence.`);
    }
    if (current !== undefined && publication.sequence === current.sequence &&
      (current.packet.byteLength !== publication.packet.byteLength ||
       current.packet.some((value, index): boolean => value !== publication.packet[index]))) {
      throw new Error(`Pkarr publication '${publication.identifier}' conflicts at the durable sequence.`);
    }

    const values: SQLQueryBindings[] = [
      publication.identifier,
      publication.sequence.toString(),
      publication.packet,
      publication.acceptedAt,
    ];
    this._database.transaction((): void => {
      this._database.run(`
        INSERT INTO accepted_publications (identifier, sequence, packet, accepted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET
          sequence = excluded.sequence,
          packet = excluded.packet,
          accepted_at = excluded.accepted_at
      `, values);
    })();
  }

  private static fromRow(row: PublicationRow): AcceptedPkarrPublication {
    return {
      acceptedAt : row.accepted_at,
      identifier : row.identifier,
      packet     : new Uint8Array(row.packet),
      sequence   : BigInt(row.sequence),
    };
  }
}
