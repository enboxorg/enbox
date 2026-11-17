import type { CalendarInterchange, ContactInterchange, JCard } from '../src/interchange.js';

import { ContactsModule } from '../src/contacts.js';
import { createEnboxTestContext } from '@enbox/api/testing';
import { defineApplicationManifest } from '@enbox/api';
import { EventsModule } from '../src/events.js';
import { describe, expect, it } from 'bun:test';
import { exportJCal, exportJCard, importJCal, importJCard } from '../src/interchange.js';

const card = [
  'vcard',
  [
    ['version', {}, 'text', '4.0'],
    ['fn', {}, 'text', 'Alex Rivera'],
    ['uid', {}, 'uri', 'urn:uuid:469bb670-b576-4692-bcce-e47989fb7b5e'],
    ['n', {}, 'text', ['Rivera', ['Alex', 'Jo'], '', '', '']],
    ['org', {}, 'text', 'Example Studio'],
    ['bday', {}, 'date-and-or-time', '1992-08-09'],
    ['note', {}, 'text', 'Met at book club.'],
    ['email', { type: 'work', pref: '1' }, 'text', 'alex@example.org'],
    ['email', { type: 'home' }, 'text', 'alex@example.net'],
    ['tel', { type: 'cell' }, 'uri', 'tel:+1-202-555-0143'],
    ['url', {}, 'uri', 'https://example.org/alex'],
  ],
];

const calendarMetadata = [
  ['version', {}, 'text', '2.0'],
  ['prodid', {}, 'text', '-//Example//Planner//EN'],
  ['calscale', {}, 'text', 'GREGORIAN'],
];

function event(properties: unknown[], components: unknown[] = []): unknown[] {
  return [
    'vevent',
    [
      ['uid', {}, 'text', 'trip@example.org'],
      ['summary', {}, 'text', 'Weekend trip'],
      ['dtstamp', {}, 'date-time', '2026-11-17T08:15:00Z'],
      ...properties,
    ],
    components,
  ];
}

