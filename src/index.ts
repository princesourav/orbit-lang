/**
 * Orbit — the open template-language engine.
 *
 * Pipeline: parse → check → (serialize/store) → loadCheckedAst → render.
 * The engine has no I/O, no clock in output, no platform coupling; everything
 * store-shaped arrives through the host interface (see host.ts).
 */
export {
  type Attr,
  type AttrPart,
  type BinaryOp,
  type Expr,
  type ForNode,
  type IfBranch,
  type IfNode,
  type Node,
  type Program,
  type PropDecl,
  type SettingControl,
  type SettingDecl,
  type SlotDecl,
  type Template,
  type TypeExpr,
  EXPR_KINDS,
  NODE_KINDS,
  groupSlotChildren,
  slotNameOf,
} from './ast';
export {
  type Diagnostic,
  type Pos,
  type Severity,
  type Span,
  formatDiagnostic,
  OrbitAstError,
  OrbitParseError,
  OrbitRenderError,
} from './diagnostics';
export { LIMITS } from './limits';
export {
  ELEMENT_ALLOWLIST,
  BANNED_ELEMENTS,
  RCDATA_ELEMENTS,
  URL_ATTRS,
  VOID_ELEMENTS,
  attrAllowed,
  attrRejection,
} from './allowlists';
export { parseProgram, parseTemplate, type ParseResult, type ProgramResult, type SourceFile } from './parser';
export {
  assignable,
  BRANDED_OPAQUE_NAMES,
  isOpaqueNamed,
  t,
  type Type,
  TypeRegistry,
  typeToString,
  unwrapOptional,
} from './types';
export { check, type CheckOptions, type CheckResult } from './checker';
export {
  escapeAttr,
  escapeRcdata,
  escapeText,
  sanitizeUrl,
  serializeJsonLd,
  type UrlCheck,
} from './escape';
export { render, type RenderErrorInfo, type RenderOptions, type RenderResult } from './interpreter';
export {
  DEFAULT_LOCALE,
  STDLIB,
  STDLIB_FILTER_NAMES,
  type FilterRuntime,
  type LocaleData,
  type StdlibFilter,
} from './stdlib';
export {
  assertValidHostFilters,
  extractAccessPlan,
  isHtmlValue,
  unsafeHtmlValue,
  type AccessPlan,
  type HostFilterDecl,
  type HtmlValue,
  type OrbitHost,
} from './host';
export {
  loadCheckedAst,
  serializeProgram,
  unsafe_loadTrustedAst,
  validateAstStructure,
  type SerializedProgram,
} from './validate-ast';
