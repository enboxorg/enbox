import PublicIdentityCard from '@/components/identity/PublicIdentityCard';
import { TextField } from '@mui/material';
import { Did } from '@enbox/dids';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageContainer } from '@toolpad/core';
import { Convert } from '@enbox/common';
import { profileDefinition } from '@/lib/ProfileProtocol';
import { SocialData } from '@/lib/types';
import { truncateDid } from '@/lib/utils';

const profileProtocolB64 = Convert.string(profileDefinition.protocol).toBase64Url();

const SearchIdentitiesPage: React.FC = () => {
  const { didUri } = useParams<{ didUri: string }>();
  const navigate = useNavigate();

  const [ didInput, setDidInput ] = useState('');
  const [ did, setDid ] = useState('');
  const [ social, setSocial ] = useState<SocialData>();

  useEffect(() => {
    const fetchSocial = async (did: string) => {
      const social = await fetch(`https://dweb/${did}/read/protocols/${profileProtocolB64}/social`);
      const socialData = await social.json();
      setSocial(socialData);
    };

    if (!social && did) {
      fetchSocial(did);
    }

  }, [ did, social ]);

  const heroUrl = `https://dweb/${did}/read/protocols/${profileProtocolB64}/hero`;
  const avatarUrl = `https://dweb/${did}/read/protocols/${profileProtocolB64}/avatar`;

  useEffect(() => {
    if (didUri) {
      setDid(didUri);
      setDidInput(didUri);
    }
  }, [ didUri ]);

  const title = useMemo(() => {
    return social ? social.displayName : did ? truncateDid(did) : 'Search';
  }, [ social, did ]);

  const path = useMemo(() => {
    return did ? `/search/${did}` : '/search';
  }, [ did ]);

  const breadCrumbs = did ? [{ title: 'Find DIDs', path: '/search' }, { title, path }]: [{ title: 'Find DIDs', path: '/search' }, { title, path }];

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();

    setDidInput(e.target.value);
    const did = Did.parse(e.target.value);
    if (did) {
      const didResolution = await fetch(`https://dweb/${did.uri}`);
      if (didResolution.ok) {
        const didResolutionData = await didResolution.json();
        if (didResolutionData.didDocument) {
          navigate(`/search/${did.uri}`);
          return;
        }
      }
    } 
    navigate('/search');
    setDid('');
  }

  return (<PageContainer title={title} breadcrumbs={breadCrumbs}>
    <TextField
      fullWidth
      label="Search for a DID"
      placeholder="did:web:example.com"
      name="did"
      value={didInput}
      onChange={handleInputChange}
    />
    {did && <PublicIdentityCard did={did} social={social} />}
  </PageContainer>)
}

export default SearchIdentitiesPage;