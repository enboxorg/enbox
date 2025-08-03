import { Loader2Icon, User2Icon, Wallet2Icon, XIcon } from "lucide-react";
import { Button } from "../ui/button"
import { Typography } from "../ui/typography"
import { useWeb5 } from "@/web5";
import { useEffect, useState } from "react";
import ConnectQR from "./connect-qr";
import ConnectPin from "./connect-pin";
import { toastError } from "@/lib/utils";
import { profileDefinition } from "@/protocols/profile";
import { taskDefinition } from "@/protocols/tasks";


interface ConnectSelectorProps {
  close         : () => void;
}

type ConnectState = 'init' | 'showQR' | 'showPin' | 'loading' | 'done';

const ConnectSelector: React.FC<ConnectSelectorProps> = ({
  close,
}) => {
  const { connect, walletConnect } = useWeb5();

  const [ state, setState ] = useState<ConnectState>('loading');
  const [ qrCode, setQrCode ] = useState('');
  const [ pin, setPin ] = useState('');

  useEffect(() => {
    if (qrCode.length > 0) {
      setState('showQR');
    }
  }, [ qrCode ]);

  useEffect(() => {
    if (state === 'done') {
      setTimeout(close, 500);
    }
  },[ state, close ]);


  useEffect(() => {
    if (connect !== undefined && walletConnect !== undefined) {
      setState('init');
    }
  }, [ connect, walletConnect ]);

  const createDid = async () => {
    if (!connect) {
      return;
    }

    setState('loading');
    try {
      await connect();
    } catch(error) {
      toastError('Error creating new DID', error);
    } finally{
      close();
    }
  }

  const submitPin = () => {
    if (pin.length === 0) {
      return;
    }
    setState('loading');
    postMessage({ type: 'pinSubmitted', pin }, window.parent.origin);
  }

  const handleConnect = async () => {
    if (!walletConnect) {
      throw new Error('Wallet connect not available');
    }
    setState('loading');

    try {
      console.log('Starting wallet connection...');
      const result = await walletConnect({
        connectServerUrl: "https://enbox-production.up.railway.app/connect",
        walletUri: "web5://connect",
        displayName: "Todo DApp",
        permissionRequests: [{ protocolDefinition: profileDefinition }, { protocolDefinition: taskDefinition }],
        onWalletUriReady: (text: string) => {
          console.log('Wallet URI ready:', text);
          const url = new URL(text);
          url.protocol = 'web+dwn';
          setQrCode(url.toString());
          setState('showQR');
        },
        validatePin: async () => {
          setState('showPin');

          return new Promise((resolve) => {
            const eventListener = (event: MessageEvent) => {
              if (event.data.type === 'pinSubmitted') {
                removeEventListener('message', eventListener);
                resolve(event.data.pin);
              }
            }

            addEventListener('message', eventListener);
          });
        },
      });
      console.log('Wallet connection result:', result);
    } catch(error) {
      console.error('Error in handleConnect:', error);
      toastError('Error connecting to wallet', error);
    } finally {
      setState('done');
    }
  }


  return (<div className="bg-secondary text-primary  p-6 rounded-lg">
    {state === 'loading' && <Loader2Icon className="animate-spin h-12 w-12 text-primary" />}
    {state === 'init' && <div>
      <div className="flex justify-between items-center mb-4">
        <Typography variant="h3">Connect to a Wallet</Typography>
      </div>
      <div className="flex flex-col space-y-4">
        <Button onClick={() => createDid()}>Create A New DID <User2Icon className="ml-2 h-4 w-4" /></Button>
        <Button onClick={() => handleConnect()}>Connect To a Wallet <Wallet2Icon className="ml-2 h-4 w-4" /></Button>
        <Button onClick={() => close()}>Cancel<XIcon className="ml-2 h-4 w-4" /></Button>
      </div>
    </div>}
    {state === 'showQR' && <ConnectQR
      value={qrCode}
      close={close}
    />}
    {state === 'showPin' && <ConnectPin
      value={pin}
      onChange={setPin}
      close={close}
      submit={submitPin}
    />}
    {state === 'done' && <div>Done</div>}
  </div>)
}

export default ConnectSelector;