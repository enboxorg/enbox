import { describe, expect, it } from 'bun:test';

import { exportPlaceFeature, importPlaceFeature } from '../src/interchange/geojson.js';

describe('named GeoJSON places', () => {
  it('round-trips longitude first, optional elevation and descriptive properties', async () => {
    for (const position of [[-122.4, 37.7], [151.2, -33.8, 0]]) {
      const feature = { type: 'Feature', properties: { name: 'Trailhead', labels: ['hikes'] }, geometry: { type: 'Point', coordinates: position } };
      const place = await importPlaceFeature(feature);
      expect(place.coordinates!.latitude).toBe(position[1]);
      expect(await exportPlaceFeature(place)).toMatchObject(feature);
    }
  });

  it('rejects unrepresentable metadata, invalid ranges and missing coordinates', async () => {
    const feature = { type: 'Feature', properties: { name: 'Trailhead' }, geometry: { type: 'Point', coordinates: [10, 20] } };
    for (const invalid of [
      null, { ...feature, id: 'feature-1' }, { ...feature, type: 'FeatureCollection' }, { ...feature, properties: null },
      { ...feature, properties: { name: 'A', coordinates: {} } }, { ...feature, properties: { arbitraryField: 'unknown' } },
      { ...feature, geometry: { ...feature.geometry, bbox: [] } }, { ...feature, geometry: { type: 'Polygon', coordinates: [] } },
      ...[[10, 91], [181, 10], [10], [10, 20, 30, 40], [10, Infinity], ['10', 20]].map(coordinates => ({
        ...feature, geometry: { type: 'Point', coordinates },
      })),
    ]) { await expect(importPlaceFeature(invalid)).rejects.toThrow(); }
    await expect(exportPlaceFeature({ name: 'Trailhead' })).rejects.toThrow('coordinates');
  });
});
