/** A jCard or jCal property from the supported interchange profile. */
export type InterchangeProperty = [name: string, parameters: Record<string, string>, type: string, value: unknown];

export function unsupported(message: string): never {
  throw new TypeError(`Unsupported interchange document: ${message}`);
}

export function onlyKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key): boolean => !allowed.includes(key));
  if (extra !== undefined) {
    unsupported(`cannot represent '${extra}'`);
  }
}

export function propertyList(value: unknown): InterchangeProperty[] {
  if (!Array.isArray(value)) {
    unsupported('expected an array of properties');
  }
  return value.map((item): InterchangeProperty => {
    if (!Array.isArray(item) || item.length !== 4) {
      unsupported('expected a single-valued property tuple');
    }
    const [name, params, type, data] = item;
    if (typeof name !== 'string' || typeof type !== 'string' || params === null || typeof params !== 'object' || Array.isArray(params)) {
      unsupported('malformed property tuple');
    }
    if (!Object.values(params).every((entry): boolean => typeof entry === 'string')) {
      unsupported(`multi-valued parameter on '${name}'`);
    }
    return [name, { ...params }, type, data];
  });
}

export function uniqueProperties(properties: InterchangeProperty[], repeated: readonly string[] = []): void {
  const seen = new Set<string>();
  for (const [name] of properties) {
    if (seen.has(name) && !repeated.includes(name)) {
      unsupported(`repeated '${name}'`);
    }
    seen.add(name);
  }
}

export function stringValue(property: InterchangeProperty, expectedType: string): string {
  if (property[2] !== expectedType || typeof property[3] !== 'string') {
    unsupported(`'${property[0]}' requires a '${expectedType}' string`);
  }
  return property[3];
}

export function requiredText(properties: InterchangeProperty[], name: string): string {
  const property = properties.find(([key]): boolean => key === name);
  if (property === undefined) {
    unsupported(`missing '${name}'`);
  }
  const value = stringValue(property, 'text');
  if (value.length === 0) {
    unsupported(`empty '${name}'`);
  }
  return value;
}

export function textProperty(name: string, value: string): InterchangeProperty {
  return [name, {}, 'text', value];
}

/** Resolve external identity metadata from the persisted record or an explicit export binding. */
export function externalField(name: string, stored: string | undefined, supplied: string | undefined): string | undefined {
  if (stored !== undefined && supplied !== undefined && stored !== supplied) {
    unsupported(`conflicting stored and supplied ${name}`);
  }
  return stored ?? supplied;
}
