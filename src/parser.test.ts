import { describe, expect, it } from 'vitest';
import { parseTemplate } from './parser';
import { type IfNode, type ForNode, type ElementNode } from './ast';
import { LIMITS } from './limits';

const HEADER = '---\ncomponent Card\n---\n';

function ok(body: string, header = HEADER) {
  const result = parseTemplate(header + body, 'test.orbit');
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
  }
  return result.template;
}

function bad(body: string, header = HEADER): { code: string; message: string; line?: number } {
  const result = parseTemplate(header + body, 'test.orbit');
  if (result.ok) throw new Error('expected a parse error');
  const d = result.diagnostics[0];
  if (d === undefined) throw new Error('no diagnostic');
  return { code: d.code, message: d.message, line: d.span?.start.line };
}

describe('frontmatter', () => {
  it('requires a frontmatter header', () => {
    expect(bad('<p>x</p>', '').code).toBe('O1030');
  });

  it('parses component/page, props, settings, slots', () => {
    const template = ok(
      '<p>x</p>',
      '---\ncomponent Card\nprops {\n  product: Product\n  n: Int = 3\n  note: String?\n}\nsettings {\n  ratio: Select("a", "b") = "a" label "Ratio"\n  per: Range(12, 48, step: 12) = 24\n  on: Toggle = false\n}\nslots { badge?, footer }\n---\n',
    );
    expect(template.templateKind).toBe('component');
    expect(template.props.map((p) => p.name)).toEqual(['product', 'n', 'note']);
    expect(template.props[2]?.type.kind).toBe('optional');
    expect(template.settings.map((s) => s.setting.control)).toEqual(['select', 'range', 'toggle']);
    expect(template.slots).toMatchObject([
      { name: 'badge', required: false },
      { name: 'footer', required: true },
    ]);
  });

  it('rejects PascalCase pages and lowercase components', () => {
    expect(bad('<p>x</p>', '---\npage Collection\n---\n').code).toBe('O1034');
    expect(bad('<p>x</p>', '---\ncomponent card\n---\n').code).toBe('O1033');
  });

  it('rejects non-literal defaults and unknown controls', () => {
    expect(bad('<p>x</p>', '---\ncomponent Card\nprops { a: Int = foo }\n---\n').code).toBe('O1041');
    expect(bad('<p>x</p>', '---\ncomponent Card\nsettings { a: Dropdown("x") = "x" }\n---\n').code).toBe('O1047');
  });

  it('reserves the settings binding name', () => {
    expect(bad('<p>x</p>', '---\ncomponent Card\nprops { settings: Int }\n---\n').code).toBe('O1042');
  });
});

describe('element allowlist (W-12)', () => {
  it.each([
    ['<script>alert(1)</script>'],
    ['<style>.a { color: red }</style>'],
    ['<iframe src="/x"></iframe>'],
    ['<object></object>'],
    ['<embed>'],
    ['<base href="/">'],
    ['<meta charset="utf-8">'],
    ['<link rel="preload">'],
    ['<template><p>x</p></template>'],
    ['<noscript><p>x</p></noscript>'],
    ['<svg></svg>'],
    ['<math></math>'],
  ])('rejects banned element %s with O1080', (body) => {
    expect(bad(body).code).toBe('O1080');
  });

  it('rejects unknown elements with O1081', () => {
    expect(bad('<blink>x</blink>').code).toBe('O1081');
    expect(bad('<canvas></canvas>').code).toBe('O1081');
  });
});

describe('attribute allowlist (W-11, W-12)', () => {
  it('rejects on* handlers, srcdoc, ping and namespaced names', () => {
    expect(bad('<div onclick="x">y</div>').code).toBe('O1086');
    expect(bad('<div onmouseover="x">y</div>').code).toBe('O1086');
    expect(bad('<a ping="/x">y</a>').code).toBe('O1086');
    expect(bad('<a xlink:href="/x">y</a>').code).toBe('O1086');
  });

  it('rejects attributes outside the allowlist, allows data-*/aria-*', () => {
    expect(bad('<div foo="1">x</div>').code).toBe('O1087');
    const el = ok('<div data-price-display="x" aria-label="y">x</div>').body[0] as ElementNode;
    expect(el.attrs.map((a) => a.name)).toEqual(['data-price-display', 'aria-label']);
  });

  it('marks URL attributes statically', () => {
    const el = ok('<a href="/x" title="t">y</a>').body[0] as ElementNode;
    expect(el.attrs.find((a) => a.name === 'href')?.isUrl).toBe(true);
    expect(el.attrs.find((a) => a.name === 'title')?.isUrl).toBe(false);
  });

  it('requires quoted or expression values; no single quotes', () => {
    expect(bad('<div class=card>x</div>').code).toBe('O1090');
    expect(bad("<div class='card'>x</div>").code).toBe('O1089');
  });

  it('rejects duplicate attributes', () => {
    expect(bad('<div class="a" class="b">x</div>').code).toBe('O1085');
  });
});

