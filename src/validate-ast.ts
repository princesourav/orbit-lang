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
 * store; verify the HMAC before calling either loader.
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
import { LIMITS } from './limits';

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
        case 'let':
          if (typeof node.name !== 'string' || node.name === 'settings') this.invalid('malformed let binding');
          this.validateExpr(node.expr, 0);
          break;
        case 'component': {
          if (typeof node.name !== 'string' || !isPascal(node.name)) {
            this.invalid('component call name must be PascalCase');
            break;
          }
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
        if (typeof expr.value !== 'string' || expr.value.length !== 7 || !expr.value.startsWith('#')) {
          this.invalid('malformed color literal');
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
          this.validateExpr(field.value, depth + 1);
        }
        return;
      case 'range':
        this.validateExpr(expr.start, depth + 1);
        this.validateExpr(expr.end, depth + 1);
        return;
      case 'member':
        if (typeof expr.property !== 'string' || expr.property.length > 64) this.invalid('malformed member access');
        if (typeof expr.optional !== 'boolean') this.invalid('malformed member access');
        this.validateExpr(expr.object, depth + 1);
        return;
      case 'index':
        this.validateExpr(expr.object, depth + 1);
        this.validateExpr(expr.index, depth + 1);
        return;
      case 'call':
        if (typeof expr.callee !== 'string' || expr.callee.length > 64) this.invalid('malformed call');
        if (!Array.isArray(expr.args)) {
          this.invalid('malformed call args');
          return;
        }
        for (const arg of expr.args) this.validateExpr(arg, depth + 1);
        return;
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
