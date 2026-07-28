/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { DwnMessage, DwnResponseStatus, EnboxAgent } from '@enbox/agent';

import { DwnInterface } from '@enbox/agent';

/**
 * Represents metadata associated with a protocol, including the author and an optional message CID.
 */
export type ProtocolMetadata = {
  /** The author of the protocol. */
  author: string;

  /**
   * The Content Identifier (CID) of a ProtocolsConfigure message.
   *
   * This is an optional field, and is used by {@link Protocol.send}.
   */
  messageCid?: string;
};

/**
 * Encapsulates a DWN Protocol with its associated metadata and configuration.
 *
 * This class primarily exists to provide developers with a convenient way to configure/install
 * protocols on remote DWNs.
 */
export class Protocol {
  /** The {@link EnboxAgent} instance that handles DWNs requests. */
  private readonly _agent: EnboxAgent;

  /** Metadata associated with the protocol, including the author and optional message CID. */
  private readonly _metadata: ProtocolMetadata;

  /** The ProtocolsConfigureMessage containing the detailed configuration for the protocol. */
  private readonly _protocolsConfigureMessage: DwnMessage[DwnInterface.ProtocolsConfigure];

  /**
   * Constructs a new instance of the Protocol class.
   *
   * @param agent - The EnboxAgent instance used for network interactions.
   * @param protocolsConfigureMessage - The configuration message containing the protocol details.
   * @param metadata - Metadata associated with the protocol, including the author and optional message CID.
   */
  constructor(agent: EnboxAgent, protocolsConfigureMessage: DwnMessage[DwnInterface.ProtocolsConfigure], metadata: ProtocolMetadata) {
    this._agent = agent;
    this._metadata = metadata;
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

  /**
   * Sends the protocol configuration to a remote DWN identified by the target DID.
   *
   * @param target - The DID of the target DWN to which the protocol configuration will be installed.
   * @returns A promise that resolves to an object containing the status of the send operation.
   */
  async send(target: string): Promise<DwnResponseStatus> {
    const storedMessage = this._metadata.messageCid === undefined
      ? { rawMessage: this._protocolsConfigureMessage }
      : { messageCid: this._metadata.messageCid };
    const { reply } = await this._agent.sendDwnRequest({
      author      : this._metadata.author,
      messageType : DwnInterface.ProtocolsConfigure,
      target      : target,
      ...storedMessage,
    });

    return { status: reply.status };
  }
}
