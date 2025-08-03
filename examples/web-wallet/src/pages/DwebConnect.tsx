import { useAgent } from '@/contexts/Context';
import { toastError } from '@/lib/utils';
import { ConnectPermissionRequest, DwnInterface, DwnProtocolDefinition, Oidc, Web5Agent } from '@enbox/agent';
import { DidJwk } from '@enbox/dids';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Typography, CircularProgress, AppBar, Toolbar } from '@mui/material';
import ConnectRequest from '@/components/ConnectRequest';


const DWebConnect: React.FC = () => {
  const { agent } = useAgent();
  const [ isCreatingDelegate, setIsCreatingDelegate ] = useState<boolean>(false);
  const [ returningGrants, setReturningGrants ] = useState<boolean>(false);

  const [ origin, setOrigin ] = useState<string>();
  const [ did, setDid ] = useState<string>();
  const [ permissions, setPermissions ] = useState<ConnectPermissionRequest[]>([]);

  const connecting = useMemo(() => {
    return isCreatingDelegate || returningGrants;
  }, [ isCreatingDelegate, returningGrants ]);

  useEffect(() => {
    const authRequest = async (e: MessageEvent) => {
      const { type, did, permissions } = e.data;
      if (type === 'dweb-connect-authorization-request') {
        if (!window?.opener?.closed) {
          setOrigin(e.origin);
          setDid(did);
          setPermissions(permissions);
        } else {
          window.close();
        }
      }
    }

    addEventListener('message', authRequest);
    window.opener?.postMessage({ type: 'dweb-connect-loaded' }, '*');
    return () => {
      removeEventListener('message', authRequest);
    };
  }, []);


  const handleAgentSetup = async (did: string) => {

    if (!origin || !agent) {
      toastError('Not ready');
      throw new Error('Not ready');
    }

    try {
      setIsCreatingDelegate(true);
      const delegateBearerDid = await DidJwk.create();
      const delegatePortableDid = await delegateBearerDid.export();

      // TODO: roll back permissions and protocol configurations if an error occurs. Need a way to delete protocols to achieve this.
      const delegateGrantPromises = permissions.map(permissionRequest => {
        return new Promise(async (resolve) => {
          const { protocolDefinition, permissionScopes } = permissionRequest;
    
          // We validate that all permission scopes match the protocol uri of the protocol definition they are provided with.
          const grantsMatchProtocolUri = permissionScopes.every(scope => 'protocol' in scope && scope.protocol === protocolDefinition.protocol);
          if (!grantsMatchProtocolUri) {
            throw new Error('All permission scopes must match the protocol uri they are provided with.');
          }

          await prepareProtocol(did, agent, protocolDefinition);
          const permissionGrants = await Oidc.createPermissionGrants(
            did,
            delegateBearerDid,
            agent,
            permissionScopes
          );
  
          resolve(permissionGrants);
        });
      });

      const grants = (await Promise.all(delegateGrantPromises)).flat();

      setIsCreatingDelegate(false);
      setReturningGrants(true);

      window.opener.postMessage({
        type: 'dweb-connect-authorization-response',
        delegateDid: delegatePortableDid,
        grants
      }, origin);

    } catch(error: any) {
      toastError(error.message);
      setReturningGrants(false);
    } finally {
      setReturningGrants(false);
      window.close();
    }
  }

  const handleDeny = () => {
    window.opener.postMessage({
      type: 'dweb-connect-authorization-response',
    }, origin);
    window.close();
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      {/* Top Bar */}
      <AppBar position="fixed">
        <Toolbar>
          <Typography variant="h6" noWrap component="div">
            Digital Identity Wallet
          </Typography>
        </Toolbar>
      </AppBar>
      {!connecting && origin && did && permissions.length > 0 && <ConnectRequest
        sx={{ mt: 10 }}
        permissions={permissions}
        did={did}
        origin={origin}
        handleApprove={handleAgentSetup}
        handleDeny={handleDeny}
      />}
      {connecting && (
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <CircularProgress size={48} sx={{ mb: 2 }} />
          <Typography variant="body1">
            {isCreatingDelegate ? 'Creating delegate...' : 'Returning grants...'}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

/**
 * Installs the protocol required by the Client on the Provider if it doesn't already exist.
 */
async function prepareProtocol(
  selectedDid: string,
  agent: Web5Agent,
  protocolDefinition: DwnProtocolDefinition
): Promise<void> {

  const queryMessage = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: protocolDefinition.protocol } },
  });

  if ( queryMessage.reply.status.code !== 200) {
    // if the query failed, throw an error
    throw new Error(
      `Could not fetch protocol: ${queryMessage.reply.status.detail}`
    );
  } else if (queryMessage.reply.entries === undefined || queryMessage.reply.entries.length === 0) {

    // send the protocol definition to the remote DWN first, if it passes we can process it locally
    const { reply: sendReply, message: configureMessage } = await agent.sendDwnRequest({
      author        : selectedDid,
      target        : selectedDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocolDefinition },
    });

    // check if the message was sent successfully, if the remote returns 409 the message may have come through already via sync
    if (sendReply.status.code !== 202 && sendReply.status.code !== 409) {
      throw new Error(`Could not send protocol: ${sendReply.status.detail}`);
    }

    // process the protocol locally, we don't have to check if it exists as this is just a convenience over waiting for sync.
    await agent.processDwnRequest({
      author      : selectedDid,
      target      : selectedDid,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : configureMessage
    });

  } else {

    // the protocol already exists, let's make sure it exists on the remote DWN as the requesting app will need it
    const configureMessage = queryMessage.reply.entries![0];
    const { reply: sendReply } = await agent.sendDwnRequest({
      author      : selectedDid,
      target      : selectedDid,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : configureMessage,
    });

    if (sendReply.status.code !== 202 && sendReply.status.code !== 409) {
      throw new Error(`Could not send protocol: ${sendReply.status.detail}`);
    }
  }
}

export default DWebConnect;