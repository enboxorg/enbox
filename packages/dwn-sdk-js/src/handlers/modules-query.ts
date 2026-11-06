import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { ModulesConfigureMessage, ModulesQueryMessage, ModulesQueryReply } from '../types/modules-types.js';

import { authenticate } from '../core/auth.js';
import { DwnErrorCode } from '../core/dwn-error.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ModulesQuery } from '../interfaces/modules-query.js';
import { removeUndefinedProperties } from '@enbox/common';

import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class ModulesQueryHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message
  }: { tenant: string, message: ModulesQueryMessage}): Promise<ModulesQueryReply> {

    let modulesQuery: ModulesQuery;
    try {
      modulesQuery = await ModulesQuery.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await modulesQuery.authorize(tenant, this.deps.validationStateReader);
    } catch (error: any) {

      // return public ModulesConfigures if query fails with a certain authentication or authorization code
      if (error.code === DwnErrorCode.AuthenticateJwsMissing || // unauthenticated
        error.code === DwnErrorCode.ModulesQueryUnauthorized ||
        error.code === DwnErrorCode.ModulesGrantAuthorizationQueryModuleScopeMismatch
      ) {

        const entries: ModulesConfigureMessage[] = await this.fetchPublishedModulesConfigure(tenant, modulesQuery);
        return {
          status: { code: 200, detail: 'OK' },
          entries
        };
      } else {
        return messageReplyFromError(error, 401);
      }
    }

    const query = {
      ...message.descriptor.filter,
      interface         : DwnInterfaceName.Modules,
      method            : DwnMethodName.Configure,
      isLatestBaseState : true,
    };
    removeUndefinedProperties(query);

    const { messages } = await this.deps.messageStore.query(tenant, [ query ]);

    return {
      status  : { code: 200, detail: 'OK' },
      entries : messages as ModulesConfigureMessage[]
    };
  };

  /**
   * Fetches only published `ModulesConfigure`.
   */
  private async fetchPublishedModulesConfigure(tenant: string, modulesQuery: ModulesQuery): Promise<ModulesConfigureMessage[]> {
    // fetch all published `ModuleConfigure` matching the query
    const filter = {
      ...modulesQuery.message.descriptor.filter,
      interface         : DwnInterfaceName.Modules,
      method            : DwnMethodName.Configure,
      published         : true,
      isLatestBaseState : true,
    };
    const { messages: publishedModulesConfigure } = await this.deps.messageStore.query(tenant, [ filter ]);
    return publishedModulesConfigure as ModulesConfigureMessage[];
  }
}