describe('style discipline (W-09)', () => {
  it('allows static style attributes', () => {
    const el = ok('<div style="--cols: 3">x</div>').body[0] as ElementNode;
    expect(el.attrs[0]?.name).toBe('style');
  });

  it('rejects any interpolation inside style', () => {
    expect(bad('<div style="color: {c}">x</div>').code).toBe('O1095');
    expect(bad('<div style={c}>x</div>').code).toBe('O1095');
  });
});

describe('tree strictness', () => {
  it('requires explicit closing tags', () => {
    expect(bad('<div><p>x</div>').code).toBe('O1052');
    expect(bad('<div>x').code).toBe('O1050');
    expect(bad('</div>').code).toBe('O1052');
  });

  it('handles void elements with and without a slash', () => {
    const t1 = ok('<img src="/a.png" alt="a"><br><hr/>');
    expect(t1.body.map((n) => (n.kind === 'element' ? n.tag : n.kind))).toEqual(['img', 'br', 'hr']);
    expect(bad('<div/>').code).toBe('O1082');
  });

  it('rejects unescaped < in text with a fix-it', () => {
    const d = bad('<p>a < b</p>');
    expect(d.code).toBe('O1053');
  });

  it('drops whitespace-only text and collapses runs', () => {
    const template = ok('<div>\n  <p>a\n     b</p>\n</div>');
    const div = template.body[0] as ElementNode;
    expect(div.children).toHaveLength(1);
    const p = div.children[0] as ElementNode;
    expect(p.children[0]).toMatchObject({ kind: 'text', value: 'a b' });
  });

  it('preserves whitespace inside <pre>', () => {
    const pre = ok('<pre>  a\n   b</pre>').body[0] as ElementNode;
    expect(pre.children[0]).toMatchObject({ kind: 'text', value: '  a\n   b' });
  });

  it('retains {# comments #} and <!-- comments --> as nodes', () => {
    /*
     * Changed deliberately. Comments used to be discarded here, which meant
     * `orbit fmt` deleted every comment in a file — silent data loss that no
     * test caught, because a comment changes no rendered byte.
     *
     * They are nodes now. They still render nothing; see comments.test.ts,
     * which pins both halves.
     */
    const template = ok('<p>{# kept #}a<!-- also kept -->b</p>');
    const p = template.body[0] as ElementNode;
    expect(p.children.map((c) => (c.kind === 'text' ? c.value : c.kind))).toEqual([
      'comment',
      'a',
      'comment',
      'b',
    ]);
  });

  it('verbatim disables interpolation in the subtree', () => {
    const el = ok('<code verbatim>{not.an.island}</code>').body[0] as ElementNode;
    expect(el.children[0]).toMatchObject({ kind: 'text', value: '{not.an.island}' });
  });

  it('enforces the element depth cap at construction', () => {
    const open = Array.from({ length: 70 }, () => '<div>').join('');
    const close = Array.from({ length: 70 }, () => '</div>').join('');
    expect(bad(open + 'x' + close).code).toBe('O1101');
  });

  // All three structural caps must abort DURING construction — an over-cap
  // template must never finish parsing, so no post-hoc walk can skip them.
  it('enforces the AST node cap at construction (O1100)', () => {
    const under = '<br>'.repeat(LIMITS.maxAstNodesPerTemplate);
    expect(ok(under).nodeCount).toBe(LIMITS.maxAstNodesPerTemplate);
    expect(bad('<br>'.repeat(LIMITS.maxAstNodesPerTemplate + 1)).code).toBe('O1100');
  });

  it('enforces the expression depth cap at construction (O1009)', () => {
    expect(bad(`<p>{${'('.repeat(40)}1${')'.repeat(40)}}</p>`).code).toBe('O1009');
  });
});

