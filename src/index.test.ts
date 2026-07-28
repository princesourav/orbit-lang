/**
 * Public-surface lock.
 *
 * `src/index.ts` is the only thing a consumer of `@orbitlang/core` can see.
 * Four things kept going wrong across parallel work on this package:
 *
 *  1. a new API landed in a module and was never re-exported (`SlotTarget`
 *     shipped as the return type of an exported function that consumers could
 *     not name);
 *  2. a type appeared only in the SIGNATURE of an exported value
 *     (`FilterCheckCtx` in `StdlibFilter.check`), so implementing the interface
 *     from outside was impossible;
 *  3. an export was removed and nothing failed until a downstream build did;
 *  4. runtime exports and type-only exports drifted apart.
 *
 * The value list below is asserted at RUNTIME (a deleted export fails here).
 * The type list is asserted by `tsc` — every name is used in a type position,
 * so a deleted or renamed type fails `npm run typecheck`. Adding an export is
 * meant to require touching this file.
 */
import { describe, expect, it } from 'vitest';
import * as orbit from './index';

import type {
  AccessPlan,
  AstAuthContext,
  Attr,
  AttrPart,
  BinaryOp,
  CheckOptions,
  CheckResult,
  ComponentCallNode,
  Diagnostic,
  ElementNode,
  Expr,
  FilterArg,
  FilterCheckCtx,
  FilterRuntime,
  ForNode,
  GroupedSlots,
  HmacFn,
  HostFilterDecl,
  HtmlObligation,
  HtmlValue,
  IfBranch,
  IfNode,
  JsonLdNode,
  LetNode,
  LocaleData,
  Node,
  OrbitHost,
  ParseResult,
  Pos,
  Program,
  ProgramResult,
  PropDecl,
  RenderErrorInfo,
  RenderOptions,
  RenderResult,
  RenderWarning,
  SerializedProgram,
  SettingControl,
  SettingDecl,
  Severity,
  SlotDecl,
  SlotNode,
  SlotTarget,
  SourceFile,
  Span,
  SrcsetCandidate,
  StdlibFilter,
  Template,
  Type,
  TypeExpr,
  UrlCheck,
  UrlPolicy,
} from './index';

/** Every runtime (value) export, sorted. */
const EXPECTED_VALUE_EXPORTS = [
  'BANNED_ELEMENTS',
  'BRANDED_OPAQUE_NAMES',
  'DEFAULT_LOCALE',
  'ELEMENT_ALLOWLIST',
  'EXPR_KINDS',
  'LIMITS',
  'NODE_KINDS',
  'OrbitAstError',
  'OrbitParseError',
  'OrbitRenderError',
  'RCDATA_ELEMENTS',
  'STDLIB',
  'STDLIB_FILTER_NAMES',
  'TypeRegistry',
  'URL_ATTRS',
  'VOID_ELEMENTS',
  'assertValidHostFilters',
  'assignable',
  'astAuthMessage',
  'attrAllowed',
  'attrRejection',
  'check',
  'codeFrame',
  'escapeAttr',
  'escapeRcdata',
  'escapeText',
  'extractAccessPlan',
  'formatDiagnostic',
  'formatDiagnosticWithSource',
  'formatDiagnostics',
  'formatProgram',
  'formatRenderWarning',
  'formatTemplate',
  'frozenMap',
  'groupSlotChildren',
  'htmlObligationOf',
  'htmlValue',
  'isForbiddenKey',
  'isHexColorLiteral',
  'isHtmlValue',
  'isOpaqueNamed',
  'loadCheckedAst',
  'parseProgram',
  'parseSrcsetCandidates',
  'parseTemplate',
  'render',
  'sanitizeSrcset',
  'sanitizeUrl',
  'serializeJsonLd',
  'serializeProgram',
  'signAst',
  'slotNameOf',
  'splitSourceLines',
  'srcsetDescriptorValid',
  't',
  'timingSafeEqualBytes',
  'typeToString',
  'unsafe_loadTrustedAst',
  'unwrapOptional',
  'validateAstStructure',
  'verifyAstTag',
  'warnsAtUseSite',
] as const;

