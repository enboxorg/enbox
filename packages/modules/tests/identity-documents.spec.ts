import type { RecordCodec } from '@enbox/api';

import { describe, expect, it } from 'bun:test';

import { IdentityDocumentsCodecs } from '../src/identity-documents.js';

describe('identity document issuances', () => {
  const common = { label: 'ID card', reviewState: 'unreviewed', fields: { holder: { fullName: 'Alex Example' }, documentNumber: '00123' } };
  const privilege = { category: 'B', restrictions: ['Corrective lenses'] };

  it('uses one printed identifier and one record path for identity cards, licences and passports', async () => {
    const codec = IdentityDocumentsCodecs.document as RecordCodec<unknown>;
    for (const kind of ['national-id', 'state-id', 'drivers-licence', 'passport', 'other', 'unknown']) {
      const value = { ...common, documentType: kind };
      expect(JSON.parse(await (await codec.encode(value)).data.text())).toEqual(value);
    }
    for (const [kind, detail] of [
      ['passport', { drivingPrivileges: [privilege] }],
      ['national-id', { passportTypeCode: 'P' }],
      ['unknown', { drivingPrivileges: [privilege] }],
      ['drivers-licence', { licenceNumber: '00234' }],
      ['drivers-licence', { drivingPrivileges: [{ restrictions: ['Example'] }] }],
    ]) {
      expect(() => codec.encode({ ...common, documentType: kind, fields: detail })).toThrow();
    }
  });

  it('validates the classification on observations and corrections and keeps failed/accepted evidence coherent', async () => {
    const extraction = IdentityDocumentsCodecs.extraction as RecordCodec<unknown>;
    const review = IdentityDocumentsCodecs.review as RecordCodec<unknown>;
    const attempt = { sources: [{ recordId: 'scan' }], extractedAt: '2026-04-15T12:00:00Z', extractor: 'demo', state: 'partial' };
    const correction = { reviewedAt: '2026-04-15T12:00:00Z', decision: 'corrected' };
    const specific = { drivingPrivileges: [privilege] };
    expect(() => extraction.encode({ ...attempt, fields: specific })).toThrow();
    expect(() => extraction.encode({ ...attempt, documentType: 'national-id', fields: specific })).toThrow();
    expect(() => extraction.encode({ ...attempt, state: 'failed', error: 'Unreadable scan', fields: common.fields })).toThrow();
    expect(() => review.encode({ ...correction, decision: 'rejected', corrections: common.fields })).toThrow();
    expect(() => review.encode({ ...correction, documentType: 'passport', corrections: specific })).toThrow();
    const corrected = { ...correction, documentType: 'drivers-licence', corrections: specific };
    expect(JSON.parse(await (await review.encode(corrected)).data.text())).toEqual(corrected);
  });
});
