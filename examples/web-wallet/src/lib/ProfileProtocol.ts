import { DwnProtocolDefinition, Web5Agent } from "@enbox/agent";

import Web5Helper from "./Web5Helper";
import { SocialData } from "./types";

export const profileDefinition: DwnProtocolDefinition = {
  published: true,
  protocol: "https://enbox.org/protocols/profile",
  types: {
    name: {
      dataFormats: ['application/json']
    },
    social: {
      dataFormats: ['application/json']
    },
    messaging: {
      dataFormats: ['application/json']
    },
    phone: {
      dataFormats: ['application/json']
    },
    address: {
      dataFormats: ['application/json']
    },
    career: {
      dataFormats: ['application/json']
    },
    payment: {
      dataFormats: ['application/json']
    },
    connect: {
      dataFormats: ['application/json']
    },
    avatar: {
      dataFormats: ['image/gif', 'image/png', 'image/jpeg', 'image/webp']
    },
    hero: {
      dataFormats: ['image/gif', 'image/png', 'image/jpeg', 'image/webp']
    }
  },
  structure: {
    name: {},
    social: {},
    career: {},
    avatar: {},
    hero: {},
    messaging: {},
    address: {},
    phone: {},
    payment: {},
    connect: {}
  }
}

const ProfileProtocol = (didUri: string, agent: Web5Agent) => {
  const web5Helper = Web5Helper(didUri, agent);

  const setRecordData = async (path: string, dataFormat: string, data: any) => {
    const record = await web5Helper.getRecord(profileDefinition.protocol, path);
    return record ?
      await web5Helper.updateRecord(record, dataFormat, data) :
      await web5Helper.createRecord(profileDefinition.protocol, path, dataFormat, data);
  }

  const deleteRecord = async (path: string) => {
    const record = await web5Helper.getRecord(profileDefinition.protocol, path);
    return record ? await web5Helper.deleteRecord(record) : undefined;
  }

  const getSocial = async (): Promise<SocialData | undefined> => {
    const record = await web5Helper.getRecord(profileDefinition.protocol, 'social');
    return record ? record.data.json() : undefined;
  }

  const getAvatar = async (): Promise<Blob | undefined> => {
    const attachment = await web5Helper.getRecord(profileDefinition.protocol, 'avatar');
    return attachment ? attachment.data.blob() : undefined;
  }

  const getHero = async (): Promise<Blob | undefined> => {
    const attachment = await web5Helper.getRecord(profileDefinition.protocol, 'hero');
    return attachment ? attachment.data.blob() : undefined;
  }

  const setSocial = async (social: SocialData) => {
    return setRecordData('social', 'application/json', social);
  }

  const setAvatar = async (avatar: Blob | null) => {
    return avatar ? setRecordData('avatar', avatar.type, avatar) : deleteRecord('avatar');
  }

  const setHero = async (hero: Blob | null) => {
    return hero ? setRecordData('hero', hero.type, hero) : deleteRecord('hero');
  }

  return {
    getSocial,
    getAvatar,
    getHero,
    setSocial,
    setAvatar,
    setHero,
  }
}

export default ProfileProtocol;