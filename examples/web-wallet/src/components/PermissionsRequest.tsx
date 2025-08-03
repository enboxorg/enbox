import React from "react";
import { Divider, List } from "@mui/material";
import { ConnectPermissionRequest } from "@enbox/agent";
import ProtocolPermissionScope from "./ProtocolPermissionScope";

const PermissionRequest: React.FC<{ permissions: ConnectPermissionRequest[] }> = ({ permissions }) => {

  return (
    <List disablePadding>
      {permissions.map((permission, index) => {
        return (
          <React.Fragment key={permission.protocolDefinition.protocol}>
            <ProtocolPermissionScope
              definition={permission.protocolDefinition}
              scopes={permission.permissionScopes}
            />
            {index < permissions.length - 1 && <Divider variant="inset" component="li" />}
          </React.Fragment>
        );
      })}
    </List>
  );
};

export default PermissionRequest;