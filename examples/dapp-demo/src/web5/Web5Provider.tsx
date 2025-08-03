import React, { createContext, useEffect, useState } from "react";

import { ConnectOptions, Web5, Web5ConnectResult } from "@enbox/api";
import { installProtocols } from "./protocols";

declare global {
  interface Window {
    web5: Web5ConnectResult;
  }
}

interface Web5ContextProps {
  previouslyConnected: boolean;
  protocolsInitialized: boolean;
  web5Connection?: Web5ConnectResult;
  connect?: () => Promise<Web5ConnectResult>;
  walletConnect?: (walletConnectOptions: ConnectOptions) => Promise<Web5ConnectResult>;
  isConnecting: boolean;
}

export const Web5Context = createContext<Web5ContextProps>({
  previouslyConnected: false,
  isConnecting: false,
  protocolsInitialized: false,
});

export const Web5Provider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {

  const [ previouslyConnected, setPreviouslyConnected ] = useState(false);
  const [protocolsInitialized, setProtocolsInitialized] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [web5Connection, setWeb5Connection] = useState<
    Web5ConnectResult | undefined
  >(undefined);

  useEffect(() => {
    const previouslyConnected = localStorage.getItem('previouslyConnected');
    if (previouslyConnected) {
      setPreviouslyConnected(previouslyConnected === 'true');
    }

    window.addEventListener('storage', (event) => {
      if (event.key === 'previouslyConnected') {
        setPreviouslyConnected(event.newValue === 'true')
      }
    });


  }, [ setPreviouslyConnected ]);

  useEffect(() => {
    if (web5Connection && !protocolsInitialized) {
      // Check if we have a valid DID before installing protocols
      if (!web5Connection.did) {
        console.error('Web5Connection exists but DID is undefined:', web5Connection);
        return;
      }
      
      console.log('Installing protocols for DID:', web5Connection.did);
      installProtocols(web5Connection.web5.dwn, web5Connection.did).then(
        (installationResult) => {
          setProtocolsInitialized(installationResult);
        }
      ).catch((error) => {
        console.error('Protocol installation error:', error);
      });
    }
  }, [web5Connection, protocolsInitialized]);

  const walletConnect = async (walletConnectOptions: ConnectOptions) => {
    try {
      console.log('Starting wallet connection with options:', walletConnectOptions);
      const connection = await Web5.connect({ walletConnectOptions, sync: '15s' });
      console.log('Connection result:', connection);
      
      if (!connection || !connection.did) {
        throw new Error('Invalid connection result - missing did');
      }
      
      window.web5 = connection;
      localStorage.setItem('previouslyConnected', 'true');
      setWeb5Connection(connection);
      setIsConnecting(false);
      return connection;
    } catch (error) {
      console.error('Wallet connection error:', error);
      setIsConnecting(false);
      throw error;
    }
  }

  const connect = async () => {
    setIsConnecting(true);

    try {
      const connectOptions = {
        techPreview: {
          dwnEndpoints: ["https://enbox-production.up.railway.app/"],
        },
        sync: '15s',
      };
      const connection = await Web5.connect(connectOptions);
      window.web5 = connection;
      localStorage.setItem('previouslyConnected', 'true');
      setWeb5Connection(connection);
      setIsConnecting(false);
      return connection;
    } catch (error) {
      setIsConnecting(false);
      throw error;
    }
  };

  return (
    <Web5Context.Provider
      value={{
        previouslyConnected,
        protocolsInitialized,
        walletConnect,
        connect,
        web5Connection,
        isConnecting,
      }}
    >
      {children}
    </Web5Context.Provider>
  );
};
