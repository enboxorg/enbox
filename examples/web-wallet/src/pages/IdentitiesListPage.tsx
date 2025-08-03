import React  from 'react';
import IdentityCard from '@/components/identity/IdentityCard';
import { useIdentities } from '@/contexts/Context';
import { PageContainer } from '@toolpad/core';
import { useNavigate } from 'react-router-dom';
import { Box, Button } from '@mui/material';

const IdentitiesListPage: React.FC = () => {
  const { identities } = useIdentities();
  const navigate = useNavigate();

  return (<PageContainer>
    {identities.length === 0 && <Box sx={{
      mt: '2rem',
      display: 'flex',
      alignItems: 'end',
      gap: '1rem'
    }}>
      <span>No identities found.</span> <Button variant='contained' onClick={() => navigate('/identities/create')}>Create one</Button>
    </Box>}
    {identities.map((identity) => (
      <IdentityCard
        key={identity.didUri}
        identity={identity}
        onClick={() => navigate(`/identity/${identity.didUri}`)}
        compact={true}
      />
    ))}
  </PageContainer>)
}


export default IdentitiesListPage;