describe('JSON interchange profiles', () => {
  it('maps a jCard to a root and distinct endpoints, retaining the external UID and preferred address on export', async () => {
    const result = await importJCard(card);
    expect(result).toEqual({
      uid     : 'urn:uuid:469bb670-b576-4692-bcce-e47989fb7b5e',
      contact : {
        displayName  : 'Alex Rivera',
        familyName   : 'Rivera',
        vcardUid     : 'urn:uuid:469bb670-b576-4692-bcce-e47989fb7b5e',
        givenNames   : ['Alex', 'Jo'],
        organization : 'Example Studio',
        birthday     : '1992-08-09',
        notes        : 'Met at book club.',
      },
      endpoints: [
        { kind: 'email', label: 'work', value: 'alex@example.org', preferred: true },
        { kind: 'email', label: 'home', value: 'alex@example.net' },
        { kind: 'phone', label: 'cell', value: 'tel:+1-202-555-0143' },
        { kind: 'website', value: 'https://example.org/alex' },
      ],
    });
    const exported = await exportJCard(result);
    expect(exported[1]).toContainEqual(['tel', { type: 'cell' }, 'uri', 'tel:+1-202-555-0143']);
    expect(await importJCard(exported)).toEqual(result);
  });

  it('accepts minimal and single-given-name contacts and textual telephone numbers', async () => {
    const minimal: JCard = [
      'vcard',
      [
        ['version', {}, 'text', '4.0'],
        ['fn', {}, 'text', 'Sam'],
      ],
    ];
    expect(await exportJCard(await importJCard(minimal))).toEqual(minimal);
    const input: ContactInterchange = {
      contact   : { displayName: 'Jo', givenNames: ['Jo'] },
      endpoints : [{ kind: 'phone', value: '555-0143' }],
    };
    expect(await importJCard(await exportJCard(input))).toEqual(input);
    const familyOnly: ContactInterchange = { contact: { displayName: 'Rivera', familyName: 'Rivera' }, endpoints: [] };
    expect(await importJCard(await exportJCard(familyOnly))).toEqual(familyOnly);
  });

  it('rejects unsupported fields, invalid contacts and preferences whose ranking would be lost', async () => {
    for (const extra of [
      ['email', { pref: '2' }, 'text', 'sam@example.org'],
      ['email', {}, 'text', 'invalid'],
      ['org', {}, 'text', ['Employer', 'Division']],
      ['tel', { type: ['work', 'voice'] }, 'uri', 'tel:+1234'],
      ['tel', {}, 'uri', 'https://example.org'],
      ['tel', {}, 'uri', 'not a URI'],
      ['email', { type: 'label,home' }, 'text', 'sam@example.org'],
      ['adr', {}, 'text', []],
      ['fn', { language: 'fr' }, 'text', 'Sam'],
      ['bday', {}, 'date', '--04-12'],
      ['uid', {}, 'uri', 'invalid'],
      ['n', {}, 'text', ['Family', 'First', '', 'Dr.', '']],
      ['n', {}, 'text', ['Family', 2, '', '', '']],
      ['url', {}, 'uri', ''],
      ['org', [], 'text', 'X'],
      ['org', {}, 'text', 'X', 'Y'],
    ]) {
      await expect(importJCard(['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Sam'], extra]])).rejects.toThrow();
    }
    await expect(exportJCard({ contact: { displayName: 'Jo', pronouns: 'they' }, endpoints: [] })).rejects.toThrow('pronouns');
    await expect(exportJCard({ contact: { displayName: 'Jo' }, endpoints: [{ kind: 'messaging', value: '@jo' }] })).rejects.toThrow(
      'messaging',
    );
    for (const value of [null, ['vcard', {}], ['vcard', [['version', {}, 'text', '3.0']]], ['vcard', [['version', {}, 'text', '4.0']]]]) {
      await expect(importJCard(value)).rejects.toThrow();
    }
  });

  it('round-trips distinct UTC and all-day events with exclusive end dates and persistent UIDs', async () => {
    const first = event([
      ['dtstart', {}, 'date', '2026-11-20'],
      ['dtend', {}, 'date', '2026-11-23'],
    ]);
    const second = [
      'vevent',
      [
        ['uid', {}, 'text', 'dentist@example.org'],
        ['summary', {}, 'text', 'Dental cleaning'],
        ['dtstamp', {}, 'date-time', '2026-11-17T08:16:00Z'],
        ['dtstart', {}, 'date-time', '2026-11-24T09:00:00Z'],
        ['dtend', {}, 'date-time', '2026-11-24T09:45:00Z'],
        ['location', {}, 'text', 'Park Street'],
        ['description', {}, 'text', 'Routine appointment'],
      ],
      [],
    ];
    const result = await importJCal(['vcalendar', calendarMetadata, [first, second]]);
    expect(result.events[0]).toEqual({
      uid     : 'trip@example.org',
      dtstamp : '2026-11-17T08:15:00Z',
      event   : {
        title           : 'Weekend trip',
        calendarUid     : 'trip@example.org',
        calendarDtstamp : '2026-11-17T08:15:00Z',
        startsOn        : '2026-11-20',
        endsOn          : '2026-11-23',
      },
    });
    expect(result.events[1].event.startsAt).toBe('2026-11-24T09:00:00Z');
    const exported = await exportJCal(result);
    expect(exported[2][0][1]).toContainEqual(['dtend', {}, 'date', '2026-11-23']);
    expect(await importJCal(exported)).toEqual(result);
  });

  it('exports fresh DWN reads with their original source identity and matches the next event import', async () => {
    const context = await createEnboxTestContext({ application: defineApplicationManifest({ modules: [ContactsModule, EventsModule] }) });
    try {
      const contacts = context.enbox.using(ContactsModule).records;
      const imported = await importJCard(card);
      const contact = await contacts.create('contact', { data: imported.contact });
      for (const data of imported.endpoints) {
        await contacts.create('contact/endpoint', { parentContextId: contact.contextId, data });
      }
      const restored = await (await contacts.read('contact', contact.id))!.value();
      const children = await contacts.query('contact/endpoint', { within: contact.contextId! });
      const endpoints = await Promise.all(children.records.map((child) => child.value()));
      const exported = await exportJCard({ contact: restored, endpoints });
      const reimported = await importJCard(exported);
      expect(reimported.contact.vcardUid).toBe(imported.uid!);
      expect(reimported.endpoints).toHaveLength(4);
      await expect(exportJCard({ contact: restored, endpoints, uid: 'urn:uuid:other' })).rejects.toThrow('conflicting');

      const records = context.enbox.using(EventsModule).records;
      const initial = await importJCal(['vcalendar', calendarMetadata, [event([['dtstart', {}, 'date', '2026-11-20']])]]);
      const saved = await records.create('event', { data: initial.events[0].event });
      const loaded = await (await records.read('event', saved.id))!.value();
      const serialized = await exportJCal({ productId: initial.productId, events: [{ event: loaded }] });
      expect((await importJCal(serialized)).events).toEqual(initial.events);

      const change = await importJCal(['vcalendar', calendarMetadata, [event([['dtstart', {}, 'date', '2026-11-25']])]]);
      const candidates = await records.query('event');
      const matches = [];
      for (const candidate of candidates.records) {
        if ((await candidate.value()).calendarUid === change.events[0].uid) {
          matches.push(candidate);
        }
      }
      expect(matches.map((match) => match.id)).toEqual([saved.id]);
      await matches[0].update({ data: change.events[0].event });
      const updated = await (await records.read('event', saved.id))!.value();
      expect(updated.startsOn).toBe('2026-11-25');
      await expect(
        exportJCal({ productId: initial.productId, events: [{ event: updated, dtstamp: '2026-12-01T12:00:00Z' }] }),
      ).rejects.toThrow('conflicting');
      await expect(
        exportJCal({ productId: initial.productId, events: [{ event: { title: 'New event', startsOn: '2026-11-20' } }] }),
      ).rejects.toThrow('requires UID and DTSTAMP');
    } finally {
      await context.close();
    }
  }, 30_000);

  it('rejects never-occurring dates, altered temporal semantics and unsupported nested components', async () => {
    const utc = ['dtstart', {}, 'date-time', '2026-11-20T10:00:00Z'];
    for (const component of [
      event([['dtstart', {}, 'date', '2026-02-30']]),
      event([['dtstart', {}, 'date-time', '2026-02-30T09:00:00Z']]),
      event([['dtstart', {}, 'date-time', '2026-11-20T10:00:00']]),
      event([['dtstart', { tzid: 'Europe/Paris' }, 'date-time', '2026-11-20T10:00:00']]),
      event([utc, ['dtend', {}, 'date', '2026-11-21']]),
      event([utc, ['dtend', {}, 'date-time', '2026-11-20T09:59:00Z']]),
      event([utc], [['valarm', [], []]]),
      event([utc, ['rrule', {}, 'recur', { freq: 'DAILY' }]]),
      ['vtodo', [], []],
      event([
        ['dtstart', {}, 'date', '2026-01-01'],
        ['dtend', {}, 'date', '2026-01-01'],
      ]),
      event([]),
      [
        'vevent',
        [
          ['uid', {}, 'text', ''],
          ['summary', {}, 'text', 'Sam'],
        ],
        [],
      ],
      [
        'vevent',
        [
          ['uid', {}, 'text', 'u'],
          ['summary', {}, 'text', 'Sam'],
        ],
        [],
      ],
    ]) {
      await expect(importJCal(['vcalendar', calendarMetadata, [component]])).rejects.toThrow();
    }
    await expect(importJCal(['vcalendar', calendarMetadata, [event([utc]), event([utc])]])).rejects.toThrow('repeated');
    for (const metadata of [[['version', {}, 'text', '1.0']], [...calendarMetadata, ['method', {}, 'text', 'REQUEST']]]) {
      await expect(importJCal(['vcalendar', metadata, [event([utc])]])).rejects.toThrow();
    }
    await expect(importJCal({})).rejects.toThrow();
    const input: CalendarInterchange = {
      productId : 'Example',
      events    : [
        {
          uid     : 'u',
          dtstamp : '2026-11-17T08:16:00Z',
          event   : { title: 'Weekly meeting', startsOn: '2026-11-20', recurrence: { frequency: 'weekly' } },
        },
      ],
    };
    await expect(exportJCal(input)).rejects.toThrow('recurrence');
  });
});
