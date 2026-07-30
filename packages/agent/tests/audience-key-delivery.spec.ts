import { DwnErrorCode } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { RemoteProtocolDefinitionError } from '../src/dwn-protocol-cache.js';
import {
  AudienceControlWriteError,
  AudienceKeyDeliveryConfigurationError,
  classifyAudienceKeyDeliveryFailure,
  projectAudienceKeyDeliveryOutcome,
} from '../src/audience-key-delivery.js';

describe('audience key delivery failure classification', () => {
  const cases = [
    { name: 'a missing recipient protocol', error: new RemoteProtocolDefinitionError('not installed', 'not-found'), expected: 'awaiting-recipient-install' },
    { name: 'a missing recipient endpoint', error: new RemoteProtocolDefinitionError('no endpoint', 'no-endpoint'), expected: 'terminal' },
    { name: 'a rejected protocol query', error: new RemoteProtocolDefinitionError('unauthorized', 'rejected', 401), expected: 'terminal' },
    { name: 'an unavailable protocol endpoint', error: new RemoteProtocolDefinitionError('unavailable', 'rejected', 503), expected: 'retryable' },
    { name: 'a rejected control write', error: new AudienceControlWriteError('write delivery', { code: 401, detail: 'Unauthorized' }), expected: 'terminal' },
    {
      name  : 'a not-yet-active grant',
      error : new AudienceControlWriteError('write delivery', {
        code      : 401,
        detail    : 'Grant is not yet active',
        errorCode : DwnErrorCode.GrantAuthorizationGrantNotYetActive,
      }),
      expected: 'retryable',
    },
    { name: 'a rate-limited control write', error: new AudienceControlWriteError('write delivery', { code: 429, detail: 'Too Many Requests' }), expected: 'retryable' },
    { name: 'missing seal coverage', error: new AudienceKeyDeliveryConfigurationError('missing seal coverage'), expected: 'terminal' },
    { name: 'an unknown transport failure', error: new Error('transport unavailable'), expected: 'retryable' },
  ] as const;

  for (const testCase of cases) {
    it(`classifies ${testCase.name} as ${testCase.expected}`, () => {
      expect(classifyAudienceKeyDeliveryFailure(testCase.error)).toBe(testCase.expected);
    });
  }
});

describe('audience key delivery state projection', () => {
  const intent = {
    contextId    : 'workspace-id',
    protocol     : 'https://example.com/workspace',
    recipientDid : 'did:example:bob',
    rolePath     : 'workspace/member',
    roleRecordId : 'role-record-id',
    sourceDid    : 'did:example:alice',
  };

  const cases = [
    {
      expected : { state: 'delivered' },
      outcome  : { delivered: true, recipientDid: intent.recipientDid } as const,
    },
    {
      expected : { reason: 'not installed', state: 'awaiting-recipient-install' },
      outcome  : {
        delivered    : false,
        failure      : 'awaiting-recipient-install',
        reason       : 'not installed',
        recipientDid : intent.recipientDid,
      } as const,
    },
    {
      expected : { reason: 'offline', state: 'pending' },
      outcome  : { delivered: false, failure: 'retryable', reason: 'offline', recipientDid: intent.recipientDid } as const,
    },
    {
      expected : { reason: 'unauthorized', state: 'failed' },
      outcome  : { delivered: false, failure: 'terminal', reason: 'unauthorized', recipientDid: intent.recipientDid } as const,
    },
  ] as const;

  for (const testCase of cases) {
    it(`projects an attempt as ${testCase.expected.state}`, () => {
      expect(projectAudienceKeyDeliveryOutcome(intent, testCase.outcome)).toEqual({ ...intent, ...testCase.expected });
    });
  }
});
