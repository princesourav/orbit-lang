/**
 * Open stdlib: pure filters with zero platform coupling.
 *
 * Discipline (W-04): no regex anywhere — every implementation is a linear
 * char/element walk; every produced value passes through the per-value caps
 * (`capString` / `capList`) supplied by the interpreter, so intermediate
 * blowups trip a render error before they allocate unbounded memory.
 *
 * Platform-bound filters (money/img/jsonld helpers) are NOT here — hosts
 * register those through `HostFilterDecl` (see host.ts).
 */
import { type Expr } from './ast';
import { type Diagnostic, type Span } from './diagnostics';
import { frozenMap, isForbiddenKey } from './escape';
import { t, type Type, typeToString, unwrapOptional } from './types';

// ---------------------------------------------------------------------------
// Interfaces shared with checker + interpreter
// ---------------------------------------------------------------------------

export interface LocaleData {
  months: readonly string[];
  monthsShort: readonly string[];
}

export const DEFAULT_LOCALE: LocaleData = {
  months: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/** Capability surface the interpreter hands to filter implementations. */
export interface FilterRuntime {
  fail(code: string, message: string): never;
  /** Enforces LIMITS.maxStringLength; returns the value for chaining. */
  capString(s: string): string;
  /** Enforces LIMITS.maxListItems; returns the value for chaining. */
  capList<T>(l: readonly T[]): readonly T[];
  locale: LocaleData;
}

export interface FilterArg {
  expr: Expr;
  type: Type;
}

export interface FilterCheckCtx {
  args: readonly FilterArg[];
  span: Span;
  template: string;
  report(d: Diagnostic): void;
}

export interface StdlibFilter {
  name: string;
  check(ctx: FilterCheckCtx): Type;
  eval(args: readonly unknown[], rt: FilterRuntime): unknown;
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function err(ctx: FilterCheckCtx, code: string, message: string, suggestion?: string): Type {
  ctx.report({ code, severity: 'error', message, suggestion, template: ctx.template, span: ctx.span });
  return t.invalid();
}

function arity(ctx: FilterCheckCtx, name: string, min: number, max: number): boolean {
  if (ctx.args.length < min || ctx.args.length > max) {
    err(
      ctx,
      'O2100',
      `${name} takes ${min === max ? String(min) : `${min}–${max}`} argument${max === 1 ? '' : 's'}, got ${ctx.args.length}`,
    );
    return false;
  }
  return true;
}

function isStringish(type: Type): boolean {
  return type.kind === 'string' || type.kind === 'union' || type.kind === 'invalid';
}

function isNumeric(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'float' || type.kind === 'invalid';
}

function wantString(ctx: FilterCheckCtx, name: string, i: number): boolean {
  const arg = ctx.args[i];
  if (arg === undefined) return false;
  if (isStringish(arg.type)) return true;
  err(ctx, 'O2101', `${name}: argument ${i + 1} must be a String, found ${typeToString(arg.type)}`);
  return false;
}

function wantNumber(ctx: FilterCheckCtx, name: string, i: number): boolean {
  const arg = ctx.args[i];
  if (arg === undefined) return false;
  if (isNumeric(arg.type)) return true;
  err(ctx, 'O2101', `${name}: argument ${i + 1} must be Int or Float, found ${typeToString(arg.type)}`);
  return false;
}

function wantList(ctx: FilterCheckCtx, name: string): Type | undefined {
  const arg = ctx.args[0];
  if (arg === undefined) return undefined;
  const type = unwrapOptional(arg.type);
  if (type.kind === 'invalid') return t.invalid();
  if (type.kind === 'list') return type.element;
  err(ctx, 'O2101', `${name}: argument 1 must be a List, found ${typeToString(arg.type)}`);
  return undefined;
}

/** sortBy/where keys must be string LITERALS — preserves static analyzability. */
function literalKey(ctx: FilterCheckCtx, name: string, i: number): string | undefined {
  const arg = ctx.args[i];
  if (arg === undefined) return undefined;
  if (arg.expr.kind === 'string') return arg.expr.value;
  err(ctx, 'O2102', `${name}: the key must be a string literal`, `write ${name}("fieldName", …)`);
  return undefined;
}

function fieldOf(element: Type, key: string): Type | undefined {
  if (element.kind === 'record') return element.fields[key];
  return undefined;
}

// ---------------------------------------------------------------------------
// Eval helpers (defensive: the AST is checked, but unsafe_loadTrustedAst
// misuse must fail loudly, not corrupt output)
// ---------------------------------------------------------------------------

function asString(v: unknown, rt: FilterRuntime, filter: string): string {
  if (typeof v === 'string') return v;
  rt.fail('O4020', `${filter}: expected a string value`);
}

function asNumber(v: unknown, rt: FilterRuntime, filter: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  rt.fail('O4020', `${filter}: expected a number value`);
}

function asList(v: unknown, rt: FilterRuntime, filter: string): readonly unknown[] {
  if (Array.isArray(v)) return v;
  rt.fail('O4020', `${filter}: expected a list value`);
}

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------

const filters: StdlibFilter[] = [
  {
    name: 'upper',
    check(ctx) {
      if (!arity(ctx, 'upper', 1, 1) || !wantString(ctx, 'upper', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      return rt.capString(asString(args[0], rt, 'upper').toUpperCase());
    },
  },
  {
    name: 'lower',
    check(ctx) {
      if (!arity(ctx, 'lower', 1, 1) || !wantString(ctx, 'lower', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      return rt.capString(asString(args[0], rt, 'lower').toLowerCase());
    },
  },
  {
    name: 'capitalize',
    check(ctx) {
      if (!arity(ctx, 'capitalize', 1, 1) || !wantString(ctx, 'capitalize', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      const s = asString(args[0], rt, 'capitalize');
      if (s === '') return s;
      return rt.capString((s[0] ?? '').toUpperCase() + s.slice(1));
    },
  },
  {
    name: 'trim',
    check(ctx) {
      if (!arity(ctx, 'trim', 1, 1) || !wantString(ctx, 'trim', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      return asString(args[0], rt, 'trim').trim();
    },
  },
  {
    name: 'truncate',
    check(ctx) {
      if (!arity(ctx, 'truncate', 2, 3)) return t.invalid();
      if (!wantString(ctx, 'truncate', 0) || !wantNumber(ctx, 'truncate', 1)) return t.invalid();
      if (ctx.args.length === 3 && !wantString(ctx, 'truncate', 2)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      const s = asString(args[0], rt, 'truncate');
      const n = Math.max(0, Math.trunc(asNumber(args[1], rt, 'truncate')));
      const ellipsis = args.length > 2 ? asString(args[2], rt, 'truncate') : '…';
      if (s.length <= n) return s;
      const keep = Math.max(0, n - ellipsis.length);
      return rt.capString(s.slice(0, keep) + ellipsis);
    },
  },
  {
    name: 'replace',
    check(ctx) {
      if (!arity(ctx, 'replace', 3, 3)) return t.invalid();
      if (!wantString(ctx, 'replace', 0) || !wantString(ctx, 'replace', 1) || !wantString(ctx, 'replace', 2)) {
        return t.invalid();
      }
      return t.string();
    },
    eval(args, rt) {
      const s = asString(args[0], rt, 'replace');
      const from = asString(args[1], rt, 'replace');
      const to = asString(args[2], rt, 'replace');
      if (from === '') return s;
      // Literal linear scan; output is cap-checked as it grows (W-04a/b).
      let out = '';
      let i = 0;
      for (;;) {
        const hit = s.indexOf(from, i);
        if (hit === -1) {
          out += s.slice(i);
          break;
        }
        out += s.slice(i, hit) + to;
        i = hit + from.length;
        rt.capString(out);
      }
      return rt.capString(out);
    },
  },
  {
    name: 'split',
    check(ctx) {
      if (!arity(ctx, 'split', 2, 2)) return t.invalid();
      if (!wantString(ctx, 'split', 0) || !wantString(ctx, 'split', 1)) return t.invalid();
      return t.list(t.string());
    },
    eval(args, rt) {
      const s = asString(args[0], rt, 'split');
      const sep = asString(args[1], rt, 'split');
      const out: string[] = [];
      if (sep === '') {
        for (let i = 0; i < s.length; i += 1) {
          out.push(s[i] ?? '');
          rt.capList(out);
        }
        return out;
      }
      let i = 0;
      for (;;) {
        const hit = s.indexOf(sep, i);
        if (hit === -1) {
          out.push(s.slice(i));
          break;
        }
        out.push(s.slice(i, hit));
        i = hit + sep.length;
        rt.capList(out);
      }
      return rt.capList(out);
    },
  },
  {
    name: 'slugify',
    check(ctx) {
      if (!arity(ctx, 'slugify', 1, 1) || !wantString(ctx, 'slugify', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      const s = asString(args[0], rt, 'slugify').toLowerCase();
      let out = '';
      let dash = true; // suppress leading dashes
      for (let i = 0; i < s.length; i += 1) {
        const c = s[i] ?? '';
        const alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (alnum) {
          out += c;
          dash = false;
        } else if (!dash) {
          out += '-';
          dash = true;
        }
      }
      while (out.endsWith('-')) out = out.slice(0, -1);
      return rt.capString(out);
    },
  },
  {
    name: 'urlEncode',
    check(ctx) {
      if (!arity(ctx, 'urlEncode', 1, 1) || !wantString(ctx, 'urlEncode', 0)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      return rt.capString(encodeURIComponent(asString(args[0], rt, 'urlEncode')));
    },
  },
  {
    name: 'join',
    check(ctx) {
      if (!arity(ctx, 'join', 2, 2)) return t.invalid();
      const element = wantList(ctx, 'join');
      if (element === undefined || !wantString(ctx, 'join', 1)) return t.invalid();
      const el = unwrapOptional(element);
      const ok =
        el.kind === 'string' || el.kind === 'int' || el.kind === 'float' || el.kind === 'bool' || el.kind === 'union' || el.kind === 'invalid';
      if (!ok) return err(ctx, 'O2101', `join: list elements must be printable primitives, found ${typeToString(element)}`);
      return t.string();
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'join');
      const sep = asString(args[1], rt, 'join');
      let out = '';
      for (let i = 0; i < list.length; i += 1) {
        const v = list[i];
        if (i > 0) out += sep;
        if (typeof v === 'string') out += v;
        else if (typeof v === 'number') out += String(v);
        else if (typeof v === 'boolean') out += v ? 'true' : 'false';
        else rt.fail('O4020', 'join: list contains a non-printable value');
        rt.capString(out);
      }
      return out;
    },
  },
  {
    name: 'size',
    check(ctx) {
      if (!arity(ctx, 'size', 1, 1)) return t.invalid();
      const arg = ctx.args[0];
      if (arg === undefined) return t.invalid();
      const type = unwrapOptional(arg.type);
      if (type.kind === 'list' || isStringish(type)) return t.int();
      return err(ctx, 'O2101', `size: argument must be a List or String, found ${typeToString(arg.type)}`);
    },
    eval(args, rt) {
      const v = args[0];
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      rt.fail('O4020', 'size: expected a list or string value');
    },
  },
  {
    name: 'first',
    check(ctx) {
      if (!arity(ctx, 'first', 1, 1)) return t.invalid();
      const element = wantList(ctx, 'first');
      if (element === undefined) return t.invalid();
      return t.optional(element);
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'first');
      return list.length > 0 ? list[0] : null;
    },
  },
  {
    name: 'last',
    check(ctx) {
      if (!arity(ctx, 'last', 1, 1)) return t.invalid();
      const element = wantList(ctx, 'last');
      if (element === undefined) return t.invalid();
      return t.optional(element);
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'last');
      return list.length > 0 ? list[list.length - 1] : null;
    },
  },
  {
    name: 'reverse',
    check(ctx) {
      if (!arity(ctx, 'reverse', 1, 1)) return t.invalid();
      const element = wantList(ctx, 'reverse');
      if (element === undefined) return t.invalid();
      return t.list(element);
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'reverse');
      const out: unknown[] = [];
      for (let i = list.length - 1; i >= 0; i -= 1) out.push(list[i]);
      return rt.capList(out);
    },
  },
  {
    name: 'sortBy',
    check(ctx) {
      if (!arity(ctx, 'sortBy', 2, 2)) return t.invalid();
      const element = wantList(ctx, 'sortBy');
      const key = literalKey(ctx, 'sortBy', 1);
      if (element === undefined || key === undefined) return t.invalid();
      if (element.kind === 'invalid') return t.invalid();
      const field = fieldOf(element, key) ?? objectField(ctx, element, key);
      if (field === undefined) {
        return err(ctx, 'O2103', `sortBy: ${typeToString(element)} has no field ${JSON.stringify(key)}`);
      }
      const f = unwrapOptional(field);
      if (f.kind !== 'string' && f.kind !== 'int' && f.kind !== 'float' && f.kind !== 'invalid' && f.kind !== 'union') {
        return err(ctx, 'O2103', `sortBy: field ${JSON.stringify(key)} is not sortable (${typeToString(field)})`);
      }
      return t.list(element);
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'sortBy');
      const key = asString(args[1], rt, 'sortBy');
      const indexed = list.map((v, i) => ({ v, i }));
      indexed.sort((a, b) => {
        const av = fieldValue(a.v, key);
        const bv = fieldValue(b.v, key);
        const cmp = compareValues(av, bv);
        return cmp !== 0 ? cmp : a.i - b.i; // stable
      });
      return rt.capList(indexed.map((e) => e.v));
    },
  },
  {
    name: 'where',
    check(ctx) {
      if (!arity(ctx, 'where', 3, 3)) return t.invalid();
      const element = wantList(ctx, 'where');
      const key = literalKey(ctx, 'where', 1);
      if (element === undefined || key === undefined) return t.invalid();
      if (element.kind === 'invalid') return t.invalid();
      const field = fieldOf(element, key) ?? objectField(ctx, element, key);
      if (field === undefined) {
        return err(ctx, 'O2103', `where: ${typeToString(element)} has no field ${JSON.stringify(key)}`);
      }
      return t.list(element);
    },
    eval(args, rt) {
      const list = asList(args[0], rt, 'where');
      const key = asString(args[1], rt, 'where');
      const wanted = args[2];
      const out: unknown[] = [];
      for (const v of list) {
        if (fieldValue(v, key) === wanted) out.push(v);
      }
      return rt.capList(out);
    },
  },
  {
    name: 'round',
    check(ctx) {
      if (!arity(ctx, 'round', 1, 2)) return t.invalid();
      if (!wantNumber(ctx, 'round', 0)) return t.invalid();
      if (ctx.args.length === 2) {
        const dp = ctx.args[1];
        if (dp === undefined || dp.expr.kind !== 'int' || dp.expr.value < 0 || dp.expr.value > 6) {
          return err(ctx, 'O2102', 'round: decimal places must be a literal 0–6');
        }
        return dp.expr.value === 0 ? t.int() : t.float();
      }
      return t.int();
    },
    eval(args, rt) {
      const x = asNumber(args[0], rt, 'round');
      const dp = args.length > 1 ? Math.trunc(asNumber(args[1], rt, 'round')) : 0;
      const factor = 10 ** dp;
      return Math.round(x * factor) / factor;
    },
  },
  {
    name: 'clamp',
    check(ctx) {
      if (!arity(ctx, 'clamp', 3, 3)) return t.invalid();
      if (!wantNumber(ctx, 'clamp', 0) || !wantNumber(ctx, 'clamp', 1) || !wantNumber(ctx, 'clamp', 2)) {
        return t.invalid();
      }
      const allInt = ctx.args.every((a) => a.type.kind === 'int' || a.type.kind === 'invalid');
      return allInt ? t.int() : t.float();
    },
    eval(args, rt) {
      const x = asNumber(args[0], rt, 'clamp');
      const min = asNumber(args[1], rt, 'clamp');
      const max = asNumber(args[2], rt, 'clamp');
      return Math.min(max, Math.max(min, x));
    },
  },
  {
    name: 'formatDate',
    check(ctx) {
      if (!arity(ctx, 'formatDate', 2, 2)) return t.invalid();
      if (!wantString(ctx, 'formatDate', 0) || !wantString(ctx, 'formatDate', 1)) return t.invalid();
      return t.string();
    },
    eval(args, rt) {
      const iso = asString(args[0], rt, 'formatDate');
      const pattern = asString(args[1], rt, 'formatDate');
      const d = parseIsoDate(iso);
      if (d === undefined) {
        return rt.fail('O4021', `formatDate: not an ISO date: ${JSON.stringify(iso.slice(0, 40))}`);
      }
      return rt.capString(formatDatePattern(d, pattern, rt.locale));
    },
  },
];

function objectField(_ctx: FilterCheckCtx, element: Type, _key: string): Type | undefined {
  // Nominal host objects need the registry to resolve fields; the checker
  // pre-flattens object element types to records before filter checks, so a
  // remaining 'object' here means the checker chose not to expose fields.
  void element;
  return undefined;
}

/**
 * `sortBy`/`where` keys are string literals from the AST, but the OBJECT is
 * host data — so the lookup is still key-on-untrusted-shape. Reserved keys are
 * refused and inherited members are invisible: `sortBy(list, "constructor")`
 * sorts by `null`, it does not reach `Object`.
 */
function fieldValue(v: unknown, key: string): unknown {
  if (isForbiddenKey(key)) return null;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (!Object.hasOwn(v, key)) return null;
    return (v as Record<string, unknown>)[key] ?? null;
  }
  return null;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

interface IsoDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

/** Linear ISO-8601 parse: YYYY-MM-DD, optionally Thh:mm(:ss). No Date object. */
export function parseIsoDate(s: string): IsoDate | undefined {
  const digits = (from: number, len: number): number | undefined => {
    let v = 0;
    for (let i = from; i < from + len; i += 1) {
      const c = s[i];
      if (c === undefined || c < '0' || c > '9') return undefined;
      v = v * 10 + (c.charCodeAt(0) - 48);
    }
    return v;
  };
  const year = digits(0, 4);
  if (year === undefined || s[4] !== '-') return undefined;
  const month = digits(5, 2);
  if (month === undefined || month < 1 || month > 12 || s[7] !== '-') return undefined;
  const day = digits(8, 2);
  if (day === undefined || day < 1 || day > 31) return undefined;
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (s.length > 10) {
    if (s[10] !== 'T' && s[10] !== ' ') return undefined;
    const h = digits(11, 2);
    const m = s[13] === ':' ? digits(14, 2) : undefined;
    if (h === undefined || m === undefined || h > 23 || m > 59) return undefined;
    hour = h;
    minute = m;
    if (s[16] === ':') {
      const sec = digits(17, 2);
      if (sec === undefined || sec > 59) return undefined;
      second = sec;
    }
  }
  return { year, month, day, hour, minute, second };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDatePattern(d: IsoDate, pattern: string, locale: LocaleData): string {
  let out = '';
  let i = 0;
  const tokens: [string, () => string][] = [
    ['YYYY', () => String(d.year)],
    ['MMMM', () => locale.months[d.month - 1] ?? String(d.month)],
    ['MMM', () => locale.monthsShort[d.month - 1] ?? String(d.month)],
    ['MM', () => pad2(d.month)],
    ['DD', () => pad2(d.day)],
    ['HH', () => pad2(d.hour)],
    ['mm', () => pad2(d.minute)],
    ['ss', () => pad2(d.second)],
    ['M', () => String(d.month)],
    ['D', () => String(d.day)],
  ];
  outer: while (i < pattern.length) {
    for (const [tok, fn] of tokens) {
      if (pattern.startsWith(tok, i)) {
        out += fn();
        i += tok.length;
        continue outer;
      }
    }
    out += pattern[i] ?? '';
    i += 1;
  }
  return out;
}

/**
 * The stdlib registry is a FROZEN, null-prototype map view (see `frozenMap`):
 * it cannot be extended at runtime, and a user-controlled filter name can
 * never resolve to an inherited member — `STDLIB.get('__proto__')` is
 * `undefined`. Each filter object is frozen too, so a rogue import cannot
 * swap an `eval` out from under the interpreter.
 */
export const STDLIB: ReadonlyMap<string, StdlibFilter> = frozenMap(
  filters.map((f) => [f.name, Object.freeze(f)] as const),
);

export const STDLIB_FILTER_NAMES: readonly string[] = Object.freeze([...STDLIB.keys()]);