describe('RCDATA (<title>/<textarea>)', () => {
  it('allows interpolation and preserves text exactly', () => {
    const title = ok('<title>Hi {name} & co</title>').body[0] as ElementNode;
    expect(title.content).toBe('rcdata');
    expect(title.children.map((c) => c.kind)).toEqual(['text', 'interpolation', 'text']);
    expect(title.children[2]).toMatchObject({ value: ' & co' });
  });

  it('treats nested tags as text', () => {
    const ta = ok('<textarea><p>not a tag</p></textarea>').body[0] as ElementNode;
    expect(ta.children.every((c) => c.kind === 'text' || c.kind === 'interpolation')).toBe(true);
  });
});

describe('control flow tags', () => {
  it('parses sibling <else-if>/<else> into one if node', () => {
    const template = ok('<if {a}><p>1</p></if><else-if {b}><p>2</p></else-if><else><p>3</p></else>');
    expect(template.body).toHaveLength(1);
    const node = template.body[0] as IfNode;
    expect(node.branches).toHaveLength(2);
    expect(node.elseChildren).toHaveLength(1);
  });

  it('rejects orphan <else-if>/<else>', () => {
    expect(bad('<else-if {a}><p>2</p></else-if>').code).toBe('O1059');
    expect(bad('<p>x</p><else><p>3</p></else>').code).toBe('O1059');
  });

  it('parses <for item, i of={expr} limit={n}> with <empty> last', () => {
    const template = ok('<for p, i of={items} limit={24}><p>{p}</p><empty><p>none</p></empty></for>');
    const node = template.body[0] as ForNode;
    expect(node.item).toBe('p');
    expect(node.index).toBe('i');
    expect(node.limit).toMatchObject({ kind: 'int', value: 24 });
    expect(node.emptyChildren).toHaveLength(1);
  });

  it('rejects <empty> outside <for> and non-last <empty>', () => {
    expect(bad('<empty><p>x</p></empty>').code).toBe('O1055');
    expect(bad('<for p of={items}><empty><p>none</p></empty><p>{p}</p></for>').code).toBe('O1058');
    expect(bad('<div><for p of={items}><div><empty>x</empty></div></for></div>').code).toBe('O1055');
  });

  it('parses <let> and <slot> self-closing forms', () => {
    const template = ok('<let x={1}/><slot/><slot name="badge"/>');
    expect(template.body.map((n) => n.kind)).toEqual(['let', 'slot', 'slot']);
    expect(bad('<slot>fallback</slot>').code).toBe('O1069');
    expect(bad('<let x={1}></let>').code).toBe('O1067');
  });

  it('parses <json-ld> with exactly one record expression', () => {
    const template = ok('<json-ld>{ {name: "x"} }</json-ld>');
    expect(template.body[0]?.kind).toBe('json-ld');
    expect(bad('<json-ld><p>x</p></json-ld>').code).toBe('O1071');
  });
});

describe('components', () => {
  it('PascalCase means component; props take expressions and bare flags', () => {
    const template = ok('<ProductCard product={p} showVendor/>');
    const node = template.body[0];
    expect(node).toMatchObject({ kind: 'component', name: 'ProductCard' });
    if (node?.kind !== 'component') throw new Error('unreachable');
    expect(node.props.map((p) => `${p.name}:${p.value.form}`)).toEqual(['product:expr', 'showVendor:bare']);
  });

  it('rejects islands inside quoted component props', () => {
    expect(bad('<Card title="a {b}"/>').code).toBe('O1091');
  });

  it('rejects slot= on component calls', () => {
    expect(bad('<Card slot="badge"/>').code).toBe('O1072');
  });
});

