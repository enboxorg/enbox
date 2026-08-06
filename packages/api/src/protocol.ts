/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { DwnInterface, DwnMessage } from '@enbox/agent';

/**
 * Encapsulates a DWN Protocol with its associated metadata and configuration.
 *
 * This class exposes a configured protocol's definition and signed DWN message.
 */
export class Protocol {
  /** The ProtocolsConfigureMessage containing the detailed configuration for the protocol. */
  private readonly _protocolsConfigureMessage: DwnMessage[DwnInterface.ProtocolsConfigure];

  /**
   * Constructs a new instance of the Protocol class.
   *
   * @param protocolsConfigureMessage - The configuration message containing the protocol details.
   */
  constructor(protocolsConfigureMessage: DwnMessage[DwnInterface.ProtocolsConfigure]) {
    this._protocolsConfigureMessage = protocolsConfigureMessage;
  }

  /**
   * Retrieves the protocol definition from the protocol's configuration message.
   * @returns The protocol definition.
   */
  get definition(): DwnMessage[DwnInterface.ProtocolsConfigure]['descriptor']['definition'] {
    return this._protocolsConfigureMessage.descriptor.definition;
  }

  /**
   * Serializes the protocol's configuration message to JSON.
   * @returns The serialized JSON object of the protocol's configuration message.
   */
  toJSON(): DwnMessage[DwnInterface.ProtocolsConfigure] {
    return this._protocolsConfigureMessage;
  }
}
