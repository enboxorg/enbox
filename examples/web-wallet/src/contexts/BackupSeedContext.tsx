import React, { createContext, useEffect, useState } from "react";

interface BackupSeedContextProps {
  showSeedScreen: boolean;
  toggleSeedScreen: () => void;
  backupSeed: string | undefined;
  setBackupSeed: (seed: string) => void;
  removeBackupSeed: () => void;
}

export const BackupSeedContext = createContext<BackupSeedContextProps>({ 
  showSeedScreen: false,
  toggleSeedScreen: () => {},
  backupSeed: undefined,
  setBackupSeed: () => {},
  removeBackupSeed: () => {},
});

export const BackupSeedProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [backupSeed, setBackupSeedState ] = useState<string | undefined>(undefined);
  const [showSeedScreen, setShowSeedScreen] = useState<boolean>(false);

  const toggleSeedScreen = () => {
    setShowSeedScreen(!showSeedScreen);
  }

  useEffect(() => {
    const checkLocalStorage = () => {
      const seed = localStorage.getItem('recoveryPhrase');
      setBackupSeedState(seed || undefined);
    };

    checkLocalStorage();

    window.addEventListener('storage', checkLocalStorage);
    return () => window.removeEventListener('storage', checkLocalStorage);
  }, []);

  const setBackupSeed = (seed: string) => {
    localStorage.setItem('recoveryPhrase', seed);
  }

  const removeBackupSeed = () => {
    localStorage.removeItem('recoveryPhrase');
  }

  return (
    <BackupSeedContext.Provider value={{
      backupSeed,
      setBackupSeed,
      removeBackupSeed,
      showSeedScreen,
      toggleSeedScreen
    }}>
      {children}
    </BackupSeedContext.Provider>
  );
};
