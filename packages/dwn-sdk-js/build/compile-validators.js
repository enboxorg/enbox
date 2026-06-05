/**
 * Pre-compiles Ajv validators from json schemas
 * Ajv supports generating standalone validation functions from JSON Schemas at compile/build time.
 * These functions can then be used during runtime to do validation without initializing Ajv.
 * It is useful for several reasons:
 * - to avoid dynamic code evaluation with Function constructor (used for schema compilation) -
 *   when it is prohibited by the browser page [Content Security Policy](https://ajv.js.org/security.html#content-security-policy).
 * - to reduce the browser bundle size - Ajv is not included in the bundle
 * - to reduce the start-up time - the validation and compilation of schemas will happen during build time.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import Ajv from 'ajv/dist/2020.js';
import * as mkdirpModule from 'mkdirp';
const mkdirp = mkdirpModule.mkdirp ?? mkdirpModule.default ?? mkdirpModule;
import standaloneCode from 'ajv/dist/standalone/index.js';

import Authorization from '../json-schemas/authorization.json' with { type: 'json' };
import AuthorizationDelegatedGrant from '../json-schemas/authorization-delegated-grant.json' with { type: 'json' };
import AuthorizationOwner from '../json-schemas/authorization-owner.json' with { type: 'json' };
import Definitions from '../json-schemas/definitions.json' with { type: 'json' };
import GeneralJwk from '../json-schemas/jwk/general-jwk.json' with { type: 'json' };
import GeneralJws from '../json-schemas/general-jws.json' with { type: 'json' };
import GenericSignaturePayload from '../json-schemas/signature-payloads/generic-signature-payload.json' with { type: 'json' };
import JwkVerificationMethod from '../json-schemas/jwk-verification-method.json' with { type: 'json' };
import MessagesFilter from '../json-schemas/interface-methods/messages-filter.json' with { type: 'json' };
import MessagesRead from '../json-schemas/interface-methods/messages-read.json' with { type: 'json' };
import MessagesSubscribe from '../json-schemas/interface-methods/messages-subscribe.json' with { type: 'json' };
import MessagesSync from '../json-schemas/interface-methods/messages-sync.json' with { type: 'json' };
import NumberRangeFilter from '../json-schemas/interface-methods/number-range-filter.json' with { type: 'json' };
import PaginationCursor from '../json-schemas/interface-methods/pagination-cursor.json' with { type: 'json' };
import ProgressToken from '../json-schemas/interface-methods/progress-token.json' with { type: 'json' };
import PermissionGrantData from '../json-schemas/permissions/permission-grant-data.json' with { type: 'json' };
import PermissionRequestData from '../json-schemas/permissions/permission-request-data.json' with { type: 'json' };
import PermissionRevocationData from '../json-schemas/permissions/permission-revocation-data.json' with { type: 'json' };
import PermissionsDefinitions from '../json-schemas/permissions/permissions-definitions.json' with { type: 'json' };
import PermissionsScopes from '../json-schemas/permissions/scopes.json' with { type: 'json' };
import ProtocolDefinition from '../json-schemas/interface-methods/protocol-definition.json' with { type: 'json' };
import ProtocolRuleSet from '../json-schemas/interface-methods/protocol-rule-set.json' with { type: 'json' };
import ProtocolsConfigure from '../json-schemas/interface-methods/protocols-configure.json' with { type: 'json' };
import ProtocolsQuery from '../json-schemas/interface-methods/protocols-query.json' with { type: 'json' };
import PublicJwk from '../json-schemas/jwk/public-jwk.json' with { type: 'json' };
import RecordsCount from '../json-schemas/interface-methods/records-count.json' with { type: 'json' };
import RecordsDelete from '../json-schemas/interface-methods/records-delete.json' with { type: 'json' };
import RecordsFilter from '../json-schemas/interface-methods/records-filter.json' with { type: 'json' };
import RecordsQuery from '../json-schemas/interface-methods/records-query.json' with { type: 'json' };
import RecordsRead from '../json-schemas/interface-methods/records-read.json' with { type: 'json' };
import RecordsSubscribe from '../json-schemas/interface-methods/records-subscribe.json' with { type: 'json' };
import RecordsWrite from '../json-schemas/interface-methods/records-write.json' with { type: 'json' };
import RecordsWriteDataEncoded from '../json-schemas/interface-methods/records-write-data-encoded.json' with { type: 'json' };
import RecordsWriteSignaturePayload from '../json-schemas/signature-payloads/records-write-signature-payload.json' with { type: 'json' };
import RecordsWriteUnidentified from '../json-schemas/interface-methods/records-write-unidentified.json' with { type: 'json' };
import StringRangeFilter from '../json-schemas/interface-methods/string-range-filter.json' with { type: 'json' };

const schemas = {
  Authorization,
  AuthorizationDelegatedGrant,
  AuthorizationOwner,
  RecordsCount,
  RecordsDelete,
  RecordsQuery,
  RecordsSubscribe,
  RecordsWrite,
  RecordsWriteDataEncoded,
  RecordsWriteUnidentified,
  Definitions,
  GeneralJwk,
  GeneralJws,
  JwkVerificationMethod,
  MessagesFilter,
  MessagesRead,
  MessagesSubscribe,
  MessagesSync,
  NumberRangeFilter,
  PaginationCursor,
  ProgressToken,
  PermissionGrantData,
  PermissionRequestData,
  PermissionRevocationData,
  PermissionsDefinitions,
  PermissionsScopes,
  ProtocolDefinition,
  ProtocolRuleSet,
  ProtocolsConfigure,
  ProtocolsQuery,
  RecordsRead,
  RecordsFilter,
  PublicJwk,
  GenericSignaturePayload,
  RecordsWriteSignaturePayload,
  StringRangeFilter
};

const ajv = new Ajv({ code: { source: true, esm: true }, allowUnionTypes: true });

for (const schemaName in schemas) {
  ajv.addSchema(schemas[schemaName], schemaName);
}

let moduleCode = standaloneCode(ajv);

// Ajv standalone code generator emits `require()` calls for runtime helpers (e.g. `ucs2length`
// used by `maxLength`) even when `esm: true` is set. Since this package uses `"type": "module"`,
// Node's ESM loader rejects `require()`. Convert CJS requires to top-level ESM imports.
const importStatements = [];
moduleCode = moduleCode.replace(
  /(?:const|var)\s+(\w+)\s*=\s*require\("([^"]+)"\)\.default;/g,
  (_match, varName, modulePath) => {
    const modAlias = `${varName}Mod`;
    const esmPath = modulePath.endsWith('.js') ? modulePath : `${modulePath}.js`;
    importStatements.push(`import ${modAlias} from "${esmPath}";`);
    return `const ${varName} = ${modAlias}.default ?? ${modAlias};`;
  }
);
if (importStatements.length > 0) {
  moduleCode = importStatements.join('\n') + '\n' + moduleCode;
}

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

await mkdirp(path.join(__dirname, '../generated'));
fs.writeFileSync(path.join(__dirname, '../generated/precompiled-validators.js'), moduleCode);
