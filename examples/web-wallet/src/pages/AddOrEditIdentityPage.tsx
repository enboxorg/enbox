import React, { useEffect, useMemo, useState } from 'react';
import { useIdentities } from '@/contexts/Context';
import {
  Button,
  TextField,
  Box,
  Avatar,
  Typography,
  CircularProgress,
  IconButton,
} from '@mui/material';
import Grid from '@mui/material/Grid2'; // Updated import for Grid2
import { PlusIcon } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Identity } from '@/lib/types';
import { PageContainer } from '@toolpad/core';
import ListInput from '@/components/ListInput';

const AddOrEditIdentityPage: React.FC<{ edit?: boolean }> = ({ edit = false }) => {
  const { didUri } = useParams();
  const navigate = useNavigate();
  const { createIdentity, updateIdentity, selectedIdentity, selectIdentity, dwnEndpoints } = useIdentities();
  const [loadedIdentity, setLoadedIdentity] = useState(false);
  const [loading, setLoading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);

  const defaultForm = {
    persona: '',
    displayName: '',
    tagline: '',
    bio: '',
          dwnEndpoints: ['https://dwn.enbox.org/latest'],
    avatar: null as File | Blob | null,
    banner: null as File | Blob | null,
  }

  const [formData, setFormData] = useState(defaultForm);

  const isEdit = edit && selectedIdentity;

  const resetForm = () => {
    setFormData(defaultForm);
    setAvatarPreview(null);
    setBannerPreview(null);
  }

  useEffect(() => {
    if (didUri && selectedIdentity?.didUri !== didUri) {
      selectIdentity(didUri);
    }
  }, [ didUri, selectedIdentity ]);

  useEffect(() => {
    const loadIdentityForm = async () => {
      if (!selectedIdentity) {
        return;
      };

      setFormData({
        persona: selectedIdentity.persona,
        displayName: selectedIdentity.profile.social?.displayName || '',
        tagline: selectedIdentity.profile.social?.tagline || '',
        bio: selectedIdentity.profile.social?.bio || '',
        dwnEndpoints,
        avatar: selectedIdentity.profile.avatar || null,
        banner: selectedIdentity.profile.hero || null,
      });

      setAvatarPreview(selectedIdentity.profile.avatar ? URL.createObjectURL(selectedIdentity.profile.avatar) : null);
      setBannerPreview(selectedIdentity.profile.hero ? URL.createObjectURL(selectedIdentity.profile.hero) : null);

      setLoadedIdentity(true);
    }

    if (isEdit && selectedIdentity?.didUri === didUri && !loadedIdentity) {
      loadIdentityForm();
    } else if (!isEdit && selectedIdentity) {
      selectIdentity(undefined);
      resetForm();
    }

  }, [ isEdit, selectedIdentity, loadedIdentity, didUri ]);


  const submitDisabled = useMemo(() => {
    if (isEdit) {
      return formData.persona === selectedIdentity.persona &&
             formData.displayName === selectedIdentity.profile.social?.displayName &&
             formData.tagline === selectedIdentity.profile.social?.tagline &&
             formData.bio === selectedIdentity.profile.social?.bio &&
             formData.avatar === selectedIdentity.profile.avatar &&
             formData.banner === selectedIdentity.profile.hero &&
             (formData.dwnEndpoints.length === dwnEndpoints.length &&
              formData.dwnEndpoints.every(endpoint => dwnEndpoints.includes(endpoint)));
    }

    return formData.persona === '' || formData.displayName === '' || formData.dwnEndpoints.length === 0;
  }, [ isEdit, formData, selectedIdentity ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      let identity: Identity | undefined;
      if (isEdit) {
        await updateIdentity({
          didUri: selectedIdentity.didUri,
          persona: formData.persona,
          dwnEndpoints: formData.dwnEndpoints,
          displayName: formData.displayName,
          tagline: formData.tagline,
          bio: formData.bio,
          avatar: formData.avatar ? new Blob([formData.avatar], { type: formData.avatar.type }) : undefined,
          hero: formData.banner ? new Blob([formData.banner], { type: formData.banner.type }) : undefined,
        });

        identity = selectedIdentity;
      } else {
        identity = await createIdentity({
          persona: formData.persona,
          displayName: formData.displayName,
          tagline: formData.tagline,  
          bio: formData.bio,
          dwnEndpoints: formData.dwnEndpoints,
          walletHost: window.location.origin,
          avatar: formData.avatar ? new Blob([formData.avatar], { type: formData.avatar.type }) : undefined,
          hero: formData.banner ? new Blob([formData.banner], { type: formData.banner.type }) : undefined,
        });
      }

      if (!identity) {
        throw new Error('Failed to create identity');
      }
      navigate(`/identity/${identity.didUri}`);
    } catch (error) {
      console.error('Error creating identity:', error);
      // Handle error (e.g., show error message to user)
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, files } = e.target;
    if (files && files.length > 0) {
      const file = files[0];
      setFormData({ ...formData, [name]: file });

      const reader = new FileReader();
      reader.onloadend = () => {
        if (name === 'avatar') {
          setAvatarPreview(reader.result as string);
        } else if (name === 'banner') {
          setBannerPreview(reader.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleClearBanner = (e: React.MouseEvent) => {
    if (formData.banner) {
      e.preventDefault();
      setBannerPreview(null);
      setFormData({ ...formData, banner: null });
    }
  }

  const title = selectedIdentity ? `Edit ${selectedIdentity.persona} Identity` : 'Add a New Identity';
  const breadCrumbs = selectedIdentity ?  [] : []

  return (
    <PageContainer title={title} breadcrumbs={breadCrumbs}>
      <form onSubmit={handleSubmit}>
        {loading ? (
          <Box display="flex" justifyContent="center" alignItems="center" height={400}>
            <CircularProgress />
          </Box>
        ) : (
          <Grid container spacing={3}>
            <Grid size={12}>
              <TextField
                fullWidth
                label="Persona"
                name="persona"
                value={formData.persona}
                onChange={handleInputChange}
                placeholder="Social, Professional, Gaming, etc."
                required
              />
            </Grid>
            <Grid size={12} sx={{ display: 'flex', alignItems: 'center' }}>
              <Box position="relative" mr={2} sx={{ width: 60, height: 60 }}>
                <Avatar
                  src={avatarPreview || undefined}
                  sx={{ width: 60, height: 60 }}
                />
                <IconButton
                  component="label"
                  sx={{
                    position: 'absolute',
                    right: 10,
                    bottom: 10,
                    opacity: 0.5,
                    backgroundColor: 'background.paper',
                    '&:hover': { backgroundColor: 'background.default' },
                  }}
                >
                  <PlusIcon />
                  <input
                    type="file"
                    hidden
                    accept="image/*"
                    onChange={handleFileChange}
                    width={20}
                    name="avatar"
                  />
                </IconButton>
              </Box>
              <TextField
                fullWidth
                label="Display Name"
                name="displayName"
                value={formData.displayName}
                onChange={handleInputChange}
                placeholder="Display Name"
                required
              />
            </Grid>
            {bannerPreview && (
              <Grid size={12} >
                <Box display="flex" flexDirection="column" alignItems="left">
                  <Typography variant="subtitle2">Banner Preview:</Typography>
                  <Box
                    sx={{
                      width: '100%',
                      borderRadius: 2,
                      overflow: 'hidden',
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <img 
                      src={bannerPreview} 
                      alt="Banner preview" 
                      style={{ width: '100%', height: 'auto', maxHeight: 200, objectFit: 'cover' }} 
                    />
                  </Box>
                </Box>
              </Grid>
            )}
            <Grid size={12}>
              {<Box display="flex" alignItems="center">
                <Button
                  variant="outlined"
                  component="label"
                  onClick={handleClearBanner}
                >
                  {bannerPreview ? 'Clear Banner' : 'Upload Banner'}
                  <input
                    type="file"
                    hidden
                    accept="image/*"
                    onChange={handleFileChange}
                    name="banner"
                  />
                </Button>
              </Box>}
            </Grid>
            <Grid size={12}>
              <TextField
                fullWidth
                label="Tagline"
                name="tagline"
                value={formData.tagline}
                onChange={handleInputChange}
              />
            </Grid>
            <Grid size={12}>
              <TextField
                fullWidth
                label="Bio"
                name="bio"
                value={formData.bio}
                onChange={handleInputChange}
                multiline
                rows={4}
              />
            </Grid>
            <ListInput
              label={"DWN Endpoint"}
              value={formData.dwnEndpoints}
                              defaultValue={'https://dwn.enbox.org/latest'}
                placeholder='https://dwn.enbox.org/latest'
              onChange={(value) => {
                setFormData({ ...formData, dwnEndpoints: value });
              }}
            />
            <Box mt={4}>
              <Button
                type="submit"
                disabled={loading || submitDisabled}
                variant="contained"
                color="primary"
                size="large"
              >
                {isEdit ? 'Update Identity' : 'Add Identity'}
              </Button>
              {isEdit && (
                <Button
                  variant="outlined"
                  size="large"
                  sx={{ ml: 2 }}
                  onClick={() => navigate(`/identity/${selectedIdentity.didUri}`)}
                >
                  Cancel
                </Button>
              )}
            </Box>
          </Grid>
        )}
      </form>
    </PageContainer>
  );
};

export default AddOrEditIdentityPage;