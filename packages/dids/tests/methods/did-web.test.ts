import type { UnwrapPromise } from '@enbox/common';

import DidWebResolveTestVector from '../fixtures/web5-spec-vectors/did_web/resolve.json' with { type: 'json' };
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { DidWeb } from '../../src/methods/did-web.js';

// Helper function to create a mocked fetch response that fails and returns a 404 Not Found.
const fetchNotFoundResponse = (): { status: number; statusText: string; ok: boolean } => ({
  status     : 404,
  statusText : 'Not Found',
  ok         : false
});

// Helper function to create a mocked fetch response that is successful and returns the given
// response.
const fetchOkResponse = (response: any): {
  status: number; statusText: string; ok: boolean; json: () => Promise<any>
} => ({
  status     : 200,
  statusText : 'OK',
  ok         : true,
  json       : async (): Promise<any> => Promise.resolve(response)
});

describe('DidWeb', () => {
  afterAll(() => {
    mock.restore();
  });

  describe('resolve()', () => {
    it(`returns a 'notFound' error if the HTTP GET response is not status code 200`, async () => {
      // Setup stub so that a mocked response is returned rather than calling over the network.
      const fetchStub = spyOn(globalThis as any, 'fetch');
      fetchStub.mockImplementation(() => Promise.resolve(fetchNotFoundResponse()));

      const resolutionResult = await DidWeb.resolve('did:web:non-existent-domain.com');

      expect(resolutionResult.didResolutionMetadata.error).toBe('notFound');

      fetchStub.mockRestore();
    });
  });

  describe('Web5TestVectorsDidWeb', () => {
    let fetchStub: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Setup stub so that a mocked response is returned rather than calling over the network.
      fetchStub = spyOn(globalThis as any, 'fetch');
    });

    afterEach(() => {
      fetchStub.mockRestore();
    });

    it('resolve', async () => {
      type TestVector = {
        description: string;
        input: {
          didUri: Parameters<typeof DidWeb.resolve>[0];
          mockServer: { [url: string]: any };
        };
        output: UnwrapPromise<ReturnType<typeof DidWeb.resolve>>;
        errors: boolean;
      };

      for (const vector of DidWebResolveTestVector.vectors as unknown as TestVector[]) {

        // Only mock the response if the test vector contains a `mockServer` property.
        if (vector.input.mockServer) {
          const mockResponses = vector.input.mockServer;
          fetchStub.mockImplementation((url: string) => {
            if (url in mockResponses) {return Promise.resolve(fetchOkResponse(mockResponses[url]));}
          });
        }

        const didResolutionResult = await DidWeb.resolve(vector.input.didUri);

        expect(didResolutionResult.didDocument).toEqual(vector.output.didDocument);
        expect(didResolutionResult.didDocumentMetadata).toEqual(vector.output.didDocumentMetadata);
        expect(didResolutionResult.didResolutionMetadata).toEqual(vector.output.didResolutionMetadata);
      }
    });
  });
});
