import { describe, expect, it } from 'bun:test';

import { getBrowserOpenCommand } from '../src/terminal.js';

describe('terminal', () => {
  describe('getBrowserOpenCommand()', () => {
    it('should use a Windows browser opener that preserves the wallet URI fragment', () => {
      const uri = 'https://wallet.example/connect/app#request_uri=urn%3Atest&encryption_key=test';

      const command = getBrowserOpenCommand(uri, 'win32');

      expect(command).toEqual({
        args    : ['url.dll,FileProtocolHandler', uri],
        command : 'rundll32',
      });
    });
  });
});