describe('expressions', () => {
  /** Pull the expression out of `<p>{...}</p>`. */
  function exprOf(body: string) {
    const el = ok(`<p>{${body}}</p>`).body[0] as ElementNode;
    const interp = el.children[0];
    if (interp?.kind !== 'interpolation') throw new Error('unreachable');
    return interp.expr;
  }

  // v0.2 REVERSED v0.1 here: `|>` used to bind TIGHTER than `*` and `+`, so
  // `a + b |> f` silently meant `a + (b |> f)`. It is now the loosest
  // computation operator, matching Elixir/F#/Julia.
  describe('pipe precedence (|> is deliberately loosest)', () => {
    it('pipes the whole additive expression', () => {
      expect(exprOf('a + b |> round')).toMatchObject({
        kind: 'call',
        callee: 'round',
        viaPipe: true,
        args: [{ value: { kind: 'binary', op: '+', left: { name: 'a' }, right: { name: 'b' } } }],
      });
    });

    it('pipes the whole multiplicative expression', () => {
      expect(exprOf('a * b |> round')).toMatchObject({
        kind: 'call',
        callee: 'round',
        args: [{ value: { kind: 'binary', op: '*' } }],
      });
    });

    it('pipes the whole comparison and logical expression', () => {
      expect(exprOf('a < b |> yesno')).toMatchObject({
        kind: 'call',
        callee: 'yesno',
        args: [{ value: { kind: 'binary', op: '<' } }],
      });
      expect(exprOf('a && b |> yesno')).toMatchObject({
        kind: 'call',
        callee: 'yesno',
        args: [{ value: { kind: 'binary', op: '&&' } }],
      });
    });

    it('binds tighter than ?? — the pipeline result is what falls back', () => {
      expect(exprOf('items |> first ?? "-"')).toMatchObject({
        kind: 'coalesce',
        left: { kind: 'call', callee: 'first', viaPipe: true },
        right: { kind: 'string', value: '-' },
      });
    });

    it('binds tighter than ?: — a pipeline can be the ternary condition', () => {
      expect(exprOf('a |> isBlank ? "x" : "y"')).toMatchObject({
        kind: 'cond',
        test: { kind: 'call', callee: 'isBlank', viaPipe: true },
      });
    });

    it('binds looser than unary and postfix', () => {
      expect(exprOf('-a |> abs')).toMatchObject({
        kind: 'call',
        callee: 'abs',
        args: [{ value: { kind: 'unary', op: '-' } }],
      });
      expect(exprOf('a.b.c |> upper')).toMatchObject({
        kind: 'call',
        callee: 'upper',
        args: [{ value: { kind: 'member', property: 'c' } }],
      });
      expect(exprOf('items[0] |> upper')).toMatchObject({
        kind: 'call',
        callee: 'upper',
        args: [{ value: { kind: 'index' } }],
      });
    });

    it('chains left-to-right', () => {
      expect(exprOf('a |> upper |> truncate(40)')).toMatchObject({
        kind: 'call',
        callee: 'truncate',
        args: [{ value: { kind: 'call', callee: 'upper' } }, { value: { kind: 'int', value: 40 } }],
      });
    });

    it('rejects a tighter operator after a pipeline with a parenthesize fix-it (O1019)', () => {
      const d = bad('<p>{a |> round * 2}</p>');
      expect(d.code).toBe('O1019');
      const result = parseTemplate(HEADER + '<p>{a |> round * 2}</p>', 'test.orbit');
      if (result.ok) throw new Error('expected error');
      expect(result.diagnostics[0]?.suggestion).toContain('(… |> round) *');
      expect(bad('<p>{a |> round + 2}</p>').code).toBe('O1019');
      expect(bad('<p>{a |> len > 2}</p>').code).toBe('O1019');
    });

    it('parenthesizing restores the tight reading', () => {
      expect(exprOf('(a |> round) * 2')).toMatchObject({
        kind: 'binary',
        op: '*',
        left: { kind: 'call', callee: 'round', viaPipe: true },
      });
    });
  });

  it('parses ?? above ternary', () => {
    const template = ok('<p>{x ?? y ? "a" : "b"}</p>');
    const first = template.body[0] as ElementNode;
    const interp = first.children[0];
    if (interp?.kind !== 'interpolation') throw new Error('unreachable');
    expect(interp.expr).toMatchObject({ kind: 'cond', test: { kind: 'coalesce' } });
  });

  describe('numeric literal hygiene', () => {
    it('rejects literals wider than the digit cap (O1024)', () => {
      const huge = '9'.repeat(400);
      expect(bad(`<p>{${huge}}</p>`).code).toBe('O1024');
      expect(bad(`<p>{1.${'1'.repeat(400)}}</p>`).code).toBe('O1024');
      expect(bad('<p>x</p>', `---\ncomponent Card\nprops { n: Int = ${huge} }\n---\n`).code).toBe('O1024');
    });

    it('rejects integers above MAX_SAFE_INTEGER that would round (O1025)', () => {
      expect(bad('<p>{9007199254740993}</p>').code).toBe('O1025');
      expect(bad('<p>{12345678901234567890}</p>').code).toBe('O1025');
      expect(bad('<p>x</p>', '---\ncomponent Card\nprops { n: Int = 9007199254740993 }\n---\n').code).toBe('O1025');
    });

    it('rejects fractions that lose precision (O1025)', () => {
      expect(bad('<p>{1.00000000000000001}</p>').code).toBe('O1025');
      expect(bad('<p>{0.12345678901234567}</p>').code).toBe('O1025');
    });

    it('accepts exactly-representable literals, including small fractions', () => {
      expect(exprOf('9007199254740991')).toMatchObject({ kind: 'int', value: 9007199254740991 });
      expect(exprOf('0.0000001')).toMatchObject({ kind: 'float', value: 1e-7 });
      expect(exprOf('1.50')).toMatchObject({ kind: 'float', value: 1.5 });
      expect(exprOf('007')).toMatchObject({ kind: 'int', value: 7 });
      expect(exprOf('0.1')).toMatchObject({ kind: 'float', value: 0.1 });
      expect(exprOf('10000000000000000')).toMatchObject({ kind: 'int', value: 1e16 });
    });

    it('never yields Infinity or a silently rounded value', () => {
      // The v0.1 path was a bare Number(digits): these are the two silent
      // failures it produced.
      expect(Number('9'.repeat(400))).toBe(Infinity);
      expect(Number('9007199254740993')).toBe(9007199254740992);
      expect(bad(`<p>{${'9'.repeat(400)}}</p>`).code).toBe('O1024');
      expect(bad('<p>{9007199254740993}</p>').code).toBe('O1025');
    });
  });

  it('rejects dynamic member access with a string index', () => {
    expect(bad('<p>{obj["name"]}</p>').code).toBe('O1015');
  });

  it('allows list[intExpr] indexing', () => {
    const template = ok('<p>{items[2] ?? "-"}</p>');
    expect(template.body[0]?.kind).toBe('element');
  });

  it('rejects method calls with a pipe fix-it', () => {
    const d = bad('<p>{a.title.upper()}</p>');
    expect(d.code).toBe('O1016');
  });

  it('rejects overly deep expressions', () => {
    const deep = '('.repeat(40) + '1' + ')'.repeat(40);
    expect(bad(`<p>{${deep}}</p>`).code).toBe('O1009');
  });

  it('{"{"} escapes a literal brace', () => {
    const p = ok('<p>{"{"}</p>').body[0] as ElementNode;
    expect(p.children[0]).toMatchObject({ kind: 'interpolation', expr: { kind: 'string', value: '{' } });
  });
});

