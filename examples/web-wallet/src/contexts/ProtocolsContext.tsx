import React, { createContext, useCallback, useState } from "react";
import { useAgent } from "./Context";
import { DwnProtocolDefinition } from "@enbox/agent";
import Web5Helper from "@/lib/Web5Helper";

interface ProtocolContextProps {
  getDefinition(fromDid: string, protocol: string): Promise<DwnProtocolDefinition | undefined>;
}

export const ProtocolsContext = createContext<ProtocolContextProps>({
  getDefinition: async () => undefined,
});

export const ProtocolsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { agent } = useAgent();
  const [ protocolDefinitionsMap, setProtocolDefinitionsMap ] = useState<Map<string, DwnProtocolDefinition>>(new Map());

  const getDefinition = useCallback(async (fromDid: string, protocol: string) => {
    if (!agent) {
      throw new Error('Agent not available');
    }

    if (!protocolDefinitionsMap.has(protocol)) {
      const helper = Web5Helper(fromDid, agent);
      const definition = await helper.getProtocolDefinition(protocol);
      if (definition) {
        setProtocolDefinitionsMap(new Map(protocolDefinitionsMap.set(protocol, definition)));
      }
      return definition;
    }

    return protocolDefinitionsMap.get(protocol);
  }, [ agent, protocolDefinitionsMap ]);

  return (
    <ProtocolsContext.Provider
      value={{
        getDefinition,
      }}
    >
      {children}
    </ProtocolsContext.Provider>
  );
};