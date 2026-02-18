import { Message } from '../../../../src/core/message.js';
import { TestDataGenerator } from '../../../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

describe('RecordsRead schema validation', () => {
  it('should allow descriptor with only required properties', async () => {
    const validMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' }
      }
    };
    Message.validateJsonSchema(validMessage);
  });

  it('should throw if unknown property is given in message', () => {
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' }
      },
      unknownProperty: 'unknownProperty'
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  it('should throw if unknown property is given in the `descriptor`', () => {
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' },
        unknownProperty  : 'unknownProperty'
      }
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('must NOT have additional properties');
  });

  it('should only allow string values from the spec for `dateSort`', () => {
    // test all valid values of `dateSort`
    const allowedDateSortValues = ['createdAscending', 'createdDescending', 'publishedAscending', 'publishedDescending', 'updatedAscending', 'updatedDescending'];
    for (const dateSortValue of allowedDateSortValues) {
      const validMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Read',
          messageTimestamp : '2022-10-14T10:20:30.405060Z',
          filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' },
          dateSort         : dateSortValue
        }
      };

      Message.validateJsonSchema(validMessage);
    }

    // test an invalid value of `dateSort`
    const invalidMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' },
        dateSort         : 'unacceptable',
      }
    };

    expect(() => {
      Message.validateJsonSchema(invalidMessage);
    }).toThrow('dateSort: must be equal to one of the allowed values');
  });

  it('should allow `authorization` to be absent for anonymous reads', () => {
    const validMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' }
      }
    };
    Message.validateJsonSchema(validMessage);
  });

  it('should allow `authorization` to be present', () => {
    const validMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        filter           : { recordId: 'bafyreigs3em42x3dp4oeq543mpxwdi32gp4ag2e4qgqfnbyqbae5bxarau' }
      },
      authorization: TestDataGenerator.generateAuthorization()
    };
    Message.validateJsonSchema(validMessage);
  });
});
