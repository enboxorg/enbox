import { describe, expect, it } from 'bun:test';
import { exportJsonResume, importJsonResume } from '../src/interchange/json-resume.js';

describe('JSON Resume v1.0.0 career interchange', () => {
  it('round-trips supported work and education in input order and preserves independent source sections', async () => {
    const input = {
      basics : { name: 'Alex' },
      work   : [
        { name: 'Cedar Maps', position: 'Lead', startDate: '2024-02-29', highlights: ['Opened the new studio'] },
        { name: 'Cedar Maps', position: 'Surveyor', startDate: '2021-04', endDate: '2024' },
      ],
      education  : [{ institution: 'North Coast', area: 'Design', studyType: 'BA', score: '3.7/4.0', courses: ['Drawing'] }],
      references : [{ name: 'Sam', reference: 'Reliable teammate' }],
      meta       : { custom: ['An application-specific source annotation'] },
    };
    const projection = await importJsonResume(input);
    expect(projection.work).toEqual(input.work);
    expect(projection.education).toEqual(input.education);
    expect(projection.otherSections).toEqual({ basics: input.basics, references: input.references, meta: input.meta });
    expect(await exportJsonResume(projection)).toEqual(input);
    projection.work![0].position = 'Studio lead';
    const output = await exportJsonResume(projection);
    expect((output.work as { position: string }[])[0].position).toBe('Studio lead');
    expect(input.work[0].position).toBe('Lead');
    expect(output.basics).not.toBe(input.basics);
  });

  it('retains the distinction between an absent section and an explicitly empty array', async () => {
    expect(await exportJsonResume(await importJsonResume({ work: [] }))).toEqual({ work: [] });
    expect(await exportJsonResume(await importJsonResume({ education: [] }))).toEqual({ education: [] });
    expect(await exportJsonResume({})).toEqual({});
  });

  it('reports the source index for unsupported item fields or invalid date precision on import and export', async () => {
    for (const invalid of [
      { work: [{ name: 'Cedar Maps', customEmployerCode: 'CM' }] },
      { work: [{ name: 'Cedar Maps', startDate: '2023-02-29' }] },
      { education: [{ institution: 'North Coast', startDate: '2020-00' }] },
      { education: [{ studyType: 'BA' }] },
      { education: [{ institution: 'North Coast' }, { institution: 'New Academy', location: { city: 'A' } }] },
    ]) {
      await expect(importJsonResume(invalid)).rejects.toThrow(/(work|education)\[\d+\] cannot be represented/);
      await expect(exportJsonResume(invalid as never)).rejects.toThrow(/(work|education)\[\d+\] cannot be represented/);
    }
    await expect(importJsonResume({ work: 'Principal designer' })).rejects.toThrow('work must be an array');
    await expect(importJsonResume(null)).rejects.toThrow('Expected a JSON Resume object');
    await expect(importJsonResume([])).rejects.toThrow('Expected a JSON Resume object');
    await expect(exportJsonResume({ otherSections: { education: [] } })).rejects.toThrow('unrelated');
  });
});
