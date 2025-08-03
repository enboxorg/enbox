import React, { createContext, useCallback, useEffect, useState } from "react";
import { BearerIdentity, DwnPermissionGrant, DwnProtocolDefinition, getDwnServiceEndpointUrls, PortableIdentity, Web5Agent } from "@enbox/agent";

import Web5Helper from "@/lib/Web5Helper";
import ProfileProtocol, { profileDefinition } from "@/lib/ProfileProtocol";

import { useAgent } from "./Context";
import { Identity } from "@/lib/types";
import { Convert } from "@enbox/common";
import { PermissionGrant, Record } from "@enbox/api";

const loadProfileFromBearerIdentity = (agent: Web5Agent) => async (identity: BearerIdentity): Promise<Identity> => {
  const profileProtocol = ProfileProtocol(identity.did.uri, agent);
  const social = await profileProtocol.getSocial();
  const avatar = await profileProtocol.getAvatar();
  const avatarUrl = avatar ? `https://dweb/${identity.did.uri}/read/protocols/${Convert.string(profileDefinition.protocol).toBase64Url()}/avatar` : undefined;
  const hero = await profileProtocol.getHero();
  const heroUrl = hero ? `https://dweb/${identity.did.uri}/read/protocols/${Convert.string(profileDefinition.protocol).toBase64Url()}/hero` : undefined;

  return {
    persona: identity.metadata.name,
    didUri: identity.did.uri,
    profile: {
      social,
      avatar,
      avatarUrl,
      hero,
      heroUrl
    }
  }
}

export interface CreateIdentityParams {
  persona: string;
  displayName: string;
  tagline: string;
  bio: string;
  walletHost: string;
  dwnEndpoints: string[];
  avatar?: Blob;
  hero?: Blob;
}

export interface UpdateIdentityParams extends Omit<CreateIdentityParams, 'walletHost'> {
  didUri: string;
}

interface IdentityContextProps {
  identities: Identity[];
  loadIdentities: () => Promise<void>;
  createIdentity: (params: CreateIdentityParams) => Promise<Identity>;
  updateIdentity: (params: UpdateIdentityParams) => Promise<void>;
  deleteIdentity: (didUri: string) => Promise<void>;
  exportIdentity: (didUri: string) => Promise<PortableIdentity>;
  importIdentity: (walletHost: string, identity: PortableIdentity) => Promise<void>;

  /** Identity specific */
  selectedIdentity: Identity | undefined;
  protocols: DwnProtocolDefinition[];
  permissions: DwnPermissionGrant[];
  wallets: string[];
  dwnEndpoints: string[];
  selectIdentity: (didUri: string | undefined) => void;
  setWallets: (wallets: string[]) => Promise<void>;
  setDwnEndpoints: (dwnEndpoints: string[]) => Promise<void>;
}

export const IdentitiesContext = createContext<IdentityContextProps | null>(null);

