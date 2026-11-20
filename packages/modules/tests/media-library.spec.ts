import type { RecordCodec } from '@enbox/api';

import { createEnboxTestContext } from '@enbox/api/testing';
import { defineApplicationManifest } from '@enbox/api';
import { describe, expect, it } from 'bun:test';

import { MediaLibraryCodecs, MediaLibraryModule } from '../src/media-library.js';

describe('one personal media library', () => {
  it('distinguishes saved works and series and validates their specialized metadata', async () => {
    const work = MediaLibraryCodecs.work as RecordCodec<unknown>;
    const series = MediaLibraryCodecs.series as RecordCodec<unknown>;
    const episode = MediaLibraryCodecs.episode as RecordCodec<unknown>;
    for (const data of [
      { '@type': 'Book', name: 'A book', bookEdition: 'Revised', intent: 'queued' },
      { '@type': 'Movie', name: 'A film', durationSeconds: 7200 },
      { '@type': 'MusicAlbum', name: 'An album', datePublished: '2020' },
      { '@type': 'MusicRecording', name: 'A recording', album: { recordId: 'album' } },
      { '@type': 'VideoGame', name: 'A game', gamePlatform: ['Switch'] },
    ]) {
      expect(JSON.parse(await (await work.encode(data)).data.text())).toEqual(data);
    }
    for (const data of [
      { '@type': 'Movie', name: 'Film', isbn: '9780000000000' },
      { '@type': 'Book', name: 'Book', gamePlatform: ['Switch'] },
      { '@type': 'TVEpisode', name: 'Episode as an independent title' },
      { '@type': 'VideoGame', name: 'Game', datePublished: '2021-02-29' },
    ]) {
      expect(() => work.encode(data)).toThrow();
    }
    expect(() => series.encode({ '@type': 'TVSeries', name: 'Show', feedUrl: 'https://example.org/feed' })).toThrow();
    expect(() => episode.encode({ '@type': 'TVEpisode', name: 'Episode', guid: 'podcast-only' })).toThrow();
  });

  it('preserves distinct progress units and review scales', () => {
    const activity = MediaLibraryCodecs.activity as RecordCodec<unknown>;
    const observation = { kind: 'progress', mode: 'read', recordedAt: '2026-01-15T12:00:00Z' };
    for (const position of [
      { unit: 'page', value: 0 },
      { unit: 'seconds', value: -1 },
      { unit: 'percent', value: 101 },
      { unit: 'chapter', value: 2 },
      { unit: 'page', value: '80' },
    ]) {
      expect(() => activity.encode({ ...observation, position })).toThrow();
    }
    expect(() => activity.encode(observation)).toThrow();
    expect(() => MediaLibraryCodecs.annotation.encode({ kind: 'review', rating: { value: 6, scale: 5 } })).toThrow();
    expect(() => MediaLibraryCodecs.annotation.encode({ kind: 'highlight', body: 'No underlying quote' })).toThrow();
  });

  it('binds episode identity and playback to the selected series even when two feeds reuse the same GUID', async () => {
    const context = await createEnboxTestContext({ application: defineApplicationManifest({ modules: [MediaLibraryModule] }) });
    try {
      const records = context.enbox.using(MediaLibraryModule).records;
      for (const name of ['North', 'South']) {
        const series = await records.create('series', { data: { '@type': 'PodcastSeries', name, feedUrl: 'https://example.org/' + name } });
        const episode = await records.create('series/episode', {
          parentContextId : series.contextId,
          data            : {
            '@type' : 'PodcastEpisode',
            name    : 'Pilot',
            guid    : 'episode-1',
            intent  : 'queued',
          },
        });
        expect((await records.query('series/episode/activity', { within: episode.contextId })).records).toHaveLength(0);
        const progress = await records.create('series/episode/activity', {
          parentContextId : episode.contextId,
          data            : {
            kind       : 'progress',
            mode       : 'listen',
            recordedAt : '2026-01-15T12:00:00Z',
            position   : { unit: 'seconds', value: 425 },
          },
        });
        expect((await progress.value()).position).toEqual({ unit: 'seconds', value: 425 });
        const siblings = await records.query('series/episode', { within: series.contextId });
        expect(siblings.records.map((entry) => entry.id)).toEqual([episode.id]);
      }
    } finally {
      await context.close();
    }
  }, 30_000);
});
