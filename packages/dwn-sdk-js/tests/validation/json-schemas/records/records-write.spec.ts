import { Message } from '../../../../src/core/message.js';
import { TestDataGenerator } from '../../../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH, ENCRYPTION_CONTROL_ROOT_PATH } from '../../../../src/core/constants.js';

describe('RecordsWrite schema definition', () => {
  it('should allow descriptor with only required properties', async () => {
    const validMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
      },
      authorization: TestDataGenerator.generateAuthorization()
    };
    Message.validateJsonSchema(validMessage);
  });

  it('should throw if `recordId` is missing', async () => {
    const message = {
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(message);
    }).toThrow('must have required property \'recordId\'');
  });

  it('should throw if `authorization` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      }
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'authorization\'');
  });

  it('should throw if unknown property is given in message', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization   : TestDataGenerator.generateAuthorization(),
      unknownProperty : 'unknownProperty' // unknown property
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('unevaluated properties: RecordsWrite: unknownProperty');
  });

  it('should throw if unknown property is given in the `descriptor`', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
        unknownProperty  : 'unknownProperty' // unknown property
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  it('should pass if `protocol` exists and its related properties are all present', () => {
    const validMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'someContext', // must exist because `protocol` exists
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'someProtocolId',
        protocolPath     : 'foo/bar', // must exist because `protocol` exists
        schema           : 'http://foo.bar/schema', // must exist because `protocol` exists
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    Message.validateJsonSchema(validMessage);
  });

  it('should throw if `protocolPath` contains invalid characters', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'someContext',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://foo.bar',
        protocolPath     : 'invalid:path', // `:` is not a valid char in `protocolPath`
        schema           : 'http://foo.bar/schema',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('protocolPath: must match pattern');
  });

  it('should allow exact reserved encryption control protocol paths', () => {
    for (const protocolPath of [ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH]) {
      const message = {
        recordId   : 'anyRecordId',
        contextId  : 'someContext',
        descriptor : {
          interface        : 'Records',
          method           : 'Write',
          protocol         : 'http://foo.bar',
          protocolPath,
          schema           : 'http://foo.bar/schema',
          dataCid          : 'anyCid',
          dataFormat       : 'application/json',
          dataSize         : 123,
          dateCreated      : '2022-12-19T10:20:30.123456Z',
          messageTimestamp : '2022-12-19T10:20:30.123456Z'
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      Message.validateJsonSchema(message);
    }
  });

  it('should reject root-only and lookalike encryption control protocol paths', () => {
    for (const protocolPath of [ENCRYPTION_CONTROL_ROOT_PATH, '$encryptionx/audience', '$encryption/audience/child']) {
      const message = {
        recordId   : 'anyRecordId',
        contextId  : 'someContext',
        descriptor : {
          interface        : 'Records',
          method           : 'Write',
          protocol         : 'http://foo.bar',
          protocolPath,
          schema           : 'http://foo.bar/schema',
          dataCid          : 'anyCid',
          dataFormat       : 'application/json',
          dataSize         : 123,
          dateCreated      : '2022-12-19T10:20:30.123456Z',
          messageTimestamp : '2022-12-19T10:20:30.123456Z'
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      expect(() => Message.validateJsonSchema(message)).toThrow('protocolPath: must match pattern');
    }
  });

  it('should throw if `contextId` is malformed', () => {
    const validMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'invalid:path', // `:` is not a valid char in `contextId`
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://foo.bar',
        protocolPath     : 'A/B/C',
        schema           : 'http://foo.bar/schema',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    // Ajv's runtime and precompiled validators serialize the escaped `/`
    // differently. Pin the validation keyword rather than its formatter.
    const expectedErrorMessage = 'contextId: must match pattern';

    const invalidMessage1 = { ...validMessage };
    invalidMessage1.contextId = 'invalid:path', // `:` is not a valid char in `contextId`
    expect(() => {
      Message.validateJsonSchema(invalidMessage1);
    }).toThrow(expectedErrorMessage);

    const invalidMessage2 = { ...validMessage };
    invalidMessage2.contextId = '/invalid/context'; // not allowed to start with `/`
    expect(() => {
      Message.validateJsonSchema(invalidMessage2);
    }).toThrow(expectedErrorMessage);

    const invalidMessage3 = { ...validMessage };
    invalidMessage3.contextId = 'invalid/context/'; // not allowed to end with `/`
    expect(() => {
      Message.validateJsonSchema(invalidMessage3);
    }).toThrow(expectedErrorMessage);
  });

  it('should throw if `contextId` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'contextId\'');
  });

  it('should throw if `contextId` is defined but `protocol` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'invalid', // must have `protocol` to exist
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'protocol\'');
  });

  it('should throw if `protocol` is defined but `contextId` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'invalid',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'contextId\'');
  });

  it('#434 - should throw if `protocol` is missing from descriptor', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        // protocol     : 'http://foo.bar', // intentionally missing
        protocolPath     : 'foo/bar',
        parentId         : 'anyParentId',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('descriptor: must have required property \'protocol\'');
  });

  it('should throw if `protocol` is defined but `protocolPath` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId', // required by protocol-based message
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://foo.bar',
        // protocolPath : 'foo/bar', // intentionally missing
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('descriptor: must have required property \'protocolPath\'');
  });

  it('should throw if `protocolPath` is defined but `protocol` is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        // protocol     : 'http://foo.bar', // intentionally missing
        protocolPath     : 'foo/bar',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('descriptor: must have required property \'protocol\'');
  });

  it('should throw if `protocol` is undefined but `recipient` is defined', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        // protocol     : 'http://foo.bar', // intentionally missing
        recipient        : 'did:example:anyone',
        // protocolPath : 'foo/bar', // intentionally missing
        schema           : 'http://foo.bar/schema',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('descriptor: must have required property \'protocol\'');
  });

  it('should pass if `protocol` is defined but `recipient` undefined', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://foo.bar',
        // recipient    : 'did:example:anyone', // intentionally missing
        protocolPath     : 'foo/bar',
        schema           : 'http://foo.bar/schema',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    Message.validateJsonSchema(invalidMessage);
  });

  it('should pass if `protocol` and `recipient` are both defined', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://foo.bar',
        recipient        : 'did:example:anyone',
        protocolPath     : 'foo/bar',
        schema           : 'http://foo.bar/schema',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z'
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    Message.validateJsonSchema(invalidMessage);
  });

  it('should throw if published is false but datePublished is present', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
        published        : false,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        datePublished    : '2022-12-19T10:20:30.123456Z' // must not be present when not published
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('published: must be equal to one of the allowed values');
  });

  it('should throw if published is true but datePublished is missing', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
        published        : true //datePublished must be present
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'datePublished\'');
  });

  it('should throw if published is missing and datePublished is present', () => {
    const invalidMessage = {
      recordId   : 'anyRecordId',
      contextId  : 'anyContextId',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        protocol         : 'http://example.com/protocol',
        protocolPath     : 'foo',
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
        datePublished    : '2022-12-19T10:20:30.123456Z' //published must be present
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must have required property \'published\'');
  });
});
