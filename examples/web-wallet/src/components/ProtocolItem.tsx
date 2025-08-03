import { Lock, Public } from "@mui/icons-material"
import { ListItem, ListItemIcon, ListItemText } from "@mui/material"
import { DwnProtocolDefinition } from "@enbox/agent"

const ProtocolItem: React.FC<{
  definition: DwnProtocolDefinition
}> = ({ definition }) => {
  const icon = definition.published ? <Public fontSize="small" /> : <Lock fontSize="small" />
  const primaryText = definition.protocol;
  const secondaryText = definition.published ? 'Published' : 'Private';

  return <ListItem>
    <ListItemIcon>{icon}</ListItemIcon>
    <ListItemText primary={primaryText} secondary={secondaryText} />
  </ListItem>
}

export default ProtocolItem;