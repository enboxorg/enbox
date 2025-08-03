import React, { useState } from 'react';
import { Card, Typography, Avatar, Box, styled, Tooltip, ClickAwayListener, alpha } from '@mui/material';
import { truncateDid } from '@/lib/utils';
import { CopyIcon, CheckCircle } from 'lucide-react';
import { Identity } from '@/lib/types';

interface IdentityCardProps {
  identity: Identity;
  selected?: boolean;
  compact?: boolean;
  onClick: () => void;
}

const BannerOverlay = styled(Box)(({ theme }) => ({
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
}));

const IdentityCard: React.FC<IdentityCardProps> = ({ identity, onClick, selected = false, compact = false }) => {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const social = identity.profile.social;

  const handleCopyDid = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigator.clipboard.writeText(identity.didUri);
    setTooltipOpen(true);
    setTimeout(() => setTooltipOpen(false), 1500);
  };

  const handleTooltipClose = () => {
    setTooltipOpen(false);
  };

  return (
    <Card
      onClick={onClick}
      raised={selected}
      sx={{ 
        mb: 1,
        cursor: 'pointer',
        bgcolor: selected ? 'action.selected' : 'background.paper',
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        alignItems: compact ? 'center' : 'stretch',
        height: compact ? 72 : 200,
        width: compact ? '100%' : '100%',
        maxWidth: compact ? 'none' : 550,
        overflow: 'hidden',
        borderRadius: 2,
      }}
    >
      {!compact && (
        <Box sx={{ position: 'relative', height: '100%', width: '100%' }}>
          <Box
            component="img"
            src={identity.profile.heroUrl}
            alt={`${social?.displayName || 'user'}'s banner`}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
          <BannerOverlay />
          <Box
            sx={{
              position: 'absolute',
              bottom: 16,
              left: 16,
              right: 16,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
            }}
          >
            {social?.displayName && (
              <Typography variant="body2" sx={{ color: 'common.white', mb: 0.5, textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                {social.displayName}
              </Typography>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'common.white', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                {truncateDid(identity.didUri, 30)}
              </Typography>
              <ClickAwayListener onClickAway={handleTooltipClose}>
                <Tooltip
                  open={tooltipOpen}
                  title="Copied!"
                  placement="top"
                  onClose={handleTooltipClose}
                >
                  <Box component="span" sx={{ ml: 0.5, cursor: 'pointer' }}>
                    <CopyIcon size={14} color="white" onClick={handleCopyDid} />
                  </Box>
                </Tooltip>
              </ClickAwayListener>
            </Box>
          </Box>
          <Avatar 
            src={identity.profile.avatarUrl} 
            alt={social?.displayName || 'user'}
            sx={{ 
              position: 'absolute',
              top: 16,
              left: 16,
              width: 64,
              height: 64,
            }}
          >
            {social?.displayName?.charAt(0).toUpperCase() || 'U'}
          </Avatar>
          {selected && (
            <CheckCircle 
              size={24}
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                borderRadius: '50%',
              }}
            />
          )}
        </Box>
      )}
      {compact && (
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center',
          width: '100%',
          height: '100%',
          px: 2,
        }}>
          <Avatar 
            src={identity.profile.avatarUrl} 
            alt={social?.displayName || 'user'}
            sx={{ 
              width: 48, 
              height: 48, 
              mr: 2,
            }}
          >
            {social?.displayName?.charAt(0).toUpperCase() || 'U'}
          </Avatar>
          <Box sx={{ flexGrow: 1, overflow: 'hidden' }}>
            <Typography variant="subtitle1" noWrap>
              {social?.displayName || ''}
            </Typography>
            <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
              {truncateDid(identity.didUri, 20)}
            </Typography>
          </Box>
          {selected && <CheckCircle size={20} style={{ marginLeft: 8 }} />}
        </Box>
      )}
    </Card>
  );
};

export default IdentityCard;