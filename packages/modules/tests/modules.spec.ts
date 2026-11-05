import { describe, expect, it } from 'bun:test';

import {
  ConnectDefinition,
  ConnectModule,
  PreferencesDefinition,
  PreferencesModule,
  ProfileDefinition,
  ProfileModule,
} from '../src/index.js';

describe('@enbox/modules', () => {
  describe('ProfileModule', () => {
    it('should have the correct module URI', () => {
      expect(ProfileDefinition.module).toBe('https://identity.foundation/modules/profile');
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

    it('should bind the definition and codecs via defineModule()', () => {
      expect(ProfileModule.definition).toBe(ProfileDefinition);
      expect(Object.keys(ProfileModule.codecs).sort()).toEqual(['avatar', 'hero', 'link', 'profile']);
    });
  });

  describe('PreferencesModule', () => {
    it('should have the correct module URI', () => {
      expect(PreferencesDefinition.module).toBe('https://identity.foundation/modules/preferences');
    });

    it('should be a private (not published) module', () => {
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

    it('should bind the definition and codecs via defineModule()', () => {
      expect(PreferencesModule.definition).toBe(PreferencesDefinition);
      expect(Object.keys(PreferencesModule.codecs).sort()).toEqual(['locale', 'notification', 'privacy', 'theme']);
    });
  });

  describe('ConnectModule', () => {
    it('should have the correct module URI', () => {
      expect(ConnectDefinition.module).toBe('https://identity.foundation/modules/connect');
    });

    it('should be a published module', () => {
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

    it('should bind the definition and codecs via defineModule()', () => {
      expect(ConnectModule.definition).toBe(ConnectDefinition);
      expect(Object.keys(ConnectModule.codecs)).toEqual(['wallet']);
    });
  });
});
