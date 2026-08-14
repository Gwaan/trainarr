import { describe, expect, it } from 'vitest';

import { toLthrSuggestionView } from './lthr-suggestion';

const BLOCKS = {
  bpm: 172,
  source: 'threshold-blocks',
  sessionCount: 4,
  timeTrialBpm: null,
  profileBpm: null,
} as const;

describe('toLthrSuggestionView', () => {
  it('ne rend rien quand il n’y a rien à proposer', () => {
    expect(toLthrSuggestionView(null)).toBeNull();
  });

  it('annonce une première adoption plutôt qu’un écart de zéro', () => {
    expect(toLthrSuggestionView(BLOCKS)).toEqual({
      bpm: 172,
      source: 'threshold-blocks',
      sessionCount: 4,
      timeTrialBpm: null,
      profileBpm: null,
      direction: 'first',
      deltaBpm: 0,
    });
  });

  it('dit le sens de l’écart : un seuil monte avec la forme, et redescend', () => {
    expect(toLthrSuggestionView({ ...BLOCKS, profileBpm: 166 })).toMatchObject({
      direction: 'up',
      deltaBpm: 6,
    });
    expect(toLthrSuggestionView({ ...BLOCKS, profileBpm: 178 })).toMatchObject({
      direction: 'down',
      deltaBpm: 6,
    });
  });

  it('transporte la seconde mesure — la carte cite les deux sources', () => {
    expect(toLthrSuggestionView({ ...BLOCKS, timeTrialBpm: 175 })).toMatchObject({
      source: 'threshold-blocks',
      timeTrialBpm: 175,
    });
  });
});
