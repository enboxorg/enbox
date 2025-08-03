import { useNavigate } from 'react-router-dom';
import { useIdentities } from '@/contexts/Context';
import { QRCodeCanvas} from 'qrcode.react';
import Grid from '@mui/material/Grid2';
import {
  Box, Typography, Avatar, Paper, Divider, IconButton,
  styled, List, ListItem, ListItemText,
  ListItemIcon, Menu, MenuItem, Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  ClickAwayListener,
} from '@mui/material';
import {
  Edit, Delete, GetApp, ContentCopy, QrCode2,
  Language, MoreVert,
  Person2Outlined,
} from '@mui/icons-material';
import { PageContainer } from "@toolpad/core";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import ProtocolItem from '@/components/ProtocolItem';
import PermissionsList from '@/components/PermissionsList';

const IdentityDetailsPage: React.FC = () => {
  const { didUri } = useParams();
  const navigate = useNavigate();
  const { selectedIdentity, protocols, permissions, wallets, dwnEndpoints, selectIdentity, deleteIdentity, exportIdentity } = useIdentities();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [showQrCode, setShowQrCode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyTooltipOpen, setCopyTooltipOpen] = useState(false);
  const [copyTooltipText, setCopyTooltipText] = useState("Copy DID");

  const BannerOverlay = styled(Box)(({ theme }) => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  }));

  useEffect(() => {
    if (didUri !== selectedIdentity?.didUri) {
      selectIdentity(didUri);
    }
  }, [didUri, selectedIdentity, selectIdentity]);


  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleDelete = async () => {
    if (selectedIdentity) {
      await deleteIdentity(selectedIdentity.didUri);
      navigate('/');
    }
  };

  const handleBackup = async () => {
    if (selectedIdentity) {
      const identity = await exportIdentity(selectedIdentity.didUri);

      const blob = new Blob([JSON.stringify(identity)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedIdentity.didUri}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setBackupDialogOpen(false);
    }
  }

  const handleCopyDid = () => {
    if (!selectedIdentity) return;

    navigator.clipboard.writeText(selectedIdentity.didUri);
    setCopyTooltipText("Copied!");
    setCopyTooltipOpen(true);
    setTimeout(() => {
      setCopyTooltipText("Copy DID");
      setCopyTooltipOpen(false);
    }, 1500);
  };

  const handleTooltipClose = () => {
    setCopyTooltipOpen(false);
    setCopyTooltipText("Copy DID");
  };

  const social = useMemo(() => {
    if (selectedIdentity) {
      return selectedIdentity.profile.social;
    }
  }, [selectedIdentity]);

  const title = useMemo(() => {
    return selectedIdentity?.profile.social?.displayName
     ? `${selectedIdentity.profile.social?.displayName} (${selectedIdentity.persona})` : 'Loading...';
  }, [ selectedIdentity ]);

  const breadCrumbs = useMemo(() => {
    return selectedIdentity ? [{ title: 'Identities', path: '/identities' }, { title: selectedIdentity.persona, path: `/identity/${didUri}` }] : [];
  }, [ selectedIdentity, didUri ]);

  return <PageContainer title={title} breadcrumbs={breadCrumbs}>
    {selectedIdentity && (<Box sx={{ pb: 4 }}>
      <Box sx={{ maxWidth: 1200, margin: '0 auto' }}>
        <Paper elevation={3} sx={{ mb: 4 }}>
          <Box sx={{ position: 'relative', height: 300 }}>
            <Box
              component="img"
              src={selectedIdentity.profile.heroUrl}
              alt={`${social?.displayName || 'user'}'s banner`}
              sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <BannerOverlay />
              <Box sx={{ position: 'absolute', bottom: 16, left: 16, right: 16, display: 'flex', alignItems: 'flex-end' }}>
              <Avatar
                src={selectedIdentity.profile.avatarUrl}
                alt={social?.displayName || 'user'}
                sx={{ width: 120, height: 120, border: `4px solid`, mr: 2 }}
            >
              {social?.displayName?.charAt(0).toUpperCase() || 'U'}
            </Avatar>
            <Box sx={{ flexGrow: 1 }}>
              {social?.displayName && (
                <Typography variant="subtitle1" sx={{ color: 'common.white', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                  {social.displayName} ({selectedIdentity.persona})
                </Typography>
              )}
            </Box>
            <IconButton onClick={handleMenuOpen} sx={{ color: 'common.white' }}>
              <MoreVert />
            </IconButton>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={handleMenuClose}
            >
              <MenuItem onClick={() => { handleMenuClose(); navigate(`/identity/edit/${selectedIdentity.didUri}`); }}>
                <ListItemIcon><Edit fontSize="small" /></ListItemIcon>
                <ListItemText>Edit Identity</ListItemText>
              </MenuItem>
              <MenuItem onClick={() => setBackupDialogOpen(true)}>
                <ListItemIcon><GetApp fontSize="small" /></ListItemIcon>
                <ListItemText>Backup Identity</ListItemText>
              </MenuItem>
              <Divider />
              <MenuItem onClick={() => setConfirmDelete(true)}>
                <ListItemIcon><Delete fontSize="small" /></ListItemIcon>
                <ListItemText>Delete Identity</ListItemText>
              </MenuItem>
            </Menu>
          </Box>
        </Box>
        <Box sx={{ p: 3 }}>
          <Typography variant="body1" gutterBottom>{social?.tagline}</Typography>
          <Divider sx={{ my: 2 }} />
          <Grid container spacing={2}>
            <Grid size={12}>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Person2Outlined sx={{ mr: 1 }} />
                <Typography variant="body2" sx={{ mr: 1 }}>
                  {selectedIdentity.didUri}
                </Typography>
                <ClickAwayListener onClickAway={handleTooltipClose}>
                  <Tooltip
                    title={copyTooltipText}
                    open={copyTooltipOpen}
                    onClose={handleTooltipClose}
                    disableFocusListener
                    disableHoverListener
                    disableTouchListener
                  >
                    <IconButton size="small" onClick={handleCopyDid}>
                      <ContentCopy fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </ClickAwayListener>
                <Tooltip title="Show QR Code">
                  <IconButton size="small" onClick={() => setShowQrCode(true)}>
                    <QrCode2 fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </Grid>
            <Grid size={{ xs: 12, sm: 6  }}>
              <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
                {dwnEndpoints.map(endpoint => (
                    <Box key={endpoint} sx={{ display: 'flex', alignItems: 'center' }}>
                      <Language sx={{ mr: 1 }} />
                      <Typography variant="body2">{endpoint}</Typography>
                  </Box>
                ))}
              </Box>
            </Grid>
          </Grid>
          {social?.bio && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="body2">{social.bio}</Typography>
            </>
          )}
        </Box>
        </Paper>
      </Box>

      <Box sx={{ maxWidth: 1200, margin: '0 auto' }}>
        <Grid container spacing={3}>
          {/* Protocols section */}
          <Grid size={{ xs: 12, md: 6 }}>
            <Paper elevation={1} sx={{ p: 3, height: '100%' }}>
              <Typography variant="h6" gutterBottom>Protocols</Typography>
              <Divider sx={{ mb: 2 }} />
              <List>
                {protocols.map((definition) => <ProtocolItem key={definition.protocol} definition={definition} /> )}
              </List>
            </Paper>
          </Grid>

          {/* Wallets section */}
          <Grid size={{ xs: 12, md: 6 }}>
            <Paper elevation={1} sx={{ p: 3, height: '100%' }}>
              <Typography variant="h6" gutterBottom>Wallets</Typography>
              <Divider sx={{ mb: 2 }} />
              <List>
                {wallets.map((wallet, index) => (
                  <ListItem key={index}>
                    <ListItemText primary={wallet} />
                  </ListItem>
                ))}
              </List>
            </Paper>
          </Grid>

          {/* Permissions section */}
          <Grid size={12}>
            <Paper elevation={1} sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom>Permissions</Typography>
              <Divider sx={{ mb: 2 }} />
              <PermissionsList
                permissions={permissions}
                protocols={protocols}
              />
            </Paper>
          </Grid>
        </Grid>
      </Box>

      {confirmDelete && (
        <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
          <DialogTitle>Delete Identity</DialogTitle>
          <DialogContent>Are you sure you want to delete this identity?</DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button onClick={handleDelete}>Delete</Button>
          </DialogActions>
        </Dialog>
      )}

      {backupDialogOpen && (
        <Dialog open={backupDialogOpen} onClose={() => setBackupDialogOpen(false)}>
          <DialogTitle>Backup Identity</DialogTitle>
          <DialogContent>
            <Box>
              Back up your identity to a file. This contains your private key information.
            </Box>
            <Typography variant="body2" sx={{ mt: 2 }}>{selectedIdentity.didUri}</Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleBackup}>Download File</Button>
            <Button onClick={() => setBackupDialogOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}

      {showQrCode && (
        <Dialog open={showQrCode} onClose={() => setShowQrCode(false)} >
          <DialogTitle sx={{ textAlign: 'center' }}>Scan QR Code</DialogTitle>
          <DialogContent>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1 }}>
              <QRCodeCanvas
                value={selectedIdentity.didUri}
                size={256}
                bgColor={'#FFFFFF'}
                fgColor={'#000000'}
                level="Q"
                imageSettings={{
                  src: selectedIdentity.profile.avatarUrl || '',
                  height: 67,
                  width: 67,
                  excavate: true,
                }}
              />
            </Box>
            <Typography variant="caption" sx={{ textAlign: 'center' }}>{selectedIdentity.didUri}</Typography>
            <Typography variant="body2" sx={{ mt: 2, textAlign: 'center' }}>
              Scan the QR code to resolve this identity. 
            </Typography>
            <Button onClick={() => setShowQrCode(false)} sx={{ mt: 2, display: 'block', margin: '0 auto' }}>Close</Button>
          </DialogContent>
        </Dialog>
      )}
    </Box>)}
  </PageContainer>
}

export default IdentityDetailsPage;