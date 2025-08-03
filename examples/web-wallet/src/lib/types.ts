export interface Identity {
  persona: string;
  didUri: string;
  profile: ProfileData;
}

export type ProfileData = {
  social?: SocialData;
  avatar?: Blob;
  avatarUrl?: string;
  hero?: Blob;
  heroUrl?: string;
}

export type SocialData = {
  displayName: string;
  tagline: string;
  bio: string;
  apps: Record<string, string>;
}