describe('spans and suggestions', () => {
  it('parse errors carry line/col and a suggestion where available', () => {
    const result = parseTemplate(HEADER + '<p>\n<div style="x: {y}">a</div></p>', 'test.orbit');
    if (result.ok) throw new Error('expected error');
    const d = result.diagnostics[0];
    expect(d?.span?.start.line).toBe(5);
    expect(d?.suggestion).toContain('class');
  });
});

describe('reserved syntax', () => {
  /*
   * `on:` and `@` are claimed now, while claiming them is free. Once themes
   * exist, adding event bindings would break any theme that had used either
   * form for something else — and the whole point of reserving is that the
   * breakage happens today, to nobody.
   */
  it('rejects on:name as reserved, not as a namespaced attribute', () => {
    const d = bad('<button on:click={x}>y</button>');
    expect(d.code).toBe('O1103');
    expect(d.message).toContain('reserved');
  });

  it('rejects @name as reserved, not as a missing attribute name', () => {
    const d = bad('<button @click={x}>y</button>');
    expect(d.code).toBe('O1103');
    expect(d.message).toContain('reserved');
  });

  it('still reports onclick as a banned event handler', () => {
    // Different reason, different code: `onclick` is banned forever,
    // `on:click` is merely unimplemented. Collapsing them misleads on both.
    const d = bad('<button onclick="x()">y</button>');
    expect(d.code).toBe('O1086');
    expect(d.message).toContain('event-handler');
  });

  it('still reports namespaced attributes under their own reason', () => {
    const d = bad('<div xlink:href="x">y</div>');
    expect(d.code).toBe('O1086');
    expect(d.message).toContain('namespaced');
  });

  it('leaves ordinary attributes alone', () => {
    expect(() => ok('<div data-x="1" class="y">z</div>')).not.toThrow();
  });
});
