import { describe, expect, it } from 'bun:test';

import {
  ConnectDefinition,
  ConnectProtocol,
  PreferencesDefinition,
  PreferencesProtocol,
  ProfileDefinition,
  ProfileProtocol,
} from '../src/index.js';

describe('@enbox/protocols', () => {
  describe('ProfileProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ProfileDefinition.protocol).toBe('https://identity.foundation/protocols/profile');
    });

    it('should define profile, avatar, hero, and link types', () => {
      expect(ProfileDefinition.types.profile).toBeDefined();
      expect(ProfileDefinition.types.avatar).toBeDefined();
      expect(ProfileDefinition.types.hero).toBeDefined();
      expect(ProfileDefinition.types.link).toBeDefined();
    });

    it('should allow binary formats for avatar and hero', () => {
      expect(ProfileDefinition.types.avatar.dataFormats).toContain('image/png');
      expect(ProfileDefinition.types.avatar.dataFormats).toContain('image/jpeg');
      expect(ProfileDefinition.types.hero.dataFormats).toContain('image/png');
      expect(ProfileDefinition.types.hero.dataFormats).toContain('image/jpeg');
    });

    it('should nest avatar, hero, and link under profile', () => {
      expect(ProfileDefinition.structure.profile.avatar).toBeDefined();
      expect(ProfileDefinition.structure.profile.hero).toBeDefined();
      expect(ProfileDefinition.structure.profile.link).toBeDefined();
    });

    it('should enforce size limits on avatar and hero', () => {
      expect(ProfileDefinition.structure.profile.avatar.$size?.max).toBe(12582912);
      expect(ProfileDefinition.structure.profile.hero.$size?.max).toBe(25165824);
    });

    it('should enforce $recordLimit on profile, avatar, and hero singletons', () => {
      expect(ProfileDefinition.structure.profile.$recordLimit).toEqual({ max: 1 });
      expect(ProfileDefinition.structure.profile.avatar.$recordLimit).toEqual({ max: 1 });
      expect(ProfileDefinition.structure.profile.hero.$recordLimit).toEqual({ max: 1 });
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(ProfileProtocol.definition).toBe(ProfileDefinition);
      expect(Object.keys(ProfileProtocol.codecs).sort()).toEqual(['avatar', 'hero', 'link', 'profile']);
    });
  });

  describe('PreferencesProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(PreferencesDefinition.protocol).toBe('https://identity.foundation/protocols/preferences');
    });

    it('should be a private (not published) protocol', () => {
      expect(PreferencesDefinition.published).toBe(false);
    });

    it('should define theme, locale, privacy, and notification types', () => {
      expect(PreferencesDefinition.types.theme).toBeDefined();
      expect(PreferencesDefinition.types.locale).toBeDefined();
      expect(PreferencesDefinition.types.privacy).toBeDefined();
      expect(PreferencesDefinition.types.notification).toBeDefined();
    });

    it('should require encryption for privacy type', () => {
      expect(PreferencesDefinition.types.privacy.encryptionRequired).toBe(true);
    });

    it('should enforce $recordLimit on theme, locale, and privacy singletons', () => {
      expect(PreferencesDefinition.structure.theme.$recordLimit).toEqual({ max: 1 });
      expect(PreferencesDefinition.structure.locale.$recordLimit).toEqual({ max: 1 });
      expect(PreferencesDefinition.structure.privacy.$recordLimit).toEqual({ max: 1 });
    });

    it('should require channel tag on notification records', () => {
      expect(PreferencesDefinition.structure.notification.$tags?.$requiredTags).toContain('channel');
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(PreferencesProtocol.definition).toBe(PreferencesDefinition);
      expect(Object.keys(PreferencesProtocol.codecs).sort()).toEqual(['locale', 'notification', 'privacy', 'theme']);
    });
  });

  describe('ConnectProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ConnectDefinition.protocol).toBe('https://identity.foundation/protocols/connect');
    });

    it('should be a published protocol', () => {
      expect(ConnectDefinition.published).toBe(true);
    });

    it('should define wallet type', () => {
      expect(ConnectDefinition.types.wallet).toBeDefined();
    });

    it('should enforce $recordLimit on wallet singleton', () => {
      expect(ConnectDefinition.structure.wallet.$recordLimit).toEqual({ max: 1 });
    });

    it('should allow anyone to read wallet records', () => {
      const actions = ConnectDefinition.structure.wallet.$actions;
      expect(actions).toBeDefined();
      const anyoneAction = actions!.find((a) => a.who === 'anyone');
      expect(anyoneAction).toBeDefined();
      expect(anyoneAction!.can).toContain('read');
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(ConnectProtocol.definition).toBe(ConnectDefinition);
      expect(Object.keys(ConnectProtocol.codecs)).toEqual(['wallet']);
    });
  });
});
