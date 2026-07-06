import type { DependencyRef, ProgressToken, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import { DwnRpcError } from './dwn-rpc-error.js';
import { JsonRpcErrorCodes } from './json-rpc.js';

const deferredReasons = new Set(['tenant-inactive', 'resolver-unavailable', 'storage']);

export function parseReplicationApplyResult(value: unknown): ReplicationApplyResult {
  if (!isObject(value) || typeof value.kind !== 'string') {
    throw malformedReplicationApplyResult('result must be an object with a string kind');
  }

  switch (value.kind) {
    case 'Applied':
      return parseAppliedResult(value);
    case 'Duplicate':
    case 'Superseded':
      return { kind: value.kind };
    case 'Incomplete':
      if (!Array.isArray(value.missing) || !value.missing.every(isDependencyRef)) {
        throw malformedReplicationApplyResult('Incomplete result must include missing dependency refs');
      }
      return { kind: 'Incomplete', missing: value.missing };
    case 'Invalid':
      if (typeof value.reason !== 'string') {
        throw malformedReplicationApplyResult('Invalid result must include a string reason');
      }
      return { kind: 'Invalid', reason: value.reason };
    case 'Deferred':
      if (typeof value.reason !== 'string' || !deferredReasons.has(value.reason)) {
        throw malformedReplicationApplyResult('Deferred result must include a valid reason');
      }
      return { kind: 'Deferred', reason: value.reason as Extract<ReplicationApplyResult, { kind: 'Deferred' }>['reason'] };
    default:
      throw malformedReplicationApplyResult(`unknown result kind ${value.kind}`);
  }
}

function parseAppliedResult(value: Record<string, unknown>): Extract<ReplicationApplyResult, { kind: 'Applied' }> {
  const result: Extract<ReplicationApplyResult, { kind: 'Applied' }> = { kind: 'Applied' };

  if (value.ancestryOnly !== undefined) {
    if (value.ancestryOnly !== true) {
      throw malformedReplicationApplyResult('Applied result ancestryOnly must be true when present');
    }
    result.ancestryOnly = true;
  }

  if (value.position !== undefined) {
    if (!isProgressToken(value.position)) {
      throw malformedReplicationApplyResult('Applied result position must be a valid ProgressToken when present');
    }
    result.position = value.position;
  }

  return result;
}

function malformedReplicationApplyResult(detail: string): DwnRpcError {
  return new DwnRpcError(
    JsonRpcErrorCodes.InternalError,
    `malformed dwn.applyReplicatedMessage result: ${detail}`,
  );
}

function isDependencyRef(value: unknown): value is DependencyRef {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }
  if (!isOptionalString(value.messageCid) || !isOptionalBoolean(value.terminal)) {
    return false;
  }

  switch (value.type) {
    case 'Protocol':
      return typeof value.protocol === 'string';
    case 'InitialWrite':
      return typeof value.recordId === 'string' && isOptionalString(value.protocol);
    case 'Parent':
      return typeof value.recordId === 'string' && typeof value.protocol === 'string';
    case 'Ancestor':
      return typeof value.recordId === 'string' && isOptionalString(value.protocol);
    case 'Role':
      return typeof value.protocol === 'string' &&
        typeof value.protocolPath === 'string' &&
        typeof value.recipient === 'string' &&
        isOptionalString(value.contextPrefix);
    case 'Grant':
      return typeof value.permissionGrantId === 'string';
    case 'EncryptionProtocol':
      return isEncryptionProtocolPath(value.protocolPath) &&
        isOptionalObject(value.tags) &&
        isOptionalString(value.recipient);
    case 'CrossProtocolRef':
      return typeof value.protocol === 'string' && typeof value.recordId === 'string';
    case 'RecordData':
      return typeof value.recordId === 'string' &&
        typeof value.dataCid === 'string' &&
        isOptionalString(value.protocol);
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProgressToken(value: unknown): value is ProgressToken {
  if (!isObject(value)) {
    return false;
  }

  return typeof value.streamId === 'string' && value.streamId !== '' &&
    typeof value.epoch === 'string' && value.epoch !== '' &&
    typeof value.position === 'string' && value.position !== '' &&
    (value.messageCid === undefined || (typeof value.messageCid === 'string' && value.messageCid !== ''));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalObject(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isObject(value);
}

function isEncryptionProtocolPath(value: unknown): value is 'grantKey' {
  return value === 'grantKey';
}