describe('public surface', () => {
  it('exports exactly the documented value list', () => {
    const actual = Object.keys(orbit).sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  it('exposes the whole documented pipeline as callables', () => {
    for (const name of [
      'parseProgram',
      'check',
      'serializeProgram',
      'loadCheckedAst',
      'render',
      'extractAccessPlan',
    ] as const) {
      expect(typeof orbit[name]).toBe('function');
    }
  });

  it('exports the v0.2 additions, not just their implementations', () => {
    // Each of these landed in a module this milestone; the bug being locked
    // out is "it works internally but is not reachable from the package".
    expect(typeof orbit.formatRenderWarning).toBe('function');
    expect(typeof orbit.signAst).toBe('function');
    expect(typeof orbit.verifyAstTag).toBe('function');
    expect(typeof orbit.astAuthMessage).toBe('function');
    expect(typeof orbit.timingSafeEqualBytes).toBe('function');
    expect(typeof orbit.sanitizeSrcset).toBe('function');
    expect(typeof orbit.parseSrcsetCandidates).toBe('function');
    expect(typeof orbit.srcsetDescriptorValid).toBe('function');
    expect(typeof orbit.isHexColorLiteral).toBe('function');
    expect(typeof orbit.isForbiddenKey).toBe('function');
    expect(typeof orbit.frozenMap).toBe('function');
    expect(typeof orbit.slotNameOf).toBe('function');
  });

  it('ships no default export (named exports only)', () => {
    expect((orbit as Record<string, unknown>)['default']).toBeUndefined();
  });
});

describe('public types are nameable from the package root', () => {
  it('typechecks a consumer that names every exported type', () => {
    // Compile-time assertion: this object literal cannot be written unless
    // every type above is exported AND still has the shape callers rely on.
    // `tsc --noEmit` is the real test; the runtime body just proves it ran.
    const surface: {
      accessPlan?: AccessPlan;
      astAuth?: AstAuthContext;
      attr?: Attr;
      attrPart?: AttrPart;
      binaryOp?: BinaryOp;
      checkOptions?: CheckOptions;
      checkResult?: CheckResult;
      componentCall?: ComponentCallNode;
      diagnostic?: Diagnostic;
      element?: ElementNode;
      expr?: Expr;
      filterArg?: FilterArg;
      filterCheckCtx?: FilterCheckCtx;
      filterRuntime?: FilterRuntime;
      forNode?: ForNode;
      grouped?: GroupedSlots;
      hmac?: HmacFn;
      hostFilter?: HostFilterDecl;
      html?: HtmlValue;
      htmlObligation?: HtmlObligation;
      ifBranch?: IfBranch;
      ifNode?: IfNode;
      jsonLd?: JsonLdNode;
      letNode?: LetNode;
      locale?: LocaleData;
      node?: Node;
      host?: OrbitHost;
      parseResult?: ParseResult;
      pos?: Pos;
      program?: Program;
      programResult?: ProgramResult;
      propDecl?: PropDecl;
      renderError?: RenderErrorInfo;
      renderOptions?: RenderOptions;
      renderResult?: RenderResult;
      renderWarning?: RenderWarning;
      serialized?: SerializedProgram;
      settingControl?: SettingControl;
      settingDecl?: SettingDecl;
      severity?: Severity;
      slotDecl?: SlotDecl;
      slotNode?: SlotNode;
      slotTarget?: SlotTarget;
      sourceFile?: SourceFile;
      span?: Span;
      srcsetCandidate?: SrcsetCandidate;
      stdlibFilter?: StdlibFilter;
      template?: Template;
      type?: Type;
      typeExpr?: TypeExpr;
      urlCheck?: UrlCheck;
      urlPolicy?: UrlPolicy;
    } = {};
    expect(surface).toEqual({});
  });

  it('types the v0.2 option and result shapes precisely', () => {
    // `urlPolicy` must be the union, not `string` — a typo has to be caught.
    const policies: UrlPolicy[] = ['placeholder', 'error'];
    const options: RenderOptions = { urlPolicy: policies[0] };
    expect(options.urlPolicy).toBe('placeholder');

    // Warnings are structured records, not strings. v0.1 shipped `string[]`
    // and hosts had to `.includes()` English prose to route them.
    const warning: RenderWarning = { code: 'O4900', message: 'blocked', line: 3, col: 7 };
    expect(orbit.formatRenderWarning(warning)).toContain('warning[O4900]');

    // `slotNameOf` returns a tagged union, not a sentinel-prefixed string.
    const target: SlotTarget = { kind: 'named', name: 'badge' };
    expect(target.kind).toBe('named');
  });
});
