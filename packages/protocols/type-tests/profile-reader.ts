import type { Enbox, EnboxAnonymousApi } from '@enbox/api';
import type { ProfileReaderReadResponse, ProfileReaderRecord } from '@enbox/protocols';

import { createProfileReader } from '@enbox/protocols';

// Public package imports check the built declarations with exact optional types.
declare const enbox: Enbox;
declare const anonymous: EnboxAnonymousApi;

createProfileReader(enbox);
createProfileReader(enbox.dwn);
createProfileReader(enbox.dwn.records);
createProfileReader(anonymous);
createProfileReader(anonymous.dwn);
createProfileReader(anonymous.dwn.records);

// Sparse adapters and native missing-read replies need both optionality and undefined.
const sparseRecord: ProfileReaderRecord = {
  data: {
    blob : async (): Promise<Blob> => new Blob(),
    json : async (): Promise<unknown> => ({}),
  },
};
const omittedRecord: ProfileReaderReadResponse = { status: { code: 404 } };
const explicitMissingRecord: ProfileReaderReadResponse = { status: { code: 404 }, record: undefined };
void sparseRecord;
void omittedRecord;
void explicitMissingRecord;
