import { aggregateCheckStatus, createProofReport } from '../src/proof-result.js';
import { describe, expect, it } from 'bun:test';

describe('proof results', () => {
  it('should prefer failure over unsupported checks', () => {
    expect(aggregateCheckStatus([
      { id: 'one', status: 'unsupported', summary: 'unsupported' },
      { id: 'two', status: 'fail', summary: 'failed' },
    ])).toBe('fail');
  });

  it('should preserve an unsupported verdict without failures', () => {
    expect(aggregateCheckStatus([
      { id: 'one', status: 'pass', summary: 'passed' },
      { id: 'two', status: 'unsupported', summary: 'unsupported' },
    ])).toBe('unsupported');
  });

  it('should create a versioned report', () => {
    const timestamp = new Date('2026-09-20T12:00:00.000Z');
    expect(createProofReport({
      checks     : [{ id: 'one', status: 'pass', summary: 'passed' }],
      finishedAt : timestamp,
      proof      : 'example',
      startedAt  : timestamp,
    })).toEqual({
      checks        : [{ id: 'one', status: 'pass', summary: 'passed' }],
      finishedAt    : timestamp.toISOString(),
      proof         : 'example',
      schemaVersion : 1,
      startedAt     : timestamp.toISOString(),
      status        : 'pass',
    });
  });
});
