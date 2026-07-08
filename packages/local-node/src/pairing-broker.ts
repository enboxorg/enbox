import type { LocalNodePairingRequestView } from '@enbox/dwn-server';
import type { Readable, Writable } from 'node:stream';

import { createInterface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';

type TtyReadable = Readable & { isTTY?: boolean };
type TtyWritable = Writable & { isTTY?: boolean };

export type PairingDecision = 'approve' | 'deny';

export interface PairingBroker {
  decidePairingRequest(request: LocalNodePairingRequestView): Promise<PairingDecision>;
}

export class AllowOriginPairingBroker implements PairingBroker {
  readonly #allowedOrigins: Set<string>;
  readonly #fallback: PairingBroker | undefined;

  public constructor(allowedOrigins: string[] = [], fallback?: PairingBroker) {
    this.#allowedOrigins = new Set(allowedOrigins);
    this.#fallback = fallback;
  }

  public async decidePairingRequest(request: LocalNodePairingRequestView): Promise<PairingDecision> {
    if (this.#allowedOrigins.has(request.origin)) {
      return 'approve';
    }

    if (this.#fallback !== undefined) {
      return this.#fallback.decidePairingRequest(request);
    }

    return 'deny';
  }
}

export class TtyPairingBroker implements PairingBroker {
  readonly #input: TtyReadable;
  readonly #output: TtyWritable;

  public constructor(options: { input?: TtyReadable; output?: TtyWritable } = {}) {
    this.#input = options.input ?? defaultInput;
    this.#output = options.output ?? defaultOutput;
  }

  public async decidePairingRequest(request: LocalNodePairingRequestView): Promise<PairingDecision> {
    if (this.#input.isTTY !== true || this.#output.isTTY !== true) {
      return 'deny';
    }

    const readline = createInterface({
      input  : this.#input,
      output : this.#output,
    });

    try {
      const answer = await readline.question(`Approve local DWN pairing for ${request.origin}? [y/N] `);
      return /^(?:y|yes)$/i.test(answer.trim()) ? 'approve' : 'deny';
    } finally {
      readline.close();
    }
  }
}
