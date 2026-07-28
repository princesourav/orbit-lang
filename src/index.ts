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
  type ComponentCallNode,
  type ElementNode,
  type Expr,
  type ForNode,
  type GroupedSlots,
  type IfBranch,
  type IfNode,
  type JsonLdNode,
  type LetNode,
  type Node,
  type Program,
  type PropDecl,
  type SettingControl,
  type SettingDecl,
  type SlotDecl,
  type SlotNode,
  type SlotTarget,
  type Template,
  type TypeExpr,
  EXPR_KINDS,
  NODE_KINDS,
  groupSlotChildren,
  slotNameOf,
} from './ast';
export {
  type CodeFrameOptions,
  type Diagnostic,
  type Pos,
  type RenderWarning,
  type Severity,
  type Span,
  codeFrame,
  formatDiagnostic,
  formatDiagnostics,
  formatDiagnosticWithSource,
  formatRenderWarning,
  splitSourceLines,
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
// The canonical formatter. Note there are deliberately no options: one
// canonical form, decided here, is the whole point.
export { formatProgram, formatTemplate } from './formatter';
export {
  escapeAttr,
  escapeRcdata,
  escapeText,
  frozenMap,
  isForbiddenKey,
  isHexColorLiteral,
  parseSrcsetCandidates,
  sanitizeSrcset,
  sanitizeUrl,
  serializeJsonLd,
  srcsetDescriptorValid,
  type SrcsetCandidate,
  type UrlCheck,
} from './escape';
export {
  render,
  type RenderErrorInfo,
  type RenderOptions,
  type RenderResult,
  type UrlPolicy,
} from './interpreter';
export {
  DEFAULT_LOCALE,
  STDLIB,
  STDLIB_FILTER_NAMES,
  type FilterArg,
  type FilterCheckCtx,
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
  astAuthMessage,
  loadCheckedAst,
  serializeProgram,
  signAst,
  timingSafeEqualBytes,
  unsafe_loadTrustedAst,
  validateAstStructure,
  verifyAstTag,
  type AstAuthContext,
  type HmacFn,
  type SerializedProgram,
} from './validate-ast';
