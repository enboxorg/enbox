import ConnectRequest from "@/components/ConnectRequest";
import { useAgent } from "@/contexts/Context";
import { truncateDid } from "@/lib/utils";
import { FileOpen, FlashOff, FlashOn, NoPhotography } from "@mui/icons-material";
import { Box, Button, CircularProgress, FormControl, IconButton, InputLabel, MenuItem, Select, Typography } from "@mui/material";
import { PageContainer, useNotifications } from "@toolpad/core"
import { Oidc, Web5ConnectAuthRequest } from "@enbox/agent";
import { CryptoUtils } from "@enbox/crypto";
import Scanner from 'qr-scanner';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const AppConnect: React.FC = () => {

  return (<PageContainer title={'Scan QR Code'}>
    <Box sx={{  }} >
      <QRScanner />
    </Box>
  </PageContainer>)
}

const QRScanner: React.FC = () => {
  const { agent } = useAgent();
  const notifications = useNotifications();
  const navigate = useNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<Scanner>();
  const inputRef = useRef<HTMLInputElement>(null);

  const [ loading, setLoading ] = useState<boolean>(false);
  const [ cameraError, setCameraError ] = useState<boolean>(false);
  const [ loaded, setLoaded ] = useState<boolean>(false);
  const [ devices, setDevices ] = useState<Scanner.Camera[]>([]);
  const [ selectedCamera, setSelectedCamera ] = useState<string>('environment');
  const [ hasFlash, setHasFlash ] = useState<boolean>(false);
  const [ connectionRequest, setConnectionRequest ] = useState<Web5ConnectAuthRequest>();
  const [ authorizing, setAuthorizing ] = useState<boolean>(false);
  const [ pin, setPin ] = useState<string>('');

  const onSuccess = useCallback(async (result: Scanner.ScanResult) => {
    videoRef.current?.pause();
    return handleConnectFlow(result.data);
  }, [ scannerRef ]);

  useEffect(() => {
    const loadCamera = async () => {
      setLoading(true);
      try {
        if (!await Scanner.hasCamera()) {
          setCameraError(true);
          notifications.show('No camera found', { severity: 'error', autoHideDuration: 1500 });
          return
        }

        scannerRef.current = new Scanner(videoRef.current!, onSuccess, {
          preferredCamera: 'environment',
          highlightScanRegion: true,
          maxScansPerSecond: 5,
        });

        const cameras = await Scanner.listCameras(true);
        setDevices([...cameras, { id: 'environment', label: 'Environment' }]);
        await scannerRef.current.start();

        const hasFlash = await scannerRef.current.hasFlash();
        setHasFlash(hasFlash);
        setLoaded(true);
      } catch (error) {
        notifications.show('Failed to start camera', { severity: 'error', autoHideDuration: 1500 });
      } finally {
        setLoading(false);
      }
    }

    if (!loading && !loaded && videoRef.current && !scannerRef.current) {
      loadCamera();
    }

    return () => {
      if (!videoRef?.current) {
        scannerRef?.current?.stop();
      }
    };
  }, []);

  const flashOn = useMemo(() => {
    return scannerRef.current?.isFlashOn();
  }, [ scannerRef.current ]);
  
  const toggleFlash = useCallback(async () => {
    await scannerRef.current?.toggleFlash();
  }, [ scannerRef ]);

  const selectCamera = useCallback((cameraId: string) => {
    if (cameraId === selectedCamera) return;

    if (devices.find(device => device.id === cameraId)) {
      scannerRef.current?.setCamera(cameraId);
      setSelectedCamera(cameraId);
    }

  }, [ selectedCamera, devices ]);

  const fromFile = () => {
    if (inputRef.current) {
      inputRef.current.click();
    }
  }

  const handleQrFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const results = await Scanner.scanImage(file, { returnDetailedScanResult: true })
      return handleConnectFlow(results.data);
    } catch (error) {
      notifications.show('Failed to read file', { severity: 'error', autoHideDuration: 1500 });
    }
  }

  const handleConnectFlow = async (uri: string) => {
    const connectionURI = new URL(uri);
    const request_uri = connectionURI.searchParams.get('request_uri');
    const encryption_key = connectionURI.searchParams.get('encryption_key');
    if (!request_uri || !encryption_key) {
      notifications.show('Invalid connection URI', { severity: 'error', autoHideDuration: 1500 });
      return;
    }

    try {
      const decryptedConnectionRequest = await Oidc.getAuthRequest(
        request_uri,
        encryption_key
      );
      setConnectionRequest(decryptedConnectionRequest);
    } catch(error) {
      console.error('failed to connect', error);
      notifications.show('Failed to connect', { severity: 'error', autoHideDuration: 1500 });
      return;
    }
  }

  const handleAuthorize = async (did: string) => {
    if (!agent) {
      notifications.show('Agent not found', { severity: 'error', autoHideDuration: 1500 });
      return;
    }

    if (!connectionRequest) {
      notifications.show('No connection request found', { severity: 'error', autoHideDuration: 1500 });
      return;
    }

    setAuthorizing(true);
    try {
      const pin = CryptoUtils.randomPin({ length: 4 });
      setPin(pin);
      await Oidc.submitAuthResponse(did, connectionRequest, pin, agent);
    } catch (error) {
      console.error('failed to authorize', error);
      notifications.show('Failed to authorize', { severity: 'error', autoHideDuration: 1500 });
    } finally {
      setAuthorizing(false);
    }
  }

  return <Box>
    <input
      hidden
      type="file"
      onChange={handleQrFile}
      ref={inputRef}
      name="qr-file"
    />
    {authorizing && <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent:' center' }}>
        <CircularProgress />
        <Typography variant="h6">Authorizing...</Typography>
      </Box>
    </Box>}
    {!connectionRequest && cameraError && <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <Box sx={{ textAlign: 'center', mt: 2 }}>
        <NoPhotography />
        <h3>Camera not found</h3>
        <p>Make sure you have a camera connected to your device.</p>
      </Box>
    </Box>}
    {!connectionRequest && !cameraError &&  <>
      {<Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'space-around' }}>
        <FormControl fullWidth>
          <InputLabel id="camera-label">Camera</InputLabel>
          <Select
            labelId="camera-label"
            id="camera-select"
            value={devices.length === 0 ? '' : selectedCamera}
            label="Age"
            onChange={(e) => {selectCamera(e.target.value) }}
          >
            {devices.map(device => <MenuItem key={device.id} value={device.id} selected={device.id === selectedCamera}>{device.label}</MenuItem>)}
          </Select>
        </FormControl>
        <video
          ref={videoRef}
          data-testid="scanner-video"
          style={{
            width: '100%',
            objectFit: 'cover',
          }}
        >
        </video>
        <Box sx={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', position: 'absolute', bottom: 0, left: 0, right: 0 }}>
        <IconButton
            disabled={!hasFlash}
            onClick={toggleFlash}
          >
            {!hasFlash || !flashOn ? <FlashOff /> : <FlashOn />}
        </IconButton>
        <IconButton
            onClick={fromFile}
          >
            <FileOpen />
        </IconButton>
        </Box>
      </Box>}
    </>}
    {!pin && !authorizing && connectionRequest && <ConnectRequest
      origin={truncateDid(connectionRequest.client_id)}
      permissions={connectionRequest.permissionRequests}
      handleApprove={handleAuthorize}
      handleDeny={() => navigate('/')}
    />}
    {!authorizing && pin && <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <Typography variant="h4" sx={{ mt: 5, mb: 2 }}>{pin}</Typography>
      <Typography variant="subtitle1">Enter this pin in the requesting application</Typography>
      <Box sx={{ mt: 10 }}>
        <Button
          variant="contained"
          color="primary"
          onClick={() => navigate('/')}
          >Done</Button>
      </Box>
    </Box>}
  </Box>
}

export default AppConnect;