import type { AuthorizationModel } from '../types/message-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ModulesQueryDescriptor, ModulesQueryFilter, ModulesQueryMessage } from '../types/modules-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { ModulesGrantAuthorization } from '../core/modules-grant-authorization.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { normalizeModuleUrl, validateModuleUrlNormalized } from '../utils/url.js';

export type ModulesQueryOptions = {
  messageTimestamp?: string;
  filter?: ModulesQueryFilter,
  signer?: MessageSigner;
  permissionGrantId?: string;
};

export class ModulesQuery extends AbstractMessage<ModulesQueryMessage> {

  public static async parse(message: ModulesQueryMessage): Promise<ModulesQuery> {
    if (message.authorization !== undefined) {
      await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    }

    if (message.descriptor.filter !== undefined) {
      validateModuleUrlNormalized(message.descriptor.filter.module);
    }
    Time.validateTimestamp(message.descriptor.messageTimestamp);

    return new ModulesQuery(message);
  }

  public static async create(options: ModulesQueryOptions): Promise<ModulesQuery> {
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantId: options.permissionGrantId,
    });

    const descriptor: ModulesQueryDescriptor = {
      interface        : DwnInterfaceName.Modules,
      method           : DwnMethodName.Query,
      messageTimestamp : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      filter           : options.filter ? ModulesQuery.normalizeFilter(options.filter) : undefined,
      ...permissionGrantInvocation,
    };

    // delete all descriptor properties that are `undefined` else the code will encounter the following IPLD issue when attempting to generate CID:
    // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
    removeUndefinedProperties(descriptor);

    // only generate the `authorization` property if signature input is given
    let authorization: AuthorizationModel | undefined;
    if (options.signer !== undefined) {
      authorization = await Message.createAuthorization({
        descriptor,
        signer: options.signer,
        ...permissionGrantInvocation
      });
    }

    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);

    const modulesQuery = new ModulesQuery(message);
    return modulesQuery;
  }

  static normalizeFilter(filter: ModulesQueryFilter): ModulesQueryFilter {
    return {
      ...filter,
      module: normalizeModuleUrl(filter.module),
    };
  }

  public async authorize(tenant: string, validationStateReader: ValidationStateReader): Promise<void> {
    // if author is the same as the target tenant, we can directly grant access
    if (this.author === tenant) {
      return;
    } else if (this.author !== undefined && Message.getPermissionGrantId(this.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(this.signaturePayload!)!;
      const permissionGrant = await validationStateReader.fetchGrant(tenant, permissionGrantId);
      await ModulesGrantAuthorization.authorizeQuery({
        expectedGrantor : tenant,
        expectedGrantee : this.author,
        incomingMessage : this.message,
        permissionGrant,
        validationStateReader
      });
    } else {
      throw new DwnError(
        DwnErrorCode.ModulesQueryUnauthorized,
        'The ModulesQuery failed authorization'
      );
    }
  }
}
