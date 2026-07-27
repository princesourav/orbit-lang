/**
 * Property-based stored-AST round-trip fidelity.
 *
 * The deployment story is: parse and check ONCE at theme-publish time, store
 * the AST, then `loadCheckedAst` + `render` on every request. That is only
 * sound if the store/load leg is lossless — if serialisation could drop or
 * alter a node, a template would render differently in production than it did
 * when it was checked, and the checker's guarantees would not transfer.
 *
 * Fixed-example tests cover the shapes someone remembered. These generate
 * templates from a grammar instead, so the round-trip is exercised over
 * arbitrary nestings of the constructs that actually carry state: elements
 * with attributes, interpolation, `<if>`/`<else-if>`/`<else>`, `<for>` with
 * `<empty>`, `<let>`, and pipelines.
 *
 * The oracle is byte-identical RENDER output, not structural deep-equality:
 * it is the rendered bytes a merchant sees that must survive the trip, and
 * comparing renders also catches a load that produces a structurally-plausible
 * but semantically different tree.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Program } from './ast';
import { render } from './interpreter';
import { parseProgram, type SourceFile } from './parser';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { compileOk } from './test-host.helper';

// ---------------------------------------------------------------------------
// A grammar of well-typed template bodies
// ---------------------------------------------------------------------------

/**
 * In-scope, statically-typed expressions for the generated component. Keeping
 * the generator inside the type system is deliberate: the property under test
 * is round-trip fidelity, and a generator that produced ill-typed templates
 * would just be testing the checker's rejection path over and over.
 */
const STRING_EXPRS = ['title', 'title |> upper', 'title |> lower', '"literal"', 'tags[0] ?? "none"'];
const BOOL_EXPRS = ['flag', '!flag', 'flag && true', 'flag || false', 'count > 2', 'title != ""'];
const INT_EXPRS = ['count', 'count + 1', 'count * 2', '3'];

const CONTAINER_TAGS = ['div', 'p', 'section', 'span', 'li'];

interface Ctx {
  /** Loop variable in scope, if we are inside a `<for>`. */
  item?: string;
}

function textNode(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom('hello', 'x', 'a b c', '&', ''),
    fc.constantFrom(...STRING_EXPRS).map((e) => `{${e}}`),
  );
}

function leaf(ctx: Ctx): fc.Arbitrary<string> {
  const options = [
    textNode(),
    fc.constantFrom(...STRING_EXPRS).map((e) => `<span>{${e}}</span>`),
    fc.constantFrom(...INT_EXPRS).map((e) => `<span>{${e}}</span>`),
    fc.constant('<br>'),
    fc.constantFrom(...STRING_EXPRS).map((e) => `<p title={${e}}>text</p>`),
    fc.constantFrom(...STRING_EXPRS).map((e) => `<a href="/x" title={${e}}>link</a>`),
  ];
  if (ctx.item !== undefined) {
    const item = ctx.item;
    options.push(fc.constant(`<span>{${item}}</span>`));
    options.push(fc.constant(`<span>{${item} |> upper}</span>`));
  }
  return fc.oneof(...options);
}

