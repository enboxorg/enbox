import type { GenericMessage } from '@enbox/dwn-sdk-js';

import type {
  DwnMessage,
  DwnMessagesPermissionScope,
  DwnPermissionScope,
  DwnRecordsInterfaces,
  DwnRecordsPermissionScope,
  ProcessDwnRequest,
} from './types/dwn.js';

import { DwnInterfaceName } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';

export function isDwnRequest<T extends DwnInterface>(
  dwnRequest: ProcessDwnRequest<DwnInterface>, messageType: T
): dwnRequest is ProcessDwnRequest<T> {
  return dwnRequest.messageType === messageType;
}

export function isDwnMessage<T extends DwnInterface>(
  messageType: T, message: GenericMessage
): message is DwnMessage[T] {
  const incomingMessageInterfaceName = message.descriptor.interface + message.descriptor.method;
  return incomingMessageInterfaceName === messageType;
}

export function isRecordsType(messageType: DwnInterface): messageType is DwnRecordsInterfaces {
  return messageType === DwnInterface.RecordsCount ||
    messageType === DwnInterface.RecordsDelete ||
    messageType === DwnInterface.RecordsQuery ||
    messageType === DwnInterface.RecordsRead ||
    messageType === DwnInterface.RecordsSubscribe ||
    messageType === DwnInterface.RecordsWrite;
}

export function isRecordPermissionScope(scope: DwnPermissionScope): scope is DwnRecordsPermissionScope {
  return scope.interface === DwnInterfaceName.Records;
}

export function isMessagesPermissionScope(scope: DwnPermissionScope): scope is DwnMessagesPermissionScope {
  return scope.interface === DwnInterfaceName.Messages;
}
