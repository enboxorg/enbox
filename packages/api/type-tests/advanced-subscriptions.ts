import type {
  DwnSubscriptionHandler,
  DwnSubscriptionMessage,
  MessagesSubscribeRequest,
  MessagesSubscribeResponse,
  RecordsSubscribeRequest,
  RecordsSubscribeResponse,
} from '@enbox/api/advanced';

declare const handler: DwnSubscriptionHandler;
declare const message: DwnSubscriptionMessage;
declare const messagesRequest: MessagesSubscribeRequest;
declare const messagesResponse: MessagesSubscribeResponse;
declare const recordsRequest: RecordsSubscribeRequest;
declare const recordsResponse: RecordsSubscribeResponse;

const handlers = [
  messagesRequest.subscriptionHandler,
  recordsRequest.subscriptionHandler,
] satisfies DwnSubscriptionHandler[];

void handler;
void handlers;
void message.type;
void messagesResponse.status;
void recordsResponse.status;