function body(ctx: Ctx, depth: number): fc.Arbitrary<string> {
  if (depth <= 0) return leaf(ctx);
  const child = () => fc.array(body(ctx, depth - 1), { minLength: 1, maxLength: 2 }).map((xs) => xs.join(''));

  const element = fc
    .tuple(fc.constantFrom(...CONTAINER_TAGS), child())
    .map(([tag, inner]) => `<${tag}>${inner}</${tag}>`);

  const elementWithClass = fc
    .tuple(fc.constantFrom(...CONTAINER_TAGS), fc.constantFrom(...STRING_EXPRS), child())
    .map(([tag, expr, inner]) => `<${tag} class="c-{${expr}}">${inner}</${tag}>`);

  const ifOnly = fc
    .tuple(fc.constantFrom(...BOOL_EXPRS), child())
    .map(([cond, inner]) => `<if {${cond}}>${inner}</if>`);

  // `<else-if>` / `<else>` are SIBLINGS of `<if>`, not children of it — the
  // parser folds the run into one node (O1059 rejects an orphan).
  const ifElse = fc
    .tuple(fc.constantFrom(...BOOL_EXPRS), child(), child())
    .map(([cond, a, b]) => `<if {${cond}}>${a}</if><else>${b}</else>`);

  const ifElseIf = fc
    .tuple(fc.constantFrom(...BOOL_EXPRS), fc.constantFrom(...BOOL_EXPRS), child(), child(), child())
    .map(([c1, c2, a, b, c]) => `<if {${c1}}>${a}</if><else-if {${c2}}>${b}</else-if><else>${c}</else>`);

  // A nested <for> would shadow `row`; the generator keeps one loop variable
  // so every generated template stays well-scoped as well as well-typed.
  const forLoop =
    ctx.item === undefined
      ? fc
          .tuple(body({ item: 'row' }, depth - 1), body({}, 0))
          .map(([inner, empty]) => `<for row of={tags}>${inner}<empty>${empty}</empty></for>`)
      : undefined;

  const letBind = fc
    .tuple(fc.constantFrom(...STRING_EXPRS), child())
    .map(([expr, inner]) => `<let bound={${expr}}/><span>{bound}</span>${inner}`);

  const options = [element, elementWithClass, ifOnly, ifElse, ifElseIf, letBind, leaf(ctx)];
  if (forLoop !== undefined) options.push(forLoop);
  return fc.oneof(...options);
}

const generatedComponent: fc.Arbitrary<SourceFile> = body({}, 3).map((inner) => ({
  name: 'components/generated.orbit',
  source: `---
component Generated
props {
  title: String
  count: Int
  flag: Bool
  tags: List<String>
}
---
<div class="root">${inner}</div>`,
}));

const PROPS = { title: 'Sun & <Moon>', count: 3, flag: true, tags: ['red', 'blue'] };
const PROPS_EMPTY_LIST = { title: '', count: 0, flag: false, tags: [] as string[] };

/** JSON is the wire format; going through it is the real deployment path. */
function throughJson(program: Program): Program {
  const wire = JSON.parse(JSON.stringify(serializeProgram(program))) as unknown;
  return loadCheckedAst(wire, { trust: 'verify' });
}

describe('stored-AST round-trip fidelity', () => {
  it('parse → serialize → JSON → loadCheckedAst renders byte-identical HTML', () => {
    fc.assert(
      fc.property(generatedComponent, (file) => {
        const original = compileOk([file]);
        const reloaded = throughJson(original);
        for (const props of [PROPS, PROPS_EMPTY_LIST]) {
          const a = render(original, 'Generated', { props });
          const b = render(reloaded, 'Generated', { props });
          expect(a.ok).toBe(true);
          expect(b.ok).toBe(true);
          if (!a.ok || !b.ok) return;
          expect(b.html).toBe(a.html);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is a fixed point: serializing a reloaded program reproduces the wire form', () => {
    fc.assert(
      fc.property(generatedComponent, (file) => {
        const original = compileOk([file]);
        const wire1 = JSON.stringify(serializeProgram(original));
        const wire2 = JSON.stringify(serializeProgram(throughJson(original)));
        expect(wire2).toBe(wire1);
      }),
      { numRuns: 200 },
    );
  });

  it('survives repeated trips without drift', () => {
    fc.assert(
      fc.property(generatedComponent, (file) => {
        let program = compileOk([file]);
        const first = render(program, 'Generated', { props: PROPS });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        for (let i = 0; i < 3; i += 1) program = throughJson(program);
        const last = render(program, 'Generated', { props: PROPS });
        expect(last.ok).toBe(true);
        if (!last.ok) return;
        expect(last.html).toBe(first.html);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts every generated program through the verifying loader', () => {
    // `loadCheckedAst` re-validates structure and throws `OrbitAstError` on
    // anything it does not recognise. A generated construct that the validator
    // has no case for would make the store/load leg reject valid themes.
    fc.assert(
      fc.property(generatedComponent, (file) => {
        expect(() => throughJson(compileOk([file]))).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('parses deterministically: same source, identical wire bytes', () => {
    fc.assert(
      fc.property(generatedComponent, (file) => {
        const a = parseProgram([file]);
        const b = parseProgram([file]);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(JSON.stringify(serializeProgram(b.program))).toBe(
          JSON.stringify(serializeProgram(a.program)),
        );
      }),
      { numRuns: 150 },
    );
  });
});
