/**
 * Structural re-validation for STORED ASTs (W-36).
 *
 * The stored AST row is the executable: the interpreter assumes the checker
 * ran, which is exactly the "trusted bytecode" assumption behind every
 * deserialization CVE. `loadCheckedAst(data, { trust: 'verify' })` re-walks
 * the whole structure against node-kind allowlists, element/attribute
 * allowlists and caps before handing it to the interpreter — O(nodes),
 * amortized over thousands of renders.
 *
 * `unsafe_loadTrustedAst` skips that walk. The ugly name is deliberate
 * (red-team W-36c): misuse must be visible in review. Integrity/authenticity
 * (an HMAC over `(store_id, theme_version_id, ast_bytes)` minted at submit)
 * lives HOST-SIDE — the open engine has no key material and no notion of a
 * store; verify the HMAC before calling either loader. `astAuthMessage` /
 * `verifyAstTag` below give you the canonicalization and the constant-time
 * compare without the engine ever seeing a key.
 */
import {
  EXPR_KINDS,
  NODE_KINDS,
  type Attr,
  type Expr,
  type Node,
  type Program,
  type Template,
} from './ast';
import {
  attrAllowed,
  BANNED_ELEMENTS,
  ELEMENT_ALLOWLIST,
  RCDATA_ELEMENTS,
  VOID_ELEMENTS,
} from './allowlists';
import { OrbitAstError, type Diagnostic } from './diagnostics';
import { isCustomPropertyName, isForbiddenKey, isHexColorLiteral } from './escape';
import { LANGUAGE_VERSIONS, LIMITS } from './limits';

export interface SerializedProgram {
  orbit: 1;
  templates: Record<string, Template>;
}

export function serializeProgram(program: Program): SerializedProgram {
  const templates: Record<string, Template> = {};
  for (const [name, template] of program.templates) templates[name] = template;
  return { orbit: 1, templates };
}

// ---------------------------------------------------------------------------
// Validation walk
// ---------------------------------------------------------------------------

class AstValidator {
  readonly diagnostics: Diagnostic[] = [];
  private nodeCount = 0;
  private template = '<ast>';

  invalid(message: string): void {
    this.diagnostics.push({
      code: 'O5000',
      severity: 'error',
      message,
      template: this.template,
    });
  }

  validateRoot(data: unknown): void {
    if (!isRecord(data)) {
      this.invalid('stored AST is not an object');
      return;
    }
    if (data['orbit'] !== 1) {
      this.invalid('stored AST has an unknown format version (expected orbit: 1)');
      return;
    }
    const templates = data['templates'];
    if (!isRecord(templates)) {
      this.invalid('stored AST has no templates record');
      return;
    }
    const names = Object.keys(templates);
    if (names.length === 0) this.invalid('stored AST contains no templates');
    if (names.length > 500) this.invalid('stored AST contains more than 500 templates');
    for (const name of names) {
      this.template = name;
      this.nodeCount = 0;
      this.validateTemplate(name, templates[name]);
    }
  }

  private validateTemplate(name: string, data: unknown): void {
    if (!isRecord(data)) {
      this.invalid(`template ${JSON.stringify(name)} is not an object`);
      return;
    }
    if (data['kind'] !== 'template') this.invalid(`template ${JSON.stringify(name)}: kind must be "template"`);
    if (data['name'] !== name) this.invalid(`template ${JSON.stringify(name)}: name mismatch`);
    const templateKind = data['templateKind'];
    if (templateKind !== 'component' && templateKind !== 'page') {
      this.invalid(`template ${JSON.stringify(name)}: unknown templateKind`);
    }
    /*
     * A stored AST carries the language version it was checked under. An engine
     * that does not implement that version must refuse it rather than render it
     * under whatever rules it happens to have — a stored tree outlives the
     * engine that produced it, which is the entire reason this validator exists.
     */
    const languageVersion = data['languageVersion'];
    if (typeof languageVersion !== 'string' || !LANGUAGE_VERSIONS.includes(languageVersion)) {
      this.invalid(
        `template ${JSON.stringify(name)}: language version ${JSON.stringify(String(languageVersion))} is not implemented by this engine`,
      );
    }
    if (!Array.isArray(data['props']) || !Array.isArray(data['settings']) || !Array.isArray(data['slots'])) {
      this.invalid(`template ${JSON.stringify(name)}: props/settings/slots must be arrays`);
      return;
    }
    const body = data['body'];
    if (!Array.isArray(body)) {
      this.invalid(`template ${JSON.stringify(name)}: body must be an array`);
      return;
    }
    this.validateNodes(body as unknown[], 0);
  }

