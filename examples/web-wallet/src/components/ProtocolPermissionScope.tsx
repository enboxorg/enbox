import { Lock, Public, SyncAlt } from "@mui/icons-material";
import { Box, Chip, ListItem, ListItemIcon, ListItemText } from "@mui/material";
import { DwnPermissionScope, DwnProtocolDefinition } from "@enbox/agent";

const ProtocolPermissionScope:React.FC<{ definition: DwnProtocolDefinition, scopes: DwnPermissionScope[] }> = ({ definition, scopes }) => {
  const formatScopes = (scopes: DwnPermissionScope[]) => {
    const sync = scopes.some(scope => scope.interface === 'Messages' && scope.method === 'Read') &&
                 scopes.some(scope => scope.interface === 'Messages' && scope.method === 'Query');

    const records = scopes.filter(scope => scope.interface === 'Records').map(scope => scope.method);

    return { sync, records };
  };

  const { sync, records } = formatScopes(scopes);

  return <ListItem>
    <ListItemIcon>
      {definition.published ? <Public /> : <Lock />}
    </ListItemIcon>
    <Box sx={{ mb: 2 }}>
      <ListItemText
        primary={definition.protocol}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
        {records.map((method) => (
          <Chip key={method} label={method} size="small" />
        ))}
        {sync && <Chip icon={<SyncAlt />} label="Sync" size="small" />}
      </Box>
    </Box>
  </ListItem>
}

export default ProtocolPermissionScope;