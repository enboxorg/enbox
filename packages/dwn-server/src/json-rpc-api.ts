import { JsonRpcRouter } from './lib/json-rpc-router.js';

import { handleDwnProcessMessage } from './json-rpc-handlers/dwn/index.js';
import { handlePing } from './json-rpc-handlers/ping.js';
import { handleSubscriptionAck, handleSubscriptionsClose } from './json-rpc-handlers/subscription/index.js';

export const jsonRpcRouter = new JsonRpcRouter();

jsonRpcRouter.on('dwn.processMessage', handleDwnProcessMessage);
jsonRpcRouter.on('rpc.subscribe.dwn.processMessage', handleDwnProcessMessage);

jsonRpcRouter.on('rpc.ack', handleSubscriptionAck);
jsonRpcRouter.on('rpc.subscribe.close', handleSubscriptionsClose);

jsonRpcRouter.on('rpc.ping', handlePing);