  private chargeNode(): boolean {
    this.nodeCount += 1;
    if (this.nodeCount > LIMITS.maxAstNodesPerTemplate) {
      this.invalid(`template exceeds ${LIMITS.maxAstNodesPerTemplate} AST nodes`);
      return false;
    }
    return true;
  }

  private validateNodes(nodes: readonly unknown[], depth: number): void {
    if (depth > LIMITS.maxElementDepth) {
      this.invalid(`node nesting exceeds depth ${LIMITS.maxElementDepth}`);
      return;
    }
    for (const raw of nodes) {
      if (!this.chargeNode()) return;
      if (!isRecord(raw) || typeof raw['kind'] !== 'string' || !NODE_KINDS.includes(raw['kind'])) {
        this.invalid('unknown or malformed node kind');
        continue;
      }
      const node = raw as unknown as Node;
      switch (node.kind) {
        case 'text':
          if (typeof node.value !== 'string' || node.value.length > LIMITS.maxStringLength) {
            this.invalid('text node value is missing or over the string cap');
          }
          break;
        case 'comment':
          /*
           * A comment renders nothing, so a malformed one cannot reach a sink —
           * but it is still a node in an executable artifact, and the rule here
           * is that every field of every node is checked. An unchecked field is
           * a field some later code path may start trusting.
           */
          if (typeof node.value !== 'string' || node.value.length > LIMITS.maxStringLength) {
            this.invalid('comment node value is missing or over the string cap');
          }
          if (typeof node.html !== 'boolean') {
            this.invalid('comment node is missing its html flag');
          }
          break;
        case 'interpolation':
          this.validateExpr(node.expr, 0);
          break;
        case 'element': {
          if (typeof node.tag !== 'string') {
            this.invalid('element node has no tag');
            break;
          }
          const banned = BANNED_ELEMENTS.get(node.tag);
          if (banned !== undefined) {
            this.invalid(`element <${node.tag}> is banned: ${banned}`);
            break;
          }
          if (!ELEMENT_ALLOWLIST.has(node.tag)) {
            this.invalid(`element <${node.tag}> is not in the allowlist`);
            break;
          }
          const expectVoid = VOID_ELEMENTS.has(node.tag);
          const expectRcdata = RCDATA_ELEMENTS.has(node.tag);
          const content = node.content;
          if (expectVoid && content !== 'void') this.invalid(`<${node.tag}> must have content "void"`);
          if (expectRcdata && content !== 'rcdata') this.invalid(`<${node.tag}> must have content "rcdata"`);
          if (!expectVoid && !expectRcdata && content !== 'normal') {
            this.invalid(`<${node.tag}> must have content "normal"`);
          }
          if (content === 'rawtext') this.invalid('rawtext content is unreachable by construction');
          if (!Array.isArray(node.attrs)) {
            this.invalid('element attrs must be an array');
            break;
          }
          if (node.attrs.length > LIMITS.maxAttrsPerElement) {
            this.invalid(`element has more than ${LIMITS.maxAttrsPerElement} attributes`);
            break;
          }
          for (const attr of node.attrs) this.validateAttr(attr, node.tag);
          if (!Array.isArray(node.children)) {
            this.invalid('element children must be an array');
            break;
          }
          if (content === 'void' && node.children.length > 0) this.invalid('void elements cannot have children');
          this.validateNodes(node.children, depth + 1);
          break;
        }
        case 'if': {
          if (!Array.isArray(node.branches) || node.branches.length === 0) {
            this.invalid('if node needs at least one branch');
            break;
          }
          for (const branch of node.branches) {
            if (!isRecord(branch) || !Array.isArray(branch.children)) {
              this.invalid('malformed if branch');
              continue;
            }
            this.validateExpr(branch.cond, 0);
            this.validateNodes(branch.children, depth + 1);
          }
          if (node.elseChildren !== undefined) {
            if (!Array.isArray(node.elseChildren)) this.invalid('elseChildren must be an array');
            else this.validateNodes(node.elseChildren, depth + 1);
          }
          break;
        }
        case 'for': {
          if (typeof node.item !== 'string') this.invalid('for node needs an item name');
          if (node.index !== undefined && typeof node.index !== 'string') this.invalid('for index must be a string');
          this.validateExpr(node.subject, 0);
          if (node.limit !== undefined) {
            this.validateExpr(node.limit, 0);
            if (node.limit.kind !== 'int' || node.limit.value < 1 || node.limit.value > LIMITS.maxLoopLimit) {
              this.invalid(`for limit must be a literal 1–${LIMITS.maxLoopLimit}`);
            }
          }
          if (!Array.isArray(node.children)) {
            this.invalid('for children must be an array');
            break;
          }
          this.validateNodes(node.children, depth + 1);
          if (node.emptyChildren !== undefined) {
            if (!Array.isArray(node.emptyChildren)) this.invalid('emptyChildren must be an array');
            else this.validateNodes(node.emptyChildren, depth + 1);
          }
          break;
        }
        case 'match': {
          this.validateExpr(node.subject, 0);
          if (!Array.isArray(node.cases) || node.cases.length === 0) {
            this.invalid('match node needs at least one case');
            break;
          }
          /*
           * The arm shapes are re-checked structurally because a stored tree did
           * not come through the parser. A `value` arm with no value, or a
           * `default` arm carrying one, would make the interpreter's lookup
           * silently select a different arm than the checker reasoned about.
           */
          for (const arm of node.cases) {
            if (arm === null || typeof arm !== 'object') {
              this.invalid('malformed match case');
              return;
            }
            const { match, value } = arm as { match?: unknown; value?: unknown };
            if (match === 'value') {
              if (typeof value !== 'string' || value.length > LIMITS.maxStringLength) {
                this.invalid('malformed match case value');
                return;
              }
            } else if (match !== 'default' || value !== undefined) {
              this.invalid('match case must be a value arm or a default arm');
              return;
            }
            if (!Array.isArray((arm as { children?: unknown }).children)) {
              this.invalid('match case children must be an array');
              return;
            }
            this.validateNodes((arm as { children: unknown[] }).children, depth + 1);
          }
          break;
        }
        case 'let':
          if (typeof node.name !== 'string' || node.name === 'settings' || isForbiddenKey(node.name)) {
            this.invalid('malformed let binding');
          }
          this.validateExpr(node.expr, 0);
          break;
        case 'component': {
          if (typeof node.name !== 'string' || !isPascal(node.name)) {
            this.invalid('component call name must be PascalCase');
            break;
          }
          // A stored tree that omitted `defer` would render the component
          // inline and drop it from the island manifest — a personalized
          // fragment quietly baked into a cacheable page.
          if (typeof node.defer !== 'boolean') this.invalid('component call needs a defer flag');
          if (!Array.isArray(node.props)) {
            this.invalid('component props must be an array');
            break;
          }
          for (const prop of node.props) this.validateAttr(prop, undefined);
          if (!Array.isArray(node.children)) {
            this.invalid('component children must be an array');
            break;
          }
          this.validateNodes(node.children, depth + 1);
          break;
        }
        case 'slot':
          if (typeof node.name !== 'string' || node.name.length > 64) this.invalid('malformed slot node');
          break;
        case 'json-ld':
          this.validateExpr(node.expr, 0);
          break;
      }
    }
  }

