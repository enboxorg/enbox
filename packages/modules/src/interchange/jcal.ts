import type { EventData } from '../events.js';
import type { InterchangeProperty } from './properties.js';

import { EventsCodecs } from '../events.js';
import {
  externalField,
  onlyKeys,
  propertyList,
  requiredText,
  stringValue,
  textProperty,
  uniqueProperties,
  unsupported,
} from './properties.js';

export type JCal = ['vcalendar', InterchangeProperty[], ['vevent', InterchangeProperty[], []][]];
export type EventInterchange = { uid: string; dtstamp: string; event: EventData };
export type CalendarExport = { productId: string; events: { uid?: string; dtstamp?: string; event: EventData }[] };
export type CalendarInterchange = { productId: string; events: EventInterchange[] };

function instant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    unsupported('expected a UTC date-time with whole seconds');
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString().replace('.000Z', 'Z') !== value) {
    unsupported('invalid UTC instant');
  }
  return value;
}

function readEvent(component: unknown): EventInterchange {
  if (
    !Array.isArray(component) ||
    component.length !== 3 ||
    component[0] !== 'vevent' ||
    !Array.isArray(component[2]) ||
    component[2].length !== 0
  ) {
    unsupported('expected VEVENT without subcomponents');
  }
  const props = propertyList(component[1]);
  uniqueProperties(props);
  const event: EventData = { title: requiredText(props, 'summary') };
  const uid = requiredText(props, 'uid');
  let dtstamp: string | undefined;
  for (const property of props) {
    const [name, params, type] = property;
    onlyKeys(params, []);
    switch (name) {
      case 'summary':
      case 'uid':
        break;
      case 'dtstamp':
        dtstamp = instant(stringValue(property, 'date-time'));
        break;
      case 'description':
        event.description = stringValue(property, 'text');
        break;
      case 'location':
        event.location = stringValue(property, 'text');
        break;
      case 'dtstart':
      case 'dtend': {
        const start = name === 'dtstart';
        if (type === 'date') {
          event[start ? 'startsOn' : 'endsOn'] = stringValue(property, 'date');
        } else {
          event[start ? 'startsAt' : 'endsAt'] = instant(stringValue(property, 'date-time'));
        }
        break;
      }
      default:
        unsupported(`unsupported VEVENT property '${name}'`);
    }
  }
  if (dtstamp === undefined) {
    unsupported('missing DTSTAMP');
  }
  if (
    (event.startsAt !== undefined && event.endsAt !== undefined && event.endsAt <= event.startsAt) ||
    (event.startsOn !== undefined && event.endsOn !== undefined && event.endsOn <= event.startsOn)
  ) {
    unsupported('DTEND must be strictly later than DTSTART');
  }
  event.calendarUid = uid;
  event.calendarDtstamp = dtstamp;
  return { event, uid, dtstamp };
}

/** Convert a Gregorian jCal calendar into dated Events payloads and stable external event identifiers (RFC 7265). */
export async function importJCal(value: unknown): Promise<CalendarInterchange> {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'vcalendar' || !Array.isArray(value[2]) || value[2].length === 0) {
    unsupported('expected one populated VCALENDAR');
  }
  const props = propertyList(value[1]);
  uniqueProperties(props);
  for (const prop of props) {
    onlyKeys(prop[1], []);
    if (prop[0] === 'calscale' && stringValue(prop, 'text') === 'GREGORIAN') {
      continue;
    }
    if (prop[0] !== 'version' && prop[0] !== 'prodid') {
      unsupported(`unsupported VCALENDAR property '${prop[0]}'`);
    }
  }
  if (requiredText(props, 'version') !== '2.0') {
    unsupported('expected iCalendar version 2.0');
  }
  const productId = requiredText(props, 'prodid');
  const events: EventInterchange[] = [];
  const seen = new Set<string>();
  for (const component of value[2]) {
    const entry = readEvent(component);
    if (seen.has(entry.uid)) {
      unsupported('repeated event UID');
    }
    seen.add(entry.uid);
    await EventsCodecs.event.encode(entry.event);
    events.push(entry);
  }
  return { productId, events };
}

/** Export selected Events payloads; all-day endsOn carries the exclusive DTEND date. */
export async function exportJCal({ productId, events }: CalendarExport): Promise<JCal> {
  const components: JCal[2] = [];
  for (const { event, uid: suppliedUid, dtstamp: suppliedStamp } of events) {
    onlyKeys(event, ['title', 'description', 'startsAt', 'endsAt', 'startsOn', 'endsOn', 'location', 'calendarUid', 'calendarDtstamp']);
    const uid = externalField('UID', event.calendarUid, suppliedUid);
    const dtstamp = externalField('DTSTAMP', event.calendarDtstamp, suppliedStamp);
    if (uid === undefined || dtstamp === undefined) {
      unsupported('event export requires UID and DTSTAMP');
    }
    await EventsCodecs.event.encode(event);
    const props = [textProperty('uid', uid), textProperty('summary', event.title)];
    props.push(['dtstamp', {}, 'date-time', dtstamp]);
    if (event.startsOn !== undefined) {
      props.push(['dtstart', {}, 'date', event.startsOn]);
    }
    if (event.endsOn !== undefined) {
      props.push(['dtend', {}, 'date', event.endsOn]);
    }
    if (event.startsAt !== undefined) {
      props.push(['dtstart', {}, 'date-time', event.startsAt]);
    }
    if (event.endsAt !== undefined) {
      props.push(['dtend', {}, 'date-time', event.endsAt]);
    }
    if (event.location !== undefined) {
      props.push(textProperty('location', event.location));
    }
    if (event.description !== undefined) {
      props.push(textProperty('description', event.description));
    }
    components.push(['vevent', props, []]);
  }
  const result: JCal = ['vcalendar', [textProperty('version', '2.0'), textProperty('prodid', productId)], components];
  await importJCal(result);
  return result;
}
