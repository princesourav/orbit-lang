/**
 * Type-system-lite model. Primitives, List<T>, structural records, optionals
 * (T?), string-literal unions, and HOST-BRANDED opaque types.
 *
 * The engine knows five branded names and enforces their terminality rules
 * itself (never trusting the host): Money (no operators, no textual form),
 * MoneyText (renders, admits no filters), Url (sink-side scheme allowlist),
 * Image (only host filters may consume it), Html (element-content only —
 * and NOT host-declarable at all, per W-34).
 */

export type Type =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'string' }
  | { kind: 'bool' }
  | { kind: 'color' }
  | { kind: 'none' }
  | { kind: 'invalid' } // poison type: silences cascading diagnostics
  | { kind: 'optional'; inner: Type }
  | { kind: 'list'; element: Type }
  | { kind: 'record'; fields: Record<string, Type> }
  | { kind: 'union'; values: string[] } // string-literal union
  | { kind: 'range' }
  | { kind: 'object'; name: string } // nominal host object; fields live in the registry
  | { kind: 'opaque'; name: string } // Money, MoneyText, Url, Image, host opaques
  | { kind: 'html' }; // engine-owned terminal type

export const t = {
  int: (): Type => ({ kind: 'int' }),
  float: (): Type => ({ kind: 'float' }),
  string: (): Type => ({ kind: 'string' }),
  bool: (): Type => ({ kind: 'bool' }),
  color: (): Type => ({ kind: 'color' }),
  none: (): Type => ({ kind: 'none' }),
  invalid: (): Type => ({ kind: 'invalid' }),
  optional: (inner: Type): Type => (inner.kind === 'optional' ? inner : { kind: 'optional', inner }),
  list: (element: Type): Type => ({ kind: 'list', element }),
  record: (fields: Record<string, Type>): Type => ({ kind: 'record', fields }),
  union: (...values: string[]): Type => ({ kind: 'union', values }),
  range: (): Type => ({ kind: 'range' }),
  object: (name: string): Type => ({ kind: 'object', name }),
  opaque: (name: string): Type => ({ kind: 'opaque', name }),
  money: (): Type => ({ kind: 'opaque', name: 'Money' }),
  moneyText: (): Type => ({ kind: 'opaque', name: 'MoneyText' }),
  url: (): Type => ({ kind: 'opaque', name: 'Url' }),
  image: (): Type => ({ kind: 'opaque', name: 'Image' }),
  html: (): Type => ({ kind: 'html' }),
} as const;

export const BRANDED_OPAQUE_NAMES: readonly string[] = ['Money', 'MoneyText', 'Url', 'Image'];

export function isOpaqueNamed(type: Type, name: string): boolean {
  return type.kind === 'opaque' && type.name === name;
}

export function unwrapOptional(type: Type): Type {
  return type.kind === 'optional' ? type.inner : type;
}

export function typeToString(type: Type): string {
  switch (type.kind) {
    case 'int':
      return 'Int';
    case 'float':
      return 'Float';
    case 'string':
      return 'String';
    case 'bool':
      return 'Bool';
    case 'color':
      return 'Color';
    case 'none':
      return 'None';
    case 'invalid':
      return '<invalid>';
    case 'optional':
      return `${typeToString(type.inner)}?`;
    case 'list':
      return `List<${typeToString(type.element)}>`;
    case 'record': {
      const fields = Object.entries(type.fields)
        .map(([k, v]) => `${k}: ${typeToString(v)}`)
        .join(', ');
      return `{${fields}}`;
    }
    case 'union':
      return type.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'range':
      return 'Range';
    case 'object':
      return type.name;
    case 'opaque':
      return type.name;
    case 'html':
      return 'Html';
  }
}

/** Structural/nominal assignability: `from` usable where `to` is expected. */
export function assignable(from: Type, to: Type): boolean {
  if (from.kind === 'invalid' || to.kind === 'invalid') return true;
  if (to.kind === 'optional') {
    if (from.kind === 'none') return true;
    if (from.kind === 'optional') return assignable(from.inner, to.inner);
    return assignable(from, to.inner);
  }
  if (from.kind === 'optional' || from.kind === 'none') return false;
  switch (to.kind) {
    case 'int':
      return from.kind === 'int';
    case 'float':
      return from.kind === 'float' || from.kind === 'int';
    case 'string':
      return from.kind === 'string' || from.kind === 'union';
    case 'bool':
      return from.kind === 'bool';
    case 'color':
      return from.kind === 'color';
    case 'none':
      return false;
    case 'list':
      return from.kind === 'list' && assignable(from.element, to.element);
    case 'record': {
      if (from.kind !== 'record') return false;
      for (const [key, fieldType] of Object.entries(to.fields)) {
        const fromField = from.fields[key];
        if (fromField === undefined || !assignable(fromField, fieldType)) return false;
      }
      return true;
    }
    case 'union': {
      if (from.kind === 'union') return from.values.every((v) => to.values.includes(v));
      if (from.kind === 'string') return false; // widening only, never narrowing
      return false;
    }
    case 'range':
      return from.kind === 'range';
    case 'object':
      return from.kind === 'object' && from.name === to.name;
    case 'opaque':
      return from.kind === 'opaque' && from.name === to.name;
    case 'html':
      return from.kind === 'html';
  }
}

// ---------------------------------------------------------------------------
// TypeRegistry — the bring-your-own object model
// ---------------------------------------------------------------------------

/**
 * Hosts declare their object model here (nominal object types + opaque
 * types). The engine refuses `Html` in any host position: the only Html
 * producers are host filters explicitly flagged `unsafeHtml`, which the
 * checker warns about (W-34).
 */
export class TypeRegistry {
  private readonly objects = new Map<string, Record<string, Type>>();
  private readonly opaques = new Set<string>(BRANDED_OPAQUE_NAMES);

  defineObject(name: string, fields: Record<string, Type>): this {
    if (name === 'Html') {
      throw new Error('Html is engine-owned and cannot be declared by the host (W-34)');
    }
    if (!isPascalCase(name)) {
      throw new Error(`object type names must be PascalCase (got ${JSON.stringify(name)})`);
    }
    assertNoHostHtml(fields);
    this.objects.set(name, fields);
    return this;
  }

  declareOpaque(name: string): this {
    if (name === 'Html') {
      throw new Error('Html is engine-owned and cannot be declared by the host (W-34)');
    }
    if (!isPascalCase(name)) {
      throw new Error(`opaque type names must be PascalCase (got ${JSON.stringify(name)})`);
    }
    this.opaques.add(name);
    return this;
  }

  hasObject(name: string): boolean {
    return this.objects.has(name);
  }

  hasOpaque(name: string): boolean {
    return this.opaques.has(name);
  }

  fieldsOf(name: string): Record<string, Type> | undefined {
    return this.objects.get(name);
  }

  /** Resolve a frontmatter type name to a Type, if the registry knows it. */
  resolveName(name: string): Type | undefined {
    switch (name) {
      case 'Int':
        return t.int();
      case 'Float':
        return t.float();
      case 'String':
        return t.string();
      case 'Bool':
        return t.bool();
      case 'Color':
        return t.color();
      default:
        if (this.objects.has(name)) return t.object(name);
        if (this.opaques.has(name)) return t.opaque(name);
        return undefined;
    }
  }

  typeNames(): string[] {
    return ['Int', 'Float', 'String', 'Bool', 'Color', ...this.objects.keys(), ...this.opaques];
  }
}

function isPascalCase(name: string): boolean {
  const first = name[0];
  if (first === undefined || first < 'A' || first > 'Z') return false;
  for (let i = 1; i < name.length; i += 1) {
    const c = name[i] ?? '';
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!ok) return false;
  }
  return true;
}

function assertNoHostHtml(fields: Record<string, Type>): void {
  for (const type of Object.values(fields)) {
    if (containsHtml(type)) {
      throw new Error('Html cannot appear in a host-declared object model (W-34)');
    }
  }
}

function containsHtml(type: Type): boolean {
  switch (type.kind) {
    case 'html':
      return true;
    case 'optional':
      return containsHtml(type.inner);
    case 'list':
      return containsHtml(type.element);
    case 'record':
      return Object.values(type.fields).some(containsHtml);
    default:
      return false;
  }
}
