import React, { useCallback, useMemo, useRef, useState }  from 'react';
import { useNavigate } from 'react-router-dom';
import { PortableIdentity } from '@enbox/agent';

import { PageContainer } from '@toolpad/core';
import { Box, Button, CircularProgress } from '@mui/material';

import PublicIdentityCard from '@/components/identity/PublicIdentityCard';
import { useAgent, useDragIdentities, useIdentities } from '@/contexts/Context';
import { CheckCircle, HighlightOff } from '@mui/icons-material';

type ImportStatus = 'pending' | 'success' | 'error';

const ImportIdentityPage: React.FC = () => {
  const { agent } = useAgent();
  const { importIdentity, loadIdentities } = useIdentities();
  const { identities, setIdentities, processFile } = useDragIdentities();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const [ importing, setImporting ] = useState(false);
  const [ doneImporting, setDoneImporting ] = useState(false);
  const [ status, setStatus ] = useState<Map<string, ImportStatus>>(new Map());

  const handleAddIdentity = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(processFile);
    }
  }, [ processFile ])

  const removeButton = useCallback((didUri: string) => {
    return <Button onClick={() => {
      setIdentities(identities.filter((i) => i.metadata.uri !== didUri));
    }}>Remove</Button>
  }, [ identities ]);

  const identitySlot = useCallback((didUri: string) => {
    const didStatus = status.get(didUri);
    switch (didStatus) {
      case 'success':
        return <CheckCircle />;
      case 'error':
        return <HighlightOff />;
      default:
        if (importing) {
          return <CircularProgress />;
        }
      return removeButton(didUri);
    }
  }, [ status, importing ]);

  const importPortableIdentity = useCallback(async (identity: PortableIdentity) => {
    try {
      await importIdentity(window.location.origin, identity);
      status.set(identity.metadata.uri, 'success');
    } catch (error) {
      status.set(identity.metadata.uri, 'error');
    }

    setStatus(new Map(status));
  }, [ setStatus, status ]);

  const importIdentities = useCallback(async () => {
    if (!agent) {
      throw new Error('Agent not initialized');
    }

    setImporting(true);
    // stop the syncing process before importing
    await agent.sync.stopSync();

    try {
      // import the identities and complete a pull sync
      await Promise.all(identities.map(importPortableIdentity));
      await agent.sync.sync('pull');
    } finally {
      // start the sync process again
      agent.sync.startSync({ interval: '15s' });
      setImporting(false);
      setDoneImporting(true);
      await loadIdentities();
    }

  }, [ identities, status, agent, loadIdentities ]);

  const canImport = useMemo(() => {
    return !doneImporting && !importing && identities.length > 0;
  }, [ identities, importing, doneImporting ]);

  return (<PageContainer>
    <Button
      onClick={() => inputRef.current?.click()}
      sx={{ mb: 2 }}
    >
      Add Identity
      <input
        hidden
        type="file"
        onChange={handleAddIdentity}
        ref={inputRef}
        name="banner"
      />
    </Button>
    {identities.map((identity) => {
      return <PublicIdentityCard
        compact={true}
        key={identity.metadata.uri}
        did={identity.metadata.uri}
        slot={identitySlot(identity.metadata.uri)}
        sx={{ mb: 2, maxWidth: 650, alignItems: 'center' }}
      />
   })}
   {canImport && (
      <Box sx={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', mt: 2 }}>
        <Button disabled={importing} sx={{ mr: 2 }} variant="contained" onClick={importIdentities}>Import</Button>
        <Button disabled={importing} variant="contained" onClick={() => setIdentities([])}>Clear</Button>
      </Box>
    ) || doneImporting && (
      <Box sx={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', mt: 2 }}>
        <Button variant="contained" onClick={() => {
          setIdentities([]);
          setStatus(new Map());
          navigate('/');
        }}>Done</Button>
      </Box>
    )}
  </PageContainer>);
}


export default ImportIdentityPage;