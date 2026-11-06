/// <reference types="@enbox/dwn-sdk-js" />

import type { DwnInterface, DwnMessage } from '@enbox/agent';

/**
 * Encapsulates a DWN Module with its associated metadata and configuration.
 *
 * This class exposes a configured module's definition and signed DWN message.
 */
export class Module {
  /** The ModulesConfigureMessage containing the detailed configuration for the module. */
  private readonly _modulesConfigureMessage: DwnMessage[DwnInterface.ModulesConfigure];

  /**
   * Constructs a new instance of the Module class.
   *
   * @param modulesConfigureMessage - The configuration message containing the module details.
   */
  constructor(modulesConfigureMessage: DwnMessage[DwnInterface.ModulesConfigure]) {
    this._modulesConfigureMessage = modulesConfigureMessage;
  }

  /**
   * Retrieves the module definition from the module's configuration message.
   * @returns The module definition.
   */
  get definition(): DwnMessage[DwnInterface.ModulesConfigure]['descriptor']['definition'] {
    return this._modulesConfigureMessage.descriptor.definition;
  }

  /**
   * Serializes the module's configuration message to JSON.
   * @returns The serialized JSON object of the module's configuration message.
   */
  toJSON(): DwnMessage[DwnInterface.ModulesConfigure] {
    return this._modulesConfigureMessage;
  }
}
