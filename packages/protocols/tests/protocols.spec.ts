import { describe, expect, it } from 'bun:test';

import {
  ConnectDefinition,
  ConnectProtocol,
  ListsDefinition,
  ListsProtocol,
  PreferencesDefinition,
  PreferencesProtocol,
  ProfileDefinition,
  ProfileProtocol,
  SocialGraphDefinition,
  SocialGraphProtocol,
  StatusDefinition,
  StatusProtocol,
} from '../src/index.js';

describe('@enbox/protocols', () => {

  describe('SocialGraphProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(SocialGraphDefinition.protocol).toBe('https://identity.foundation/protocols/social-graph');
    });

    it('should be a published protocol', () => {
      expect(SocialGraphDefinition.published).toBe(true);
    });

    it('should define friend, block, group, and member types', () => {
      expect(SocialGraphDefinition.types.friend).toBeDefined();
      expect(SocialGraphDefinition.types.block).toBeDefined();
      expect(SocialGraphDefinition.types.group).toBeDefined();
      expect(SocialGraphDefinition.types.member).toBeDefined();
    });

    it('should mark friend as a role', () => {
      expect(SocialGraphDefinition.structure.friend.$role).toBe(true);
    });

    it('should require did tag on friend records', () => {
      expect(SocialGraphDefinition.structure.friend.$tags?.$requiredTags).toContain('did');
    });

    it('should have a nested group/member structure', () => {
      expect(SocialGraphDefinition.structure.group.member).toBeDefined();
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(SocialGraphProtocol.definition).toBe(SocialGraphDefinition);
      expect(Object.keys(SocialGraphProtocol.codecs).sort()).toEqual(['block', 'friend', 'group', 'member']);
    });
  });

  describe('ProfileProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ProfileDefinition.protocol).toBe('https://identity.foundation/protocols/profile');
    });

    it('should compose with Social Graph via uses', () => {
      expect(ProfileDefinition.uses).toBeDefined();
      expect(ProfileDefinition.uses!.social).toBe('https://identity.foundation/protocols/social-graph');
    });

    it('should define profile, avatar, hero, link, and privateNote types', () => {
      expect(ProfileDefinition.types.profile).toBeDefined();
      expect(ProfileDefinition.types.avatar).toBeDefined();
      expect(ProfileDefinition.types.hero).toBeDefined();
      expect(ProfileDefinition.types.link).toBeDefined();
      expect(ProfileDefinition.types.privateNote).toBeDefined();
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

    it('should use cross-protocol friend role for privateNote', () => {
      const actions = ProfileDefinition.structure.privateNote.$actions;
      expect(actions).toBeDefined();
      const friendAction = actions!.find((a) => a.role === 'social:friend');
      expect(friendAction).toBeDefined();
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(ProfileProtocol.definition).toBe(ProfileDefinition);
      expect(Object.keys(ProfileProtocol.codecs).sort()).toEqual(['avatar', 'hero', 'link', 'privateNote', 'profile']);
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

  describe('StatusProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(StatusDefinition.protocol).toBe('https://identity.foundation/protocols/status');
    });

    it('should compose with Social Graph via uses', () => {
      expect(StatusDefinition.uses).toBeDefined();
      expect(StatusDefinition.uses!.social).toBe('https://identity.foundation/protocols/social-graph');
    });

    it('should define status and reaction types', () => {
      expect(StatusDefinition.types.status).toBeDefined();
      expect(StatusDefinition.types.reaction).toBeDefined();
    });

    it('should enforce size limit on status records', () => {
      expect(StatusDefinition.structure.status.$size?.max).toBe(5000);
    });

    it('should nest reaction under status', () => {
      expect(StatusDefinition.structure.status.reaction).toBeDefined();
    });

    it('should use friend role for reactions', () => {
      const reactionActions = StatusDefinition.structure.status.reaction.$actions;
      expect(reactionActions).toBeDefined();
      const friendAction = reactionActions!.find((a) => a.role === 'social:friend');
      expect(friendAction).toBeDefined();
      expect(friendAction!.can).toContain('create');
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(StatusProtocol.definition).toBe(StatusDefinition);
      expect(Object.keys(StatusProtocol.codecs).sort()).toEqual(['reaction', 'status']);
    });
  });

  describe('ListsProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ListsDefinition.protocol).toBe('https://identity.foundation/protocols/lists');
    });

    it('should compose with Social Graph via uses', () => {
      expect(ListsDefinition.uses).toBeDefined();
      expect(ListsDefinition.uses!.social).toBe('https://identity.foundation/protocols/social-graph');
    });

    it('should define list, item, folder, collaborator, and comment types', () => {
      expect(ListsDefinition.types.list).toBeDefined();
      expect(ListsDefinition.types.item).toBeDefined();
      expect(ListsDefinition.types.folder).toBeDefined();
      expect(ListsDefinition.types.collaborator).toBeDefined();
      expect(ListsDefinition.types.comment).toBeDefined();
    });

    it('should use listType enum tag on list records', () => {
      const tags = ListsDefinition.structure.list.$tags;
      expect(tags).toBeDefined();
      expect(tags!.$requiredTags).toContain('listType');
      expect((tags!.listType as { enum: string[] }).enum).toEqual(['todo', 'bookmarks', 'reading', 'custom']);
    });

    it('should nest item and collaborator under list', () => {
      expect(ListsDefinition.structure.list.item).toBeDefined();
      expect(ListsDefinition.structure.list.collaborator).toBeDefined();
    });

    it('should mark collaborator as a role', () => {
      expect(ListsDefinition.structure.list.collaborator.$role).toBe(true);
    });

    it('should nest comment under item', () => {
      expect(ListsDefinition.structure.list.item.comment).toBeDefined();
    });

    it('should support 3-level nested folders', () => {
      expect(ListsDefinition.structure.folder).toBeDefined();
      expect(ListsDefinition.structure.folder.folder).toBeDefined();
      expect(ListsDefinition.structure.folder.folder.folder).toBeDefined();
    });

    it('should use collaborator role for item write access', () => {
      const itemActions = ListsDefinition.structure.list.item.$actions;
      expect(itemActions).toBeDefined();
      const collabAction = itemActions!.find((a) => a.role === 'list/collaborator');
      expect(collabAction).toBeDefined();
      expect(collabAction!.can).toContain('create');
    });

    it('should bind the definition and codecs via defineProtocol()', () => {
      expect(ListsProtocol.definition).toBe(ListsDefinition);
      expect(Object.keys(ListsProtocol.codecs).sort()).toEqual(['collaborator', 'comment', 'folder', 'item', 'list']);
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