  private validateAttr(raw: unknown, elementTag: string | undefined): void {
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || !isRecord(raw['value'])) {
      this.invalid('malformed attribute');
      return;
    }
    const attr = raw as unknown as Attr;
    if (elementTag !== undefined && !attrAllowed(attr.name)) {
      this.invalid(`attribute ${JSON.stringify(attr.name)} on <${elementTag}> is not in the allowlist`);
      return;
    }
    const form = attr.value.form;
    if (form === 'bare') return;
    if (form === 'expr' || form === 'conditional') {
      this.validateExpr(attr.value.expr, 0);
      return;
    }
    if (form === 'parts') {
      if (!Array.isArray(attr.value.parts)) {
        this.invalid('attribute parts must be an array');
        return;
      }
      let hasExpr = false;
      for (const part of attr.value.parts) {
        if (!isRecord(part)) {
          this.invalid('malformed attribute part');
          continue;
        }
        if (part['kind'] === 'text') {
          if (typeof part['value'] !== 'string' || part['value'].length > LIMITS.maxStringLength) {
            this.invalid('attribute text part over the string cap');
          }
        } else if (part['kind'] === 'expr') {
          hasExpr = true;
          this.validateExpr((part as { expr: Expr }).expr, 0);
        } else {
          this.invalid('unknown attribute part kind');
        }
      }
      if (attr.name === 'style' && hasExpr) {
        this.invalid('interpolation in style attributes is banned (W-09)');
      }
      return;
    }
    this.invalid('unknown attribute value form');
  }

  private validateExpr(raw: unknown, depth: number): void {
    if (depth > LIMITS.maxExprDepth) {
      this.invalid(`expression nesting exceeds depth ${LIMITS.maxExprDepth}`);
      return;
    }
    if (!this.chargeNode()) return;
    if (!isRecord(raw) || typeof raw['kind'] !== 'string' || !EXPR_KINDS.includes(raw['kind'])) {
      this.invalid('unknown or malformed expression kind');
      return;
    }
    const expr = raw as unknown as Expr;
    switch (expr.kind) {
      case 'ident':
        if (typeof expr.name !== 'string' || expr.name.length > 64) this.invalid('malformed identifier');
        return;
      case 'int':
      case 'float':
        if (typeof expr.value !== 'number' || !Number.isFinite(expr.value)) this.invalid('malformed number literal');
        return;
      case 'string':
        if (typeof expr.value !== 'string' || expr.value.length > LIMITS.maxStringLength) {
          this.invalid('string literal over the cap');
        }
        return;
      case 'bool':
        if (typeof expr.value !== 'boolean') this.invalid('malformed bool literal');
        return;
      case 'none':
        return;
      case 'color':
        // All six characters must be real hex digits: `#<scrip"` is exactly
        // 7 characters and starts with '#'.
        if (typeof expr.value !== 'string' || !isHexColorLiteral(expr.value)) {
          this.invalid('malformed color literal (expected #rrggbb with hex digits)');
        }
        return;
      case 'list':
        if (!Array.isArray(expr.items)) {
          this.invalid('malformed list literal');
          return;
        }
        for (const item of expr.items) this.validateExpr(item, depth + 1);
        return;
      case 'record':
        if (!Array.isArray(expr.fields)) {
          this.invalid('malformed record literal');
          return;
        }
        for (const field of expr.fields) {
          if (!isRecord(field) || typeof field['key'] !== 'string') {
            this.invalid('malformed record field');
            continue;
          }
          if (isForbiddenKey(field['key'])) {
            this.invalid(`record field ${JSON.stringify(field['key'])} is a reserved property name`);
          }
          this.validateExpr(field.value, depth + 1);
        }
        return;
      case 'range':
        this.validateExpr(expr.start, depth + 1);
        this.validateExpr(expr.end, depth + 1);
        return;
      case 'member':
        if (typeof expr.property !== 'string' || expr.property.length > 64) this.invalid('malformed member access');
        else if (isForbiddenKey(expr.property)) {
          this.invalid(`member access to reserved property ${JSON.stringify(expr.property)} is not allowed`);
        }
        if (typeof expr.optional !== 'boolean') this.invalid('malformed member access');
        this.validateExpr(expr.object, depth + 1);
        return;
      case 'index':
        this.validateExpr(expr.object, depth + 1);
        this.validateExpr(expr.index, depth + 1);
        return;
      case 'call': {
        if (typeof expr.callee !== 'string' || expr.callee.length > 64) this.invalid('malformed call');
        if (!Array.isArray(expr.args)) {
          this.invalid('malformed call args');
          return;
        }
        /*
         * Named arguments are re-validated structurally, not just typed:
         * "no positional after a named one" is a grammar rule the parser
         * enforces, and a stored tree did not come through the parser.
         */
        let named = false;
        for (const arg of expr.args) {
          if (arg === null || typeof arg !== 'object') {
            this.invalid('malformed call argument');
            return;
          }
          const { label } = arg as { label?: unknown };
          if (label !== undefined) {
            const name = (label as { name?: unknown })?.name;
            if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
              this.invalid('malformed named argument');
              return;
            }
            named = true;
          } else if (named) {
            this.invalid('positional argument after a named one');
            return;
          }
          this.validateExpr((arg as { value: unknown }).value, depth + 1);
        }
        return;
      }
      case 'unary':
        if (expr.op !== '!' && expr.op !== '-') this.invalid('unknown unary operator');
        this.validateExpr(expr.operand, depth + 1);
        return;
      case 'binary':
        if (typeof expr.op !== 'string') this.invalid('malformed binary operator');
        this.validateExpr(expr.left, depth + 1);
        this.validateExpr(expr.right, depth + 1);
        return;
      case 'coalesce':
        this.validateExpr(expr.left, depth + 1);
        this.validateExpr(expr.right, depth + 1);
        return;
      case 'cond':
        this.validateExpr(expr.test, depth + 1);
        this.validateExpr(expr.then, depth + 1);
        this.validateExpr(expr.else, depth + 1);
        return;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPascal(name: string): boolean {
  const first = name[0];
  return first !== undefined && first >= 'A' && first <= 'Z' && name.length <= 64;
}

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

export function validateAstStructure(data: unknown): Diagnostic[] {
  const validator = new AstValidator();
  validator.validateRoot(data);
  return validator.diagnostics;
}

export function loadCheckedAst(data: unknown, opts: { trust: 'verify' }): Program {
  void opts; // the only accepted mode; the parameter exists so call sites read loudly
  const diagnostics = validateAstStructure(data);
  if (diagnostics.length > 0) throw new OrbitAstError(diagnostics);
  const root = data as SerializedProgram;
  return { templates: new Map(Object.entries(root.templates)) };
}

/**
 * DANGER: skips structural re-validation. Only for hosts that have ALREADY
 * verified integrity AND authenticity (e.g. an HMAC over
 * `(store_id, theme_version_id, ast_bytes)` checked out-of-band). If you are
 * not sure, use `loadCheckedAst`.
 */
export function unsafe_loadTrustedAst(data: unknown): Program {
  const root = data as SerializedProgram;
  if (!isRecord(root) || !isRecord(root.templates)) {
    throw new OrbitAstError([
      { code: 'O5001', severity: 'error', message: 'stored AST has no templates record' },
    ]);
  }
  return { templates: new Map(Object.entries(root.templates)) };
}

// ---------------------------------------------------------------------------
// Stored-AST authentication (host-supplied primitive)
// ---------------------------------------------------------------------------

/**
 * An HMAC over a message, supplied BY THE HOST.
 *
 * The engine deliberately does not implement one. Orbit is zero-I/O and
 * zero-dependency: importing `node:crypto` would break both, and the engine
 * must never hold key material. The host closes over its key and passes this
 * function in; the engine contributes only the parts that are easy to get
 * wrong and identical for every host — canonical byte assembly, domain
 * separation, and a constant-time tag comparison.
 *
 * Implement it with a real HMAC (`crypto.createHmac('sha256', key)` in Node,
 * `crypto.subtle.sign('HMAC', …)` in a worker). It must be deterministic and
 * must not throw on any input.
 */
export type HmacFn = (message: Uint8Array) => Uint8Array;

/** The tuple a stored-AST tag is bound to. */
export interface AstAuthContext {
  /** Tenant identifier. Binding it stops a theme moving between stores. */
  storeId: string;
  /** Immutable version identifier. Binding it stops rollback to an old AST. */
  themeVersionId: string;
}

/**
 * Domain-separation prefix. Any other use of the host's key produces messages
 * that cannot collide with an Orbit AST tag. Bump the suffix if the message
 * layout ever changes, so old tags stop verifying instead of being
 * reinterpreted.
 */
const AST_AUTH_DOMAIN = 'orbit.ast-auth.v1';

/**
 * Canonical, unambiguous message bytes for `(storeId, themeVersionId,
 * astBytes)`.
 *
 * Every field is LENGTH-PREFIXED with a 4-byte big-endian count, so no choice
 * of field contents can shift a byte from one field into another —
 * `("ab", "c")` and `("a", "bc")` produce different messages. That is the
 * whole point: a concatenation-based scheme lets a tenant with control over
 * one field forge a tag for a different tuple.
 */
export function astAuthMessage(ctx: AstAuthContext, astBytes: Uint8Array | string): Uint8Array {
  const fields = [
    utf8Bytes(AST_AUTH_DOMAIN),
    utf8Bytes(ctx.storeId),
    utf8Bytes(ctx.themeVersionId),
    typeof astBytes === 'string' ? utf8Bytes(astBytes) : astBytes,
  ];
  let total = 0;
  for (const f of fields) total += 4 + f.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const f of fields) {
    const n = f.length;
    out[at] = (n >>> 24) & 0xff;
    out[at + 1] = (n >>> 16) & 0xff;
    out[at + 2] = (n >>> 8) & 0xff;
    out[at + 3] = n & 0xff;
    at += 4;
    out.set(f, at);
    at += n;
  }
  return out;
}

