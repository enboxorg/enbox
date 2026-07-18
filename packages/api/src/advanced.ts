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

export type {
  FetchGrantsRequest,
  FetchRequestsRequest,
  ProtocolsConfigureRequest,
  ProtocolsConfigureResponse,
  ProtocolsQueryRequest,
  ProtocolsQueryResponse,
  RecordsDeleteRequest,
  RecordsQueryAllRequest,
  RecordsQueryRequest,
  RecordsQueryResponse,
  RecordsReadRequest,
  RecordsReadResponse,
  RecordsSubscribeRequest,
  RecordsSubscribeResponse,
  RecordsWriteRequest,
  RecordsWriteResponse,
} from './dwn-api.js';
