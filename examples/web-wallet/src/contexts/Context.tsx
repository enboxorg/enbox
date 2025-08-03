import { useContext } from "react";
import { AgentContext } from "./AgentContext";
import { IdentitiesContext } from "./IdentitiesContext";
import { ProtocolsContext } from "./ProtocolsContext";
import { BackupSeedContext } from "./BackupSeedContext";
import { DragOverIdentitiesContext } from "./DragOverIdentities";

export const useAgent = () => {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error("useAgent must be used within a Web5Provider");
  }

  const { agent, initialized, unlocked, lock } = context;

  return {
    lock,
    agent: initialized && unlocked ? agent : undefined,
  };
};

export const useIdentities = () => {
  const context = useContext(IdentitiesContext);
  if (!context) {
    throw new Error("useAgent must be used within a Web5Provider");
  }

  const { 
    createIdentity, 
    updateIdentity,
    identities, 
    loadIdentities, 
    selectedIdentity, 
    selectIdentity, 
    deleteIdentity,
    exportIdentity,
    dwnEndpoints,
    protocols,
    permissions,
    wallets,
    importIdentity,
    setWallets,
    setDwnEndpoints
  } = context;

  return {
    identities,
    loadIdentities,
    createIdentity,
    updateIdentity,
    deleteIdentity,
    exportIdentity,
    importIdentity,
    selectedIdentity,
    protocols,
    permissions,
    wallets,
    dwnEndpoints,
    selectIdentity,
    setWallets,
    setDwnEndpoints
  };
};

export const useProtocols= () => {
  const context = useContext(ProtocolsContext);
  if (!context) {
    throw new Error("useProtocols must be used within a ProtocolsProvider");
  }

  const {
    getDefinition
  } = context;

  return {
    getDefinition
  };
};

export const useBackupSeed = () => {
  const context = useContext(BackupSeedContext);
  if (!context) {
    throw new Error("useBackupSeed must be used within a BackupSeedProvider");
  }

  const { backupSeed, setBackupSeed, removeBackupSeed, showSeedScreen, toggleSeedScreen } = context;

  return { backupSeed, setBackupSeed, removeBackupSeed, showSeedScreen, toggleSeedScreen };
};

export const useDragIdentities = () => {
  const context = useContext(DragOverIdentitiesContext);
  if (!context) {
    throw new Error("useDragIdentities must be used within a DragOverIdentitiesProvider");
  }

  const { processFile, identities, setIdentities } = context;

  return { processFile, identities, setIdentities };
};