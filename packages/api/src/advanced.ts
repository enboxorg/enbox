/**
 * Advanced API surface for power users who need direct access to
 * the underlying {@link DwnApi}.
 *
 * Most applications should use `enbox.using(protocol)` instead.
 * Import from `@enbox/api/advanced` to access these exports.
 *
 * @packageDocumentation
 */

export { DwnApi } from './dwn-api.js';
export { PermissionGrantRevocation } from './grant-revocation.js';
export { PermissionGrant } from './permission-grant.js';
export { PermissionRequest } from './permission-request.js';

export type { GrantRevocationModel, GrantRevocationOptions } from './grant-revocation.js';
export type { PermissionGrantModel, PermissionGrantOptions } from './permission-grant.js';
export type { PermissionRequestModel } from './permission-request.js';

export type {
  FetchGrantsRequest,
  FetchRequestsRequest,
  MessagesSubscribeRequest,
  MessagesSubscribeResponse,
  ProtocolsConfigureRequest,
  ProtocolsConfigureResponse,
  ProtocolsQueryRequest,
  ProtocolsQueryResponse,
  RecordsCountRequest,
  RecordsCountResponse,
  RecordsDeleteRequest,
  RecordsQueryRequest,
  RecordsQueryResponse,
  RecordsReadRequest,
  RecordsReadResponse,
  RecordsSubscribeRequest,
  RecordsSubscribeResponse,
  RecordsWriteRequest,
  RecordsWriteResponse,
} from './dwn-api.js';

export type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';
export type { AudienceKeyDeliveryOutcome } from '@enbox/agent';
