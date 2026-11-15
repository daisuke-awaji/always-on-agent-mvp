import { describe, expect, it } from 'vitest';
import { parseHash, toHash } from './route';

describe('parseHash / toHash', () => {
  it.each([
    ['', { route: 'overview' }],
    ['#/', { route: 'overview' }],
    ['#/chat', { route: 'chat' }],
    ['#/chat/s-1', { route: 'chat', sub: 's-1' }],
    ['#/chat/e%3Aabc', { route: 'chat', sub: 'e:abc' }],
    ['#/inbox/m-1', { route: 'inbox', sub: 'm-1' }],
    ['#/console', { route: 'console' }],
    ['#/unknown/x', { route: 'overview' }],
  ])('%s', (hash, loc) => {
    expect(parseHash(hash)).toEqual(loc);
  });

  it('行って戻すと同じ場所になる', () => {
    for (const loc of [
      { route: 'overview' as const },
      { route: 'chat' as const, sub: 'e:7220588b' },
      { route: 'inbox' as const, sub: 'm/with/slash' },
    ]) {
      expect(parseHash(toHash(loc))).toEqual(loc);
    }
  });
});
