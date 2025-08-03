import React from 'react';
import { SpeedDial, SpeedDialIcon, SpeedDialAction } from '@mui/material';

const SidebarSpeedDial: React.FC<{ 
  actions: { icon: React.ReactNode, name: string, handler: () => void }[];
  sx?: React.CSSProperties
}> = ({ actions, sx }) => {
  return (
    <SpeedDial
      ariaLabel="SpeedDial with persistent tooltips"
      sx={sx}
      icon={<SpeedDialIcon />}
    >
      {actions.map((action) => (
        <SpeedDialAction
          key={action.name}
          icon={action.icon}
          tooltipTitle={action.name}
          onClick={action.handler}
          tooltipOpen
          sx={{
            '& .MuiSpeedDialAction-staticTooltipLabel': {
              maxWidth: 'none',
              whiteSpace: 'nowrap',
            },
          }}
        />
      ))}
    </SpeedDial>
  );
}

export default SidebarSpeedDial;
