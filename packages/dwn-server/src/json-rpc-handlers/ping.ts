import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../lib/json-rpc-router.js';

import { createJsonRpcSuccessResponse } from '@enbox/dwn-clients';

/**
 * Handles `rpc.ping` requests — a lightweight application-level heartbeat.
 *
 * Clients send `rpc.ping` periodically to detect silently dead WebSocket
 * connections (NAT timeout, network switch, device sleep). The server
 * responds with a simple success so the client knows the connection is alive.
 */
export const handlePing: JsonRpcHandler = async (request): Promise<HandlerResponse> => {
  return {
    jsonRpcResponse: createJsonRpcSuccessResponse(request.id!, { ok: true }),
  };
};
