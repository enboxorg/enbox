import type { RecordCodec } from '@enbox/api';
import type { EducationData, WorkData } from '../career-history.js';

import { CareerHistoryCodecs } from '../career-history.js';

export type JsonResumeCareer = { work?: WorkData[]; education?: EducationData[] };

/** Other résumé sections stay with the caller and never become Career History writes. */
export type JsonResumeInterchange = JsonResumeCareer & { otherSections: Record<string, unknown> };

async function validateSection<T>(name: string, entries: unknown, codec: RecordCodec<T>): Promise<T[]> {
  if (!Array.isArray(entries)) {
    throw new TypeError(`JSON Resume ${name} must be an array.`);
  }
  const validated: T[] = [];
  for (const [index, entry] of entries.entries()) {
    try {
      // Encode validates each item, including unknown properties, before it leaves this adapter.
      const encoded = await codec.encode(entry as T);
      validated.push(JSON.parse(await encoded.data.text()) as T);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TypeError(`JSON Resume ${name}[${index}] cannot be represented in Career History. ${detail}`);
    }
  }
  return validated;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Split a parsed JSON Resume v1.0.0 document into ordered Career History payloads and untouched sections. */
export async function importJsonResume(value: unknown): Promise<JsonResumeInterchange> {
  if (!plainObject(value)) {
    throw new TypeError('Expected a JSON Resume object.');
  }
  const { work, education, ...otherSections } = value;
  return {
    otherSections: structuredClone(otherSections),
    ...(work === undefined ? {} : { work: await validateSection('work', work, CareerHistoryCodecs.work) }),
    ...(education === undefined ? {} : { education: await validateSection('education', education, CareerHistoryCodecs.education) }),
  };
}

/** Assemble a JSON Resume document in caller-selected entry order and preserve unrelated input sections. */
export async function exportJsonResume(resume: JsonResumeCareer & { otherSections?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const { work, education, otherSections = {} } = resume;
  if (!plainObject(otherSections) || Object.hasOwn(otherSections, 'work') || Object.hasOwn(otherSections, 'education')) {
    throw new TypeError('Expected otherSections to contain only unrelated JSON Resume sections.');
  }
  return {
    ...structuredClone(otherSections),
    ...(work === undefined ? {} : { work: await validateSection('work', work, CareerHistoryCodecs.work) }),
    ...(education === undefined ? {} : { education: await validateSection('education', education, CareerHistoryCodecs.education) }),
  };
}
