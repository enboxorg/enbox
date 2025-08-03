import React, { useState } from 'react';
import { Box, Button, Typography } from "@mui/material"
import PublicIdentityCard from "./identity/PublicIdentityCard"
import PermissionRequest from "./PermissionsRequest"
import { Check as CheckIcon, Close as CloseIcon } from '@mui/icons-material';
import { ConnectPermissionRequest } from "@enbox/agent";
import IdentitySelector from './IdentitySelector';

const ConnectRequest: React.FC<{
  did?: string;
  origin?: string;
  permissions: ConnectPermissionRequest[];
  handleApprove: (selectedDid: string) => void;
  handleDeny: () => void;
  [key: string]: any;
}> = ({ origin, did, permissions, handleApprove, handleDeny, ...props }) => {
  const [ selectedDid, setSelectedDid ] = useState<string>(did || '');

  return <Box 
      {...props}
      sx={{
        mb: 2, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center',
        ...props.sx,
      }}
    >

    {origin && <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
      <img
        src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${origin}&size=128`}
        style={{ width: 45, height: 45 }}
      />
    </Box>}
    {origin && <Typography variant="h5" color="text.secondary">{origin}</Typography>}

    <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1 }}>
      is requesting permissions from
    </Typography>
    <Box sx={{ mb: 4, mt: 2 }}>
      {selectedDid && <PublicIdentityCard did={selectedDid} compact={true} />}
      {!selectedDid && <Typography variant="subtitle2" color="text.secondary">Select an identity to approve the request</Typography>}
    </Box>
    {!did && <IdentitySelector value={selectedDid} onChange={setSelectedDid} sx={{ px: 5, width: '100%', mb: 2 }} />}
    <Typography variant="subtitle1" gutterBottom>Requested Permissions:</Typography>
    <PermissionRequest permissions={permissions} />
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2, mb: 2, gap: 2 }}>
      <Button
        variant="contained" 
        color="error"
        startIcon={<CloseIcon />}
        onClick={handleDeny}
        sx={{ minWidth: 120 }}
      >
        Deny
      </Button>
      <Button
        variant="contained" 
        color="success"
        startIcon={<CheckIcon />}
        onClick={() => handleApprove(selectedDid)}
        sx={{ minWidth: 120 }}
      >
        Approve
      </Button>
    </Box>
  </Box>
}

export default ConnectRequest;