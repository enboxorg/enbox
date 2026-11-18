/** Released Profile payloads and codecs for the wallet-pinned module URI. */
import { recordCodecs } from '@enbox/api';

export type ProfileData = {
  displayName: string;
  bio?: string;
  tagline?: string;
  location?: string;
  website?: string;
  pronouns?: string;
};

export type LinkData = {
  url: string;
  title: string;
  icon?: string;
  sortOrder?: number;
};

export type AvatarData = Blob;
export type HeroData = Blob;

export const ProfileCodecs = {
  profile : recordCodecs.json<ProfileData>(),
  avatar  : recordCodecs.blob(),
  hero    : recordCodecs.blob(),
  link    : recordCodecs.json<LinkData>(),
} as const;
