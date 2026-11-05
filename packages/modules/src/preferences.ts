/**
 * Preferences Module — user configuration and settings.
 *
 * Stores theme, locale, privacy, and notification preferences.
 * Fully owner-only (no external reads). The `privacy` type uses
 * `encryptionRequired` for at-rest encryption of sensitive settings.
 *
 * @module
 */

import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { defineModule, recordCodecs } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for theme preferences. */
export type ThemeData = {
  mode: 'light' | 'dark' | 'system';
  accentColor?: string;
  fontSize?: 'small' | 'medium' | 'large';
};

/** Data shape for locale preferences. */
export type LocaleData = {
  language: string;
  region?: string;
  timezone?: string;
  dateFormat?: string;
  hourCycle?: '12h' | '24h';
};

/** Data shape for privacy preferences. */
export type PrivacyData = {
  cookieConsent: {
    analytics: boolean;
    marketing: boolean;
    functional: boolean;
  };
  shareUsageData: boolean;
};

/** Data shape for notification preferences. */
export type NotificationData = {
  channel: string;
  enabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
};

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

export const PreferencesDefinition = {
  module    : 'https://identity.foundation/modules/preferences',
  published : false,
  types     : {
    theme: {
      schema      : 'https://identity.foundation/schemas/preferences/theme',
      dataFormats : ['application/json'],
    },
    locale: {
      schema      : 'https://identity.foundation/schemas/preferences/locale',
      dataFormats : ['application/json'],
    },
    privacy: {
      schema             : 'https://identity.foundation/schemas/preferences/privacy',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    notification: {
      schema      : 'https://identity.foundation/schemas/preferences/notification',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    theme: {
      $recordLimit: { max: 1 },
    },
    locale: {
      $recordLimit: { max: 1 },
    },
    privacy: {
      $recordLimit: { max: 1 },
    },
    notification: {
      $tags: {
        $requiredTags       : ['channel'],
        $allowUndefinedTags : false,
        channel             : { type: 'string' },
      },
    },
  },
} as const satisfies ModuleDefinition;

// ---------------------------------------------------------------------------
// Typed module export
// ---------------------------------------------------------------------------

/** Typed Preferences module for use with `enbox.using()`. */
export const PreferencesModule = defineModule({ definition : PreferencesDefinition, codecs     : {
  theme        : recordCodecs.json<ThemeData>(),
  locale       : recordCodecs.json<LocaleData>(),
  privacy      : recordCodecs.json<PrivacyData>(),
  notification : recordCodecs.json<NotificationData>(),
} }
);
