import type { PlaceData } from '../places.js';

import { PlacesCodecs } from '../places.js';

/** RFC 7946 Point Feature carrying the selected place metadata in properties. */
export type PlaceFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] | [number, number, number] };
  properties: Omit<PlaceData, 'coordinates'>;
};

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected an object at ${path}.`);
  }
  return value as Record<string, unknown>;
}

function allowKeys(object: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(object).find((key): boolean => !allowed.includes(key));
  if (unknown !== undefined) { throw new TypeError(`Unsupported GeoJSON member at ${path}/${unknown}.`); }
}

/** Import a named Point feature. Extra feature identifiers, bounding boxes and foreign members require an explicit mapping. */
export async function importPlaceFeature(value: unknown): Promise<PlaceData> {
  const feature = objectAt(value, 'feature');
  allowKeys(feature, ['type', 'geometry', 'properties'], 'feature');
  const point = objectAt(feature.geometry, 'geometry');
  allowKeys(point, ['type', 'coordinates'], 'geometry');
  if (feature.type !== 'Feature' || point.type !== 'Point') { throw new TypeError('Expected a GeoJSON Point Feature.'); }
  const position = point.coordinates;
  if (!Array.isArray(position) || (position.length !== 2 && position.length !== 3) || !position.every(Number.isFinite)) {
    throw new TypeError('Expected [longitude, latitude] with optional altitude in meters.');
  }
  const properties = objectAt(feature.properties, 'properties');
  if (Object.hasOwn(properties, 'coordinates')) { throw new TypeError('Conflicting coordinates in Feature.properties.'); }
  const [longitude, latitude, altitudeMeters] = position;
  const data = { ...properties, coordinates: { longitude, latitude, ...(position.length === 3 ? { altitudeMeters } : {}) } } as PlaceData;
  await PlacesCodecs.place.encode(data);
  return data;
}

/** Export a point in longitude/latitude order while retaining the supplied place fields. */
export async function exportPlaceFeature(place: PlaceData): Promise<PlaceFeature> {
  await PlacesCodecs.place.encode(place);
  const { coordinates, ...properties } = place;
  if (!coordinates) { throw new TypeError('A point feature requires observed coordinates.'); }
  const { latitude, longitude, altitudeMeters } = coordinates;
  return {
    type     : 'Feature', properties,
    geometry : { type: 'Point', coordinates: altitudeMeters === undefined ? [longitude, latitude] : [longitude, latitude, altitudeMeters] },
  };
}
