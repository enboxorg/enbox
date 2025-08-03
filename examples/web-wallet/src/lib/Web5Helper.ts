import { Web5, Record as DwnRecord } from '@enbox/api';
import { DwnProtocolDefinition, Web5Agent } from '@enbox/agent';
import { canonicalize } from '@enbox/crypto';

const Web5Helper = (didUri: string, agent: Web5Agent) => {
  const web5 = new Web5({ agent, connectedDid: didUri });

  return {
    web5,
    didUri,
    getRecord: async (protocol: string, protocolPath: string) => {
      const { status, records } = await web5.dwn.records.query({
        message: {
          filter: {
            protocol,
            protocolPath
          }
        }
      });
  
      if (status.code === 200 && records && records.length > 0) {
        return records[0];
      }
    },
    updateRecord: async (record: DwnRecord, dataFormat: string, data: any) => {
      const { status } = await record.update({ data, dataFormat });
      if (status.code !== 202) {
        throw new Error('Web5Helper: Failed to update name');
      }

      const { status: sendStatus } = await record.send();
      if (sendStatus.code !== 202) {
        console.info(`Web5Helper: Failed to send ${record.protocol} record at ${record.protocolPath}: ${sendStatus.detail}`);
      }

      return record; 
    },
    deleteRecord: async (record: DwnRecord) => {
      const { status } = await record.delete();
      if (status.code !== 202) {
        throw new Error('Web5Helper: Failed to delete record');
      }

      const { status: sendStatus } = await record.send();
      if (sendStatus.code !== 202) {
        console.info(`Web5Helper: Failed to send delete ${record.protocol} record at ${record.protocolPath}: ${sendStatus.detail}`);
      }

      return record;
    },
    createRecord: async (protocol: string, protocolPath: string, dataFormat: string, data: any) => {
      const { status, record } = await web5.dwn.records.create({
        data,
        message: {
          published: true,
          protocol,
          protocolPath,
          dataFormat
        }
      });
  
      if (status.code !== 202) {
        throw new Error(`Web5Helper: Failed to create ${protocol} record at ${protocolPath}: ${status.detail}`);
      }
  
      const { status: sendStatus } = await record!.send();
      if (sendStatus.code !== 202) {
        console.info(`Web5Helper: Failed to send ${protocol} record at ${protocolPath}: ${sendStatus.detail}`);
      }
  
      return record!;
    },
    configureProtocol: async (definition: DwnProtocolDefinition) => {
      const { status, protocols } = await web5.dwn.protocols.query({
        message: {
          filter: {
            protocol: definition.protocol
          }
        }
      });

      if (status.code === 200 && protocols && protocols.length > 0) {
        const existingDefinition = protocols[0].definition;
        if (canonicalize(existingDefinition) !== canonicalize(definition)) {
          throw new Error(`Web5Helper: Protocol ${definition.protocol} already configured with a different definition`);
        }

        return { status, protocol: protocols[0] };
      }

      const { status: configureProfileStatus, protocol } = await web5.dwn.protocols.configure({
        message: {
          definition
        }
      });

      if (configureProfileStatus.code !== 202) {
        throw new Error(`Web5Helper: Failed to configure protocol ${definition.protocol}: ${configureProfileStatus.detail}`);
      }

      const { status: protocolSendStatus } = await protocol!.send(didUri);
      if (protocolSendStatus.code !== 202) {
        console.info(`Web5Helper: Failed to send protocol ${definition.protocol} to ${didUri}`);
      }

      return protocol!;
    },
    listProtocols: async () => {
      const { status, protocols } = await web5.dwn.protocols.query({
        message: {}
      });
      if (status.code !== 200) {
        throw new Error('Web5Helper: Failed to list protocols');
      }

      return protocols.map(protocol => protocol.definition);
    },
    listPermissions: async () => {
      try {
        const permissions = await web5.dwn.permissions.queryGrants();
        return permissions;
      } catch (_error) {
        console.log('Web5Helper: Failed to list permissions', _error);
      }
      return [];
    },
    getProtocolDefinition: async (protocol: string) => {
      const { status, protocols } = await web5.dwn.protocols.query({
        message: {
          filter: {
            protocol
          }
        }
      });

      if (status.code === 200 && protocols && protocols.length > 0) {
        return protocols[0].definition;
      }
    }
  }
}

export default Web5Helper;