export const IdentitiesProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { agent } = useAgent();
  const [ loadingIdentities, setLoadingIdentities ] = useState<boolean>(false);
  const [ identities, setIdentities ] = useState<Identity[]>([]);
  const [ selectedIdentity, setSelectedIdentity ] = useState<Identity | undefined>();
  const [ protocols, setProtocols ] = useState<DwnProtocolDefinition[]>([]);
  const [ permissions, setPermissions ] = useState<PermissionGrant[]>([]);
  const [ wallets, setWalletsState ] = useState<string[]>([]);
  const [ dwnEndpoints, setDwnEndpointsState ] = useState<string[]>([]);

  const setIdentityWallets = async (didUri: string, wallets: string[]) => {
    if (!agent) return;
    const web5Helper = Web5Helper(didUri, agent);
    let record = await web5Helper.getRecord(profileDefinition.protocol, 'connect');
    if (!record) {
      record = await web5Helper.createRecord(profileDefinition.protocol, 'connect', 'application/json', { webWallets: wallets });
    } else {
      await web5Helper.updateRecord(record, 'application/json', { webWallets: wallets });
    }
  }

  const selectIdentity = (didUri: string | undefined) => {
    const identity = identities.find(identity => identity.didUri === didUri);
    setSelectedIdentity(identity);
  }

  const loadIdentities = useCallback(async () => {
    if (!agent) return;
    if (loadingIdentities) return;
    setLoadingIdentities(true);

    try {
      const identities = await agent.identity.list() || [];
      const parsedIdentities = await Promise.all(identities.map(loadProfileFromBearerIdentity(agent)));
      setIdentities(parsedIdentities);
    } finally {
      setLoadingIdentities(false);
    }
  }, [ agent, loadingIdentities ]);

  const loadSelectedIdentity = useCallback(async () => {
    if (!selectedIdentity || !agent) {
      return;
    };

    const web5Helper = Web5Helper(selectedIdentity.didUri, agent);

    const permissionsPromise = web5Helper.listPermissions();
    const protocolsPromise = web5Helper.listProtocols();
    const walletsPromise = web5Helper.getRecord(profileDefinition.protocol, 'connect').then(getWallets);
    const dwnEndpointsPromise = getDwnServiceEndpointUrls(selectedIdentity.didUri, agent.did);

    setPermissions(await permissionsPromise);
    setProtocols(await protocolsPromise);
    setWalletsState(await walletsPromise);
    setDwnEndpointsState(await dwnEndpointsPromise);

  }, [ selectedIdentity ]);

  const getWallets = async (record?: Record) => {
    if (!record) {
      return [];
    } else {
      const { webWallets } = await record.data.json() as { webWallets: string[] };
      return webWallets;
    }
  }

  const createIdentity = async ({ persona, dwnEndpoints, walletHost, displayName, tagline, bio, avatar, hero }: CreateIdentityParams) => {
    if (!agent) {
      throw new Error("Agent not found");
    }

    const identity = await agent.identity.create({
        store     : true,
        didMethod : 'dht',
        didOptions: {
          services: [
            {
              id              : 'dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : dwnEndpoints,
              enc             : '#enc',
              sig             : '#sig',
            }
          ],
          verificationMethods: [
            {
              algorithm : 'Ed25519',
              id        : 'sig',
              purposes  : ['assertionMethod', 'authentication']
            },
            {
              algorithm : 'secp256k1',
              id        : 'enc',
              purposes  : ['keyAgreement']
            }
          ]
        },
      metadata: { name: persona }
    });

    await agent.sync.registerIdentity({ did: identity.did.uri, options: { protocols: [
      profileDefinition.protocol,
    ]} });

    const localStorageIdentities = localStorage.getItem('identities');
    if (localStorageIdentities) {
      const parsedIdentities = JSON.parse(localStorageIdentities) as string[];
      parsedIdentities.push(identity.did.uri);
      localStorage.setItem('identities', JSON.stringify(parsedIdentities));
    } else {
      localStorage.setItem('identities', JSON.stringify([ identity.did.uri ]));
    }

    await agent.sync.sync('pull');

    /** Configure profile protocol */
    const web5Helper = Web5Helper(identity.did.uri, agent);
    await web5Helper.configureProtocol(profileDefinition);

    /** Set Wallet Information */
    await setWallets([ walletHost ]);

    /** Set Profile Information */
    const profileProtocol = ProfileProtocol(identity.did.uri, agent);
    await profileProtocol.setSocial({ displayName, tagline, bio, apps: {} });

    if (avatar) {
      await profileProtocol.setAvatar(avatar);
    }

    if (hero) {
      await profileProtocol.setHero(hero);
    }

    const craetedIdentity = {
      persona: persona,
      didUri: identity.did.uri,
      profile: {
        social: { displayName, tagline, bio, apps: {} },
        avatar,
        hero
      }
    }

    setIdentities([ ...identities, craetedIdentity ]);
    return craetedIdentity;
  }

  const updateIdentity = async ({ didUri, persona, displayName, tagline, bio, avatar, hero, dwnEndpoints }: UpdateIdentityParams) => {
    if (!agent) {
      throw new Error("Agent not found");
    }

    const identity = identities.find(identity => identity.didUri === didUri);
    if (!identity) {
      throw new Error("Identity not found");
    }

    if (identity.persona !== persona) {
      await agent.identity.setMetadataName({ didUri, name: persona });
    }

    const profileProtocol = ProfileProtocol(didUri, agent);

    if (identity.profile.social?.displayName !== displayName || identity.profile.social?.tagline !== tagline || identity.profile.social?.bio !== bio) {
      await profileProtocol.setSocial({ displayName, tagline, bio, apps: {} });
    }

    if (avatar !== identity.profile.avatar) {
      await profileProtocol.setAvatar(avatar || null);
    }

    if (hero !== identity.profile.hero) {
      await profileProtocol.setHero(hero || null);
    }

    const existingEndpoints = await getDwnServiceEndpointUrls(didUri, agent.did);
    if (existingEndpoints.length !== dwnEndpoints.length || !dwnEndpoints.every(endpoint => existingEndpoints.includes(endpoint))) {
      await agent.identity.setDwnEndpoints({ didUri, endpoints: dwnEndpoints });
    }

    const updatedIdentity = {
      ...identity,
      persona,
      profile: {
        ...identity.profile,
        displayName,
        tagline,
        bio,
        avatar,
        hero
      }
    }

    const updatedIdentities = identities.map(identity => {
      if (identity.didUri === didUri) {
        return updatedIdentity;
      }
      return identity;
    });

    setSelectedIdentity(updatedIdentity);
    setIdentities(updatedIdentities);
    setDwnEndpointsState(dwnEndpoints);
  }

  const deleteIdentity = async (didUri: string) => {
    if (!agent) throw new Error("Agent not found");

    const identity = await agent.identity.get({ didUri });
    if (!identity) throw new Error("Identity not found");

    const localStorageIdentities = localStorage.getItem('identities');
    if (localStorageIdentities) {
      const parsedIdentities = JSON.parse(localStorageIdentities) as string[];
      localStorage.setItem('identities', JSON.stringify(parsedIdentities.filter((identity: string) => identity !== didUri)));
    }

    try {
      await agent.sync.unregisterIdentity(didUri);
    } catch(error) {
      console.error('could not unregister identity', error);
    }

    await agent.identity.delete({ didUri });


    try {
      // await agent.did.delete({ didUri, tenant: agent.agentDid.uri });
      await agent.did.delete({ didUri, tenant: agent.agentDid.uri });
    } catch(error) {
      /** Newer versions of `@web5/agent` should not throw an error here */
      console.error('could not delete did', error);
    }

    setIdentities(identities.filter(identity => identity.didUri !== didUri));
  }

  const importIdentity = async (walletHost: string, identity: PortableIdentity) => {
    if (!agent)  {
      throw new Error("Agent Not Found");
    }

    const exists = await agent.identity.get({ didUri: identity.portableDid.uri });
    if (exists) {
      throw new Error("Identity already exists");
    }

    const importedIdentity = await agent.identity.import({ portableIdentity: identity });
    await agent.sync.registerIdentity({ did: importedIdentity.did.uri });

    const localStorageIdentities = localStorage.getItem('identities');
    if (localStorageIdentities) {
      const parsedIdentities = JSON.parse(localStorageIdentities) as string[];
      parsedIdentities.push(importedIdentity.did.uri);
      localStorage.setItem('identities', JSON.stringify(parsedIdentities));
    } else {
      localStorage.setItem('identities', JSON.stringify([ importedIdentity.did.uri ]));
    }

    const web5Helper = Web5Helper(importedIdentity.did.uri, agent);
    await web5Helper.configureProtocol(profileDefinition);

    const wallets = await web5Helper.getRecord(profileDefinition.protocol, 'connect').then(getWallets);
    if (wallets.length === 0 || !wallets.includes(walletHost)) {
      wallets.push(walletHost);
      await setIdentityWallets(importedIdentity.did.uri, wallets);
    }
  }

  const exportIdentity = async (didUri: string) => {
    const identity = await agent?.identity.get({ didUri });
    if (!identity) {
      throw new Error("Identity not found");
    }

    const portableIdentity = await identity.export();
    return portableIdentity;
  };

  const setWallets = async (wallets: string[]) => {
    if (!agent) return;
    if (!selectedIdentity) return;
    await setIdentityWallets(selectedIdentity.didUri, wallets);
  }

  /* TODO: Implement in `@web5/agent` */
  const setDwnEndpoints = async () => {
    throw new Error("Not implemented");
  }

  useEffect(() => {
    if (agent) {
      loadIdentities();
    }
  }, [agent]);

  useEffect(() => {
    if (selectedIdentity && agent) {
      loadSelectedIdentity();
    }
  }, [ selectedIdentity, agent ]);

  return (
    <IdentitiesContext.Provider
      value={{
        identities,
        wallets,
        protocols,
        permissions,
        dwnEndpoints,
        selectedIdentity,
        loadIdentities,
        setWallets,
        createIdentity,
        updateIdentity,
        deleteIdentity,
        selectIdentity,
        importIdentity,
        exportIdentity,
        setDwnEndpoints
      }}
    >
      {children}
    </IdentitiesContext.Provider>
  );
};
