import type { DwnDatabaseType } from '../types.js';
import type { Kysely } from 'kysely';

import { isDuplicateKeyError } from './duplicate-key-error.js';

export type DataRefKey = {
  tenant: string;
  recordId: string;
  dataCid: string;
};

export async function getDataRefSize(
  db: Kysely<DwnDatabaseType>,
  { tenant, recordId, dataCid }: DataRefKey,
): Promise<number | undefined> {
  const ref = await db
    .selectFrom('dataRefs')
    .select('dataSize')
    .where('tenant', '=', tenant)
    .where('recordId', '=', recordId)
    .where('dataCid', '=', dataCid)
    .executeTakeFirst();

  return ref === undefined ? undefined : Number(ref.dataSize);
}

export async function getAnyDataRefSize(
  db: Kysely<DwnDatabaseType>,
  dataCid: string,
): Promise<number | undefined> {
  const ref = await db
    .selectFrom('dataRefs')
    .select('dataSize')
    .where('dataCid', '=', dataCid)
    .executeTakeFirst();

  return ref === undefined ? undefined : Number(ref.dataSize);
}

export async function insertDataRef(
  db: Kysely<DwnDatabaseType>,
  key: DataRefKey,
  dataSize: number,
): Promise<number> {
  try {
    await db
      .insertInto('dataRefs')
      .values({ ...key, dataSize })
      .execute();

    return dataSize;
  } catch (error: unknown) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const racedDataSize = await getDataRefSize(db, key);
    if (racedDataSize === undefined) {
      throw error;
    }

    return racedDataSize;
  }
}

export async function deleteDataRef(
  db: Kysely<DwnDatabaseType>,
  { tenant, recordId, dataCid }: DataRefKey,
): Promise<void> {
  await db
    .deleteFrom('dataRefs')
    .where('tenant', '=', tenant)
    .where('recordId', '=', recordId)
    .where('dataCid', '=', dataCid)
    .execute();
}

export async function hasAnyDataRef(
  db: Kysely<DwnDatabaseType>,
  dataCid: string,
): Promise<boolean> {
  const ref = await db
    .selectFrom('dataRefs')
    .select('dataCid')
    .where('dataCid', '=', dataCid)
    .executeTakeFirst();

  return ref !== undefined;
}
