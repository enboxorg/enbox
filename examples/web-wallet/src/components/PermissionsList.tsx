import React, { useEffect, useMemo, useState } from "react";
import { List, ListItem, Typography } from "@mui/material";
import { PermissionGrant } from "@enbox/api";
import { truncateDid } from "@/lib/utils";
import { DwnPermissionGrant, DwnProtocolDefinition } from "@enbox/agent";
import { useAgent } from "@/contexts/Context";
import ProtocolPermissionScope from "./ProtocolPermissionScope";

const PermissionsList: React.FC<{ protocols: DwnProtocolDefinition[], permissions: DwnPermissionGrant[] }> = ({ permissions, protocols }) => {
  const { agent } = useAgent();
  const [ loaded, setLoaded ] = useState(false);
  const [ loading, setLoading ] = useState(false);
  const [ granteeGrants, setGranteeGrants ] = useState<Map<string, Map<string, PermissionGrant[]>>>(new Map());

  const grantees = useMemo(() => {
    return Array.from(granteeGrants.keys());
  }, [ granteeGrants ]);

  useEffect(() => {
    setLoaded(false);
  }, [ permissions ]);

  useEffect(() => {
    const loadPermissions = () => {
      setLoading(true);
      try {
        const granteeGrants = permissions.reduce((acc, permission) => {
          const protocolGrants = acc.get(permission.grantee) || new Map();
          const scopedProtocol = permission.scope.protocol || 'none';
          const grants = protocolGrants.get(scopedProtocol) || [];
          protocolGrants.set(scopedProtocol, [ ...grants, permission ]);
          acc.set(permission.grantee, protocolGrants);
          return acc;
        }, new Map<string, Map<string, PermissionGrant[]>>());

        setGranteeGrants(granteeGrants);
        setLoaded(true);
      } catch(error) {
        console.log('Failed to load permissions', error);
      } finally {
        setLoading(false);
      }
    }

    if (agent && !loading && !loaded) {
      loadPermissions();
    }

  }, [ agent, permissions, protocols, loading, loaded ]);

  return (
    <List disablePadding>
      {loading && <Typography>Loading...</Typography>}
      {!loading && grantees.map((grantee) => {
        const grants = granteeGrants.get(grantee);
        const grantProtocols = grants && grants.size > 0 ? [ ...grants.keys() ].map((protocol) => protocol) : [];
        return (
          <ListItem key={grantee} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'start' }}>
            <Typography variant="h6">{truncateDid(grantee)}</Typography>
            <List disablePadding sx={{ display: 'flex', flexDirection: 'column' }}>
              {grantProtocols.map(protocol => {
                const definition = protocols.find(p => p.protocol === protocol);
                if (definition) {
                  const permissions = grants!.get(protocol) || [];
                  const scopes = permissions.map(scope => scope.scope)
                  return <ProtocolPermissionScope key={protocol}
                    definition={definition}
                    scopes={scopes}
                  />
                } else if(protocol === 'none') {
                  const permissions = grants!.get(protocol) || [];
                  return <ListItem key={protocol}>
                    <Typography variant="body1">Unrestricted</Typography>
                    {permissions.map(permission => <Typography>{JSON.stringify(permission.scope)}</Typography>)}
                  </ListItem>
                }
              })}
            </List>
          </ListItem>
        )
      })}
    </List>
  );
}

export default PermissionsList;