/**
 * Mint the tag to store alongside the AST row. Call at SUBMIT time, with the
 * exact bytes you will later persist and load.
 */
export function signAst(ctx: AstAuthContext, astBytes: Uint8Array | string, hmac: HmacFn): Uint8Array {
  return hmac(astAuthMessage(ctx, astBytes));
}

/**
 * Verify a stored tag. Call BEFORE `loadCheckedAst` / `unsafe_loadTrustedAst`,
 * and pass the byte-identical `astBytes` that were signed — re-serializing a
 * parsed object can reorder keys and will not verify.
 *
 * SECURITY CONTRACT
 * - Authenticity only. A valid tag says "this host minted these bytes for this
 *   store and version"; it says nothing about the AST being structurally
 *   valid. Keep using `loadCheckedAst` unless you own the whole pipeline.
 * - Returns `false` rather than throwing, on every failure path, so a caller
 *   cannot accidentally treat a thrown error as a pass.
 * - The comparison is constant time in the tag CONTENTS. Tag LENGTH is
 *   compared first and leaks (it is a public parameter of the MAC, not a
 *   secret).
 */
export function verifyAstTag(
  ctx: AstAuthContext,
  astBytes: Uint8Array | string,
  tag: Uint8Array,
  hmac: HmacFn,
): boolean {
  let expected: Uint8Array;
  try {
    expected = hmac(astAuthMessage(ctx, astBytes));
  } catch {
    return false;
  }
  return timingSafeEqualBytes(expected, tag);
}

/**
 * Byte-wise comparison whose running time depends only on the length of the
 * inputs, never on WHERE they first differ. A naive `===`/early-return
 * compare over a MAC tag leaks the matching prefix length, which is enough to
 * forge a tag one byte at a time.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * UTF-8 encoder. Hand-rolled because `TextEncoder` is a platform global the
 * engine's tsconfig deliberately does not admit (`"types": []`, no DOM lib).
 * Unpaired surrogates become U+FFFD so the encoding is total and canonical.
 */
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}
