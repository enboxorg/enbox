import { useBackupSeed } from '@/contexts/Context';
import LockIcon from '@mui/icons-material/Lock';
import { Box, Button, Container, Paper, TextField, Typography } from "@mui/material";
import Grid from '@mui/material/Grid2';
import { Web5UserAgent } from '@enbox/user-agent';
import { useCallback, useEffect, useState } from 'react';
import PinInput from './PinInput';

const LoadAgent:React.FC<{
  agent: Web5UserAgent | undefined;
  initialized: boolean;
  initialize: (password: string, dwnEndpoint: string) => Promise<string | undefined>;
  unlock: (password: string) => Promise<void>;
}> = ({ agent, initialized, initialize, unlock }) => {

  const { setBackupSeed } = useBackupSeed();

  const [pin, setPin] = useState(['', '', '', '']);
  const [invalidPin, setInvalidPin] = useState(false);
  const [dwnEndpoint, setDwnEndpoint] = useState('https://dwn.enbox.org/latest');

  useEffect(() => {
    if (initialized && pin.length === 4 && pin.every(digit => digit !== '')) {
      const pinString = pin.join('');
      handleAgentSetup(pinString);
    }

  }, [ pin, initialized ]);

  const handleAgentSetup = useCallback(async (password: string) => {
   if (agent && !initialized && password) {
      try {
        const recoveryPhrase = await initialize(password, dwnEndpoint);
        if (recoveryPhrase) {
          setBackupSeed(recoveryPhrase);
        }
      } finally {
        // reset the password and auto submit regardless of the result
        setPin(['', '', '', '']);
      }
    } else if (initialized && password) {

      try {
        await unlock(password);
        setInvalidPin(false);
      } catch (error) {
        setInvalidPin(true);

        setTimeout(() => {
          // remove the error message after 1.5 seconds
          setInvalidPin(false);
        }, 1500);

      } finally {
        // reset the password and auto submit regardless of the result
        setPin(['', '', '', '']);
      }
    }
  }, [ agent, initialized, dwnEndpoint ]);

  const handleUnlock =  useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const pinString = pin.join('');
    return handleAgentSetup(pinString);
  }, [ pin ]);

  return <Container maxWidth="sm">
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      minHeight="100vh"
      sx={{
        animation: invalidPin ? 'shake 0.2s' : 'none',
        '@keyframes shake': {
          '0%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-5px)' },
          '50%': { transform: 'translateX(5px)' },
          '75%': { transform: 'translateX(-5px)' },
          '100%': { transform: 'translateX(0)' },
        },
      }}
    >
      <Paper elevation={3} sx={{ p: 4, width: '100%', maxWidth: 400, textAlign: 'center' }}>
        <LockIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
        <Typography variant="h4" gutterBottom>
          { initialized ? "Unlock Agent" : "Setup Agent" }
        </Typography>
        <Typography variant="body1" sx={{ mb: 4 }}>
          Enter your 4-digit PIN to { initialized ? "unlock" : "setup" }
        </Typography>
        <form autoComplete="off" onSubmit={handleUnlock}>
          <PinInput initialPin={pin} onPinChange={(updatedPin) => setPin(updatedPin)} />

          <Box sx={{ display: 'block' }} m={2}>
            <Typography variant="body2" color="error" minHeight={"1.5em"}>
              {invalidPin && 'Invalid PIN. Please try again.'}
            </Typography>
          </Box>

          {!initialized && <Grid container spacing={2} justifyContent="center" sx={{ my: 4 }}>
            <TextField
              label="DWN Endpoint"
              value={dwnEndpoint}
              onChange={(e) => setDwnEndpoint(e.target.value)}
              fullWidth
            />
          </Grid>}
          <Button
            type="submit"
            variant="contained"
            color="primary"
            fullWidth
            size="large"
            disabled={pin.some(digit => digit === '')}
          >
            { initialized ? "Unlock" : "Setup" }
          </Button>
        </form>
      </Paper>
    </Box>
  </Container>
}

export default LoadAgent;