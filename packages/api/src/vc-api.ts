import type { EnboxAgent } from '@enbox/agent';

/**
 * The VC API is used to issue, present and verify VCs
 *
 * @beta
 */
export class VcApi {
  /**
   * Holds the instance of a {@link EnboxAgent} that represents the current execution context for
   * the `VcApi`. This agent is used to process VC requests.
   */
  private agent: EnboxAgent;

  /** The DID of the tenant under which DID operations are being performed. */
  private connectedDid: string;

  constructor(options: { agent: EnboxAgent, connectedDid: string }) {
    this.agent = options.agent;
    this.connectedDid = options.connectedDid;
  }

  /**
   * Issues a VC (Not implemented yet)
   */
  async create(): Promise<void> {
    // TODO: implement
    throw new Error('Not implemented.');
  }
}