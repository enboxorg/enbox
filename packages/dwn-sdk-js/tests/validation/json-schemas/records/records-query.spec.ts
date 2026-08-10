import { Message } from '../../../../src/core/message.js';
import { TestDataGenerator } from '../../../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

describe('RecordsQuery schema validation', () => {
  it('should allow descriptor with only required properties', async () => {
    const validMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Query',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { schema: 'anySchema' }
      },
      authorization: TestDataGenerator.generateAuthorization()
    };
    expect(() => Message.validateJsonSchema(validMessage)).not.toThrow();
  });

  it('should throw if unknown property is given in message', () => {
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Query',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { schema: 'anySchema' }
      },
      authorization   : TestDataGenerator.generateAuthorization(),
      unknownProperty : 'unknownProperty' // unknown property
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  it('should throw if unknown property is given in the `descriptor`', () => {
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Query',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { schema: 'anySchema' },
        unknownProperty  : 'unknownProperty' // unknown property
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  it('should only allows string values from the spec for `dateSort`', () => {
    // test all valid values of `dateSort`
    const allowedDateSortValues = ['createdAscending', 'createdDescending', 'publishedAscending', 'publishedDescending', 'updatedAscending', 'updatedDescending'];
    for (const dateSortValue of allowedDateSortValues) {
      const validMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : '2022-10-14T10:20:30.405060Z',
          filter           : { schema: 'anySchema' },
          dateSort         : dateSortValue
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      expect(() => Message.validateJsonSchema(validMessage)).not.toThrow();
    }

    // test an invalid values of `dateSort`
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Query',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { schema: 'anySchema' },
        dateSort         : 'unacceptable', // bad value
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('dateSort: must be equal to one of the allowed values');
  });

  it('should throw if `ownerSignature` is specified in `authorization`', () => {
    const authorization = TestDataGenerator.generateAuthorization();
    authorization.ownerSignature = TestDataGenerator.generateAuthorizationSignature();

    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Query',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { schema: 'anySchema' }
      },
      authorization
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  describe('`filter` property validation', () => {
    it('should throw if empty `filter` property is given in the `descriptor`', () => {
      const invalidMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : '2022-10-14T10:20:30.405060Z',
          filter           : { }
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      expect(() => {
        Message.validateJsonSchema(invalidMessage);
      }).toThrow('/descriptor/filter: must NOT have fewer than 1 properties');
    });

    it('should throw if `dateCreated` criteria given is an empty object', () => {
      const invalidMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : '2022-10-14T10:20:30.405060Z',
          filter           : { dateCreated: { } } // empty `dateCreated` criteria
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      expect(() => {
        Message.validateJsonSchema(invalidMessage);
      }).toThrow('dateCreated: must NOT have fewer than 1 properties');
    });

    it('should throw if `dateCreated` criteria has unexpected properties', () => {
      const invalidMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : '2022-10-14T10:20:30.405060Z',
          filter           : { dateCreated: { unexpectedProperty: 'anyValue' } } // unexpected property in `dateCreated` criteria
        },
        authorization: TestDataGenerator.generateAuthorization()
      };

      expect(() => {
        Message.validateJsonSchema(invalidMessage);
      }).toThrow('must NOT have additional properties');
    });
  });
});
