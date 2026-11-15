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
    ['#/timers', { view: 'timers' }],
    ['#/timers/t-1', { view: 'timers', sub: 't-1' }],
    ['#/memory', { view: 'memory' }],
    ['#/memory/notes/family.md', { view: 'memory', sub: 'notes/family.md' }],
    ['#/memory/notes%2Ffamily.md', { view: 'memory', sub: 'notes/family.md' }],
  ])('%s', (hash, loc) => {
    expect(parseHash(hash)).toEqual(loc);
  });

  it('行って戻すと同じ場所になる', () => {
    for (const loc of [
      {},
      { sub: 'e:7220588b' },
      { sub: 'new' },
      { sub: 's/with/slash' },
      { view: 'timers' as const },
      { view: 'timers' as const, sub: 'new' },
      { view: 'memory' as const, sub: 'tasks/index.md' },
    ]) {
      expect(parseHash(toHash(loc))).toEqual(loc);
    }
  });

  it('一覧は #/、メモリのパスは / のまま', () => {
    expect(toHash({})).toBe('#/');
    expect(toHash({ view: 'memory', sub: 'notes/family.md' })).toBe('#/memory/notes/family.md');
  });
});
