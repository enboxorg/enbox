import type { InterchangeProperty } from './properties.js';
import type { ContactData, EndpointData } from '../contacts.js';

import { ContactsCodecs } from '../contacts.js';
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

export type JCard = ['vcard', InterchangeProperty[]];

/** Endpoint payloads belong beneath the contact record. Keep the external UID for repeat imports. */
export type ContactInterchange = { contact: ContactData; endpoints: EndpointData[]; uid?: string };

const endpoints = { email: 'email', tel: 'phone', url: 'website' } as const;
const addressTypes = { email: 'email', phone: 'tel', website: 'url' } as const;

function endpointFor(property: InterchangeProperty, name: keyof typeof endpoints): EndpointData {
  const params = property[1];
  onlyKeys(params, ['type', 'pref']);
  if (params.type !== undefined && !/^[A-Za-z0-9-]+$/.test(params.type)) {
    unsupported('expected one endpoint type token');
  }
  if (params.pref !== undefined && params.pref !== '1') {
    unsupported('only a first-preference endpoint can map to preferred');
  }
  const asUri = name === 'url' || (name === 'tel' && property[2] === 'uri');
  const value = stringValue(property, asUri ? 'uri' : 'text');
  if (asUri && (!URL.canParse(value) || /\s/.test(value))) {
    unsupported('invalid endpoint URI');
  }
  if (name === 'tel' && asUri && !/^tel:/i.test(value)) {
    unsupported('expected a tel URI');
  }
  return {
    kind: endpoints[name],
    value,
    ...(params.type === undefined ? {} : { label: params.type }),
    ...(params.pref === undefined ? {} : { preferred: true }),
  };
}

function structuredName(property: InterchangeProperty): Pick<ContactData, 'familyName' | 'givenNames'> {
  const parts = property[3];
  if (
    property[2] !== 'text' ||
    !Array.isArray(parts) ||
    parts.length !== 5 ||
    typeof parts[0] !== 'string' ||
    parts.slice(2).some((part): boolean => part !== '')
  ) {
    unsupported('expected a family/given structured name');
  }
  const given = typeof parts[1] === 'string' ? [parts[1]] : parts[1];
  if (!Array.isArray(given) || !given.every((part): boolean => typeof part === 'string')) {
    unsupported('invalid given names');
  }
  return {
    ...(parts[0] ? { familyName: parts[0] } : {}),
    ...(given.length === 0 || (given.length === 1 && given[0] === '')
      ? {}
      : { givenNames: [...given] as ContactData['givenNames'] & string[] }),
  };
}

/** Decode a single vCard 4.0 jCard into Contacts root and child payloads (RFC 7095). */
export async function importJCard(value: unknown): Promise<ContactInterchange> {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 'vcard') {
    unsupported('expected one jCard');
  }
  const props = propertyList(value[1]);
  if (props[0]?.[0] !== 'version' || requiredText(props, 'version') !== '4.0') {
    unsupported('expected version 4.0 first');
  }
  uniqueProperties(props, Object.keys(endpoints));
  const result: ContactInterchange = { contact: { displayName: requiredText(props, 'fn') }, endpoints: [] };
  for (const property of props) {
    const [name, params] = property;
    if (Object.hasOwn(endpoints, name)) {
      const endpoint = endpointFor(property, name as keyof typeof endpoints);
      await ContactsCodecs.endpoint.encode(endpoint);
      result.endpoints.push(endpoint);
      continue;
    }
    onlyKeys(params, []);
    switch (name) {
      case 'version':
      case 'fn':
        break;
      case 'uid': {
        const uid = stringValue(property, 'uri');
        if (!URL.canParse(uid) || /\s/.test(uid)) {
          unsupported('invalid contact UID URI');
        }
        result.uid = uid;
        result.contact.vcardUid = uid;
        break;
      }
      case 'n':
        Object.assign(result.contact, structuredName(property));
        break;
      case 'org':
        result.contact.organization = stringValue(property, 'text');
        break;
      case 'bday': {
        result.contact.birthday = stringValue(property, property[2] === 'date-and-or-time' ? property[2] : 'date');
        break;
      }
      case 'note':
        result.contact.notes = stringValue(property, 'text');
        break;
      default:
        unsupported(`unsupported jCard property '${name}'`);
    }
  }
  await ContactsCodecs.contact.encode(result.contact);
  return result;
}

/** Encode the supported contact fields and selected child endpoints as one jCard. */
export async function exportJCard({ contact, endpoints: children, uid: suppliedUid }: ContactInterchange): Promise<JCard> {
  onlyKeys(contact, ['displayName', 'familyName', 'givenNames', 'organization', 'birthday', 'notes', 'vcardUid']);
  const uid = externalField('UID', contact.vcardUid, suppliedUid);
  await ContactsCodecs.contact.encode(contact);
  const props = [textProperty('version', '4.0'), textProperty('fn', contact.displayName)];
  if (uid !== undefined) {
    props.push(['uid', {}, 'uri', uid]);
  }
  if (contact.familyName !== undefined || contact.givenNames !== undefined) {
    const given = contact.givenNames ?? [];
    props.push(['n', {}, 'text', [contact.familyName ?? '', given.length <= 1 ? (given[0] ?? '') : given, '', '', '']]);
  }
  if (contact.organization !== undefined) {
    props.push(textProperty('org', contact.organization));
  }
  if (contact.birthday !== undefined) {
    props.push(['bday', {}, 'date', contact.birthday]);
  }
  if (contact.notes !== undefined) {
    props.push(textProperty('note', contact.notes));
  }
  for (const child of children) {
    onlyKeys(child, ['kind', 'value', 'label', 'preferred']);
    await ContactsCodecs.endpoint.encode(child);
    if (!Object.hasOwn(addressTypes, child.kind)) {
      unsupported(`endpoint kind '${child.kind}'`);
    }
    const name = addressTypes[child.kind as keyof typeof addressTypes];
    const type = name === 'url' || (name === 'tel' && /^tel:/i.test(child.value)) ? 'uri' : 'text';
    const params: Record<string, string> = {};
    if (child.preferred) {
      params.pref = '1';
    }
    if (child.label !== undefined) {
      params.type = child.label;
    }
    props.push([name, params, type, child.value]);
  }
  const card: JCard = ['vcard', props];
  await importJCard(card);
  return card;
}
