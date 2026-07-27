import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits';
import { DEFAULT_LOCALE, STDLIB, STDLIB_FILTER_NAMES, type FilterRuntime } from './stdlib';

const rt: FilterRuntime = {
  fail: (code, message) => {
    throw new Error(`${code}: ${message}`);
  },
  capString: (s) => {
    if (s.length > LIMITS.maxStringLength) throw new Error('O4005: string cap');
    return s;
  },
  capList: (l) => {
    if (l.length > LIMITS.maxListItems) throw new Error('O4006: list cap');
    return l;
  },
  locale: DEFAULT_LOCALE,
};

function run(name: string, ...args: unknown[]): unknown {
  const filter = STDLIB.get(name);
  if (filter === undefined) throw new Error(`no filter ${name}`);
  return filter.eval(args, rt);
}

describe('stdlib shape', () => {
  it('ships the documented pure filters and nothing platform-bound', () => {
    expect([...STDLIB_FILTER_NAMES].sort()).toEqual([
      'capitalize',
      'clamp',
      'first',
      'formatDate',
      'join',
      'last',
      'lower',
      'replace',
      'reverse',
      'round',
      'size',
      'slugify',
      'sortBy',
      'split',
      'trim',
      'truncate',
      'upper',
      'urlEncode',
      'where',
    ]);
    expect(STDLIB.has('money')).toBe(false);
    expect(STDLIB.has('img')).toBe(false);
  });
});

describe('string filters', () => {
  it('upper/lower/capitalize/trim', () => {
    expect(run('upper', 'ab')).toBe('AB');
    expect(run('lower', 'AB')).toBe('ab');
    expect(run('capitalize', 'hello world')).toBe('Hello world');
    expect(run('capitalize', '')).toBe('');
    expect(run('trim', '  x  ')).toBe('x');
  });

  it('truncate counts the ellipsis inside n', () => {
    expect(run('truncate', 'abcdefgh', 5)).toBe('abcd…');
    expect(run('truncate', 'abc', 5)).toBe('abc');
    expect(run('truncate', 'abcdefgh', 6, '--')).toBe('abcd--');
  });

  it('replace is literal (no patterns) and linear', () => {
    expect(run('replace', 'a.b.c', '.', '-')).toBe('a-b-c');
    expect(run('replace', 'aaa', 'a', 'aa')).toBe('aaaaaa');
    expect(run('replace', 'x', '', 'y')).toBe('x'); // empty needle is a no-op, never an infinite loop
  });

  it('slugify is a linear char walk', () => {
    expect(run('slugify', '  Löwe & Co — "Runner" 2.0! ')).toBe('l-we-co-runner-2-0');
    expect(run('slugify', '---')).toBe('');
  });

  it('urlEncode', () => {
    expect(run('urlEncode', 'a b&c')).toBe('a%20b%26c');
  });
});

describe('list filters', () => {
  it('split/join/size/first/last/reverse', () => {
    expect(run('split', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(run('split', 'abc', '')).toEqual(['a', 'b', 'c']);
    expect(run('join', ['a', 'b'], '-')).toBe('a-b');
    expect(run('join', [1, true], ',')).toBe('1,true');
    expect(run('size', [1, 2, 3])).toBe(3);
    expect(run('size', 'abcd')).toBe(4);
    expect(run('first', [1, 2])).toBe(1);
    expect(run('first', [])).toBe(null);
    expect(run('last', [1, 2])).toBe(2);
    expect(run('reverse', [1, 2, 3])).toEqual([3, 2, 1]);
  });

  it('sortBy is stable, nulls last; where filters by equality', () => {
    const items = [
      { name: 'b', rank: 2 },
      { name: 'a', rank: 1 },
      { name: 'c', rank: 2 },
      { name: 'd' },
    ];
    expect((run('sortBy', items, 'rank') as { name: string }[]).map((x) => x.name)).toEqual(['a', 'b', 'c', 'd']);
    expect((run('where', items, 'rank', 2) as { name: string }[]).map((x) => x.name)).toEqual(['b', 'c']);
  });
});

describe('number filters', () => {
  it('round and clamp', () => {
    expect(run('round', 2.5)).toBe(3);
    expect(run('round', 2.375, 2)).toBe(2.38);
    expect(run('clamp', 10, 0, 5)).toBe(5);
    expect(run('clamp', -1, 0, 5)).toBe(0);
  });
});

describe('formatDate (host-injected locale, no Date object)', () => {
  it('formats ISO dates and datetimes', () => {
    expect(run('formatDate', '2026-07-27', 'DD MMM YYYY')).toBe('27 Jul 2026');
    expect(run('formatDate', '2026-01-05T09:07:03', 'MMMM D, YYYY HH:mm:ss')).toBe('January 5, 2026 09:07:03');
  });

  it('uses injected month names', () => {
    const hindi: FilterRuntime = { ...rt, locale: { months: DEFAULT_LOCALE.months, monthsShort: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'] } };
    expect(STDLIB.get('formatDate')?.eval(['2026-07-27', 'MMM'], hindi)).toBe('J');
  });

  it('fails loudly on non-ISO input', () => {
    expect(() => run('formatDate', '27/07/2026', 'DD')).toThrowError(/O4021/);
  });
});

describe('per-value caps trip at every intermediate step (W-04)', () => {
  it('replace amplification trips the string cap before allocating unbounded output', () => {
    const s = 'a'.repeat(1_000);
    const to = 'b'.repeat(1_000);
    expect(() => run('replace', s, 'a', to)).toThrowError(/O4005/);
  });

  it('split cardinality trips the list cap', () => {
    const s = 'a,'.repeat(LIMITS.maxListItems + 10);
    expect(() => run('split', s, ',')).toThrowError(/O4006/);
  });

  it('join output trips the string cap', () => {
    const list = Array.from({ length: 3_000 }, () => 'x'.repeat(100));
    expect(() => run('join', list, ',')).toThrowError(/O4005/);
  });
});

describe('no regex anywhere (W-04c)', () => {
  it('stdlib implementations contain no RegExp usage', () => {
    for (const filter of STDLIB.values()) {
      const src = filter.eval.toString();
      expect(src.includes('RegExp'), `${filter.name} uses RegExp`).toBe(false);
      expect(src.includes('.match('), `${filter.name} uses .match`).toBe(false);
    }
  });
});
