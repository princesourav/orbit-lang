import { describe, expect, it } from 'vitest';
import { parseTemplate } from './parser';
import { type IfNode, type ForNode, type ElementNode } from './ast';

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

  it('strips {# comments #} and <!-- comments -->', () => {
    const template = ok('<p>{# gone #}a<!-- also gone -->b</p>');
    const p = template.body[0] as ElementNode;
    expect(p.children.map((c) => (c.kind === 'text' ? c.value : c.kind))).toEqual(['a', 'b']);
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
  it('parses precedence: pipe binds tighter than *, ?? above ternary', () => {
    const template = ok('<p>{a |> round * 2}</p><p>{x ?? y ? "a" : "b"}</p>');
    const first = template.body[0] as ElementNode;
    const interp = first.children[0];
    if (interp?.kind !== 'interpolation') throw new Error('unreachable');
    expect(interp.expr).toMatchObject({
      kind: 'binary',
      op: '*',
      left: { kind: 'call', callee: 'round', viaPipe: true },
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
