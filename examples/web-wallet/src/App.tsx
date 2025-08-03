import { AgentProvider } from '@/contexts/AgentContext';
import { IdentitiesProvider } from '@/contexts/IdentitiesContext';
import { BackupSeedProvider } from '@/contexts/BackupSeedContext';

import { activatePolyfills } from '@enbox/browser';
import { useEffect } from 'react';
import Dashboard from './layoutes/Dshboard';
import { ProtocolsProvider } from './contexts/ProtocolsContext';

activatePolyfills();

function App() {

  useEffect(() => {
    const connectSupport = async (e: MessageEvent) => {
      const { type, did } = e.data;
      if (type === 'dweb-connect-support-request') {
        e.stopPropagation();
        e.preventDefault();

        let supported = false;
        const localStorageIdentities = localStorage.getItem('identities');
        if (localStorageIdentities) {
          const parsedIdentities = JSON.parse(localStorageIdentities) as string[];
          supported = parsedIdentities.includes(did);
        }

        window.parent.postMessage({
          type: 'dweb-connect-support-response',
          supported
        }, e.origin);
      }
    }

    window.addEventListener('message', connectSupport);

    return () => {
      window.removeEventListener('message', connectSupport);
    };
  }, []);

  return (
    <BackupSeedProvider>
      <AgentProvider>
        <ProtocolsProvider>
          <IdentitiesProvider>
            <Dashboard />
          </IdentitiesProvider>
        </ProtocolsProvider>
      </AgentProvider>
    </BackupSeedProvider>
  );
}

export default App;
