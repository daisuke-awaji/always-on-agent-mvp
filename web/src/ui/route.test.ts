import { describe, expect, it } from 'vitest';
import { parseHash, toHash } from './route';

describe('parseHash / toHash', () => {
  it.each([
    ['', {}],
    ['#/', {}],
    ['#/chat', {}],
    ['#/chat/', {}],
    ['#/chat/s-1', { sub: 's-1' }],
    ['#/chat/e%3Aabc', { sub: 'e:abc' }],
    // 前にあった画面のリンクは一覧を開く
    ['#/inbox/m-1', {}],
    ['#/console', {}],
    ['#/unknown/x', {}],
  ])('%s', (hash, loc) => {
    expect(parseHash(hash)).toEqual(loc);
  });

  it('行って戻すと同じ場所になる', () => {
    for (const loc of [{}, { sub: 'e:7220588b' }, { sub: 'new' }, { sub: 's/with/slash' }]) {
      expect(parseHash(toHash(loc))).toEqual(loc);
    }
  });

  it('一覧は #/', () => {
    expect(toHash({})).toBe('#/');
  });
});
