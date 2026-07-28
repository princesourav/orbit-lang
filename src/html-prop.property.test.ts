/**
 * Property: Html reaching a component prop stays element-content-only.
 *
 * A3 relaxed exactly one rule — `Html` may now be declared as a prop type and
 * passed to a prop declared `Html` — on the argument that every other
 * restriction is keyed on the type AT the sink and therefore still applies
 * transitively. That argument is sound by inspection today, and inspection is
 * not a guarantee: the sinks are five independent site-local checks, and
 * neither that shape nor a unified context variable is structurally safe
 * against someone adding a sixth sink and forgetting the check.
 *
 * So the property carries the weight the structure cannot. The generator
 * deliberately reaches EVERY sink position — element content, attribute value,
 * attribute with interpolated parts, `<let>`, filter operand, RCDATA, JSON-LD,
 * slot content, and a nested component — rather than the two that are easy to
 * think of. For each, the value either lands in element content or is rejected
 * at check time. There is no third outcome.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { check } from './checker';
import { render } from './interpreter';
import { parseProgram, type SourceFile } from './parser';
import { HOST_FILTERS, makeRegistry, PAGE_GLOBALS } from './test-host.helper';

/** A marker that cannot occur in escaped output, so finding it proves rawness. */
const MARKER = '<b data-probe="1">RAW</b>';

/**
 * Every position an Html value could be placed, with whether the checker is
 * required to accept it. `body` is the RichText component's body; `content` is
 * always the Html prop.
 */
const SINKS: ReadonlyArray<{ name: string; body: string; accepted: boolean; code?: string }> = [
  { name: 'element content', body: '<div>{content}</div>', accepted: true },
  { name: 'nested element content', body: '<section><article><p>{content}</p></article></section>', accepted: true },
  { name: 'inside an if', body: '<if {true}><div>{content}</div></if>', accepted: true },
  { name: 'attribute (whole expression)', body: '<div title={content}>x</div>', accepted: false, code: 'O2076' },
  { name: 'attribute (interpolated part)', body: '<div class="a {content}">x</div>', accepted: false, code: 'O2076' },
  { name: 'url attribute', body: '<a href={content}>x</a>', accepted: false, code: 'O2076' },
  { name: 'let binding', body: '<let x={content}/><p>ok</p>', accepted: false, code: 'O2079' },
  { name: 'stdlib filter operand', body: '<p>{upper(content)}</p>', accepted: false, code: 'O2063' },
  { name: 'rcdata (title)', body: '<title>{content}</title>', accepted: false, code: 'O2075' },
  { name: 'rcdata (textarea)', body: '<textarea>{content}</textarea>', accepted: false, code: 'O2075' },
  { name: 'json-ld payload', body: '<json-ld>{{"@type": "Thing", name: content}}</json-ld>', accepted: false },
];

function richTextComponent(body: string): SourceFile {
  return {
    name: 'rich-text.orbit',
    source: `---\ncomponent RichText\nprops {\n  content: Html\n}\n---\n${body}\n`,
  };
}

/** Caller page that sanitizes a bound String and passes the result along. */
const CALLER: SourceFile = {
  name: 'page.orbit',
  source: '---\npage page\n---\n<RichText content={richtext(raw)}/>\n',
};

function compile(files: readonly SourceFile[]) {
  const parsed = parseProgram(files);
  if (!parsed.ok) return { ok: false as const, codes: parsed.diagnostics.map((d) => d.code) };
  const result = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: { ...PAGE_GLOBALS, raw: { kind: 'string' } as never },
  });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  return errors.length > 0
    ? { ok: false as const, codes: errors.map((d) => d.code) }
    : { ok: true as const, program: parsed.program };
}

describe('Html across a component prop boundary', () => {
  it('is accepted in element content and rejected at every other sink', () => {
    for (const sink of SINKS) {
      const compiled = compile([CALLER, richTextComponent(sink.body)]);
      expect(compiled.ok, `${sink.name}: expected ${sink.accepted ? 'accept' : 'reject'}`).toBe(
        sink.accepted,
      );
      if (!sink.accepted && sink.code !== undefined) {
        expect(compiled.codes, sink.name).toContain(sink.code);
      }
    }
  });

  it('emits the value raw ONLY in element content, for arbitrary payloads', () => {
    // The structural half: whatever the sanitizer returns, it appears verbatim
    // in the output when the sink is element content, and the surrounding
    // markup is unchanged. If the value ever reached another sink it would be
    // escaped (marker absent) or would have broken the structure.
    const payload = fc.stringMatching(/^[ -~]{0,40}$/);
    fc.assert(
      fc.property(payload, (raw) => {
        const compiled = compile([CALLER, richTextComponent('<div>{content}</div>')]);
        expect(compiled.ok).toBe(true);
        if (!compiled.ok) return;

        const out = render(compiled.program, 'page', {
          hostFilters: HOST_FILTERS,
          bindings: { raw: raw + MARKER },
        });
        expect(out.ok).toBe(true);
        if (!out.ok) return;

        // Raw: the marker survives as markup, not as escaped text.
        expect(out.html.startsWith('<div>')).toBe(true);
        expect(out.html.endsWith('</div>')).toBe(true);
        expect(out.html).toContain(MARKER);
        expect(out.html).not.toContain('&lt;b data-probe');
      }),
      { numRuns: 200 },
    );
  });

  it('escapes the same value when it did NOT come through the Html prop', () => {
    // The control. Without this, the test above would pass even if the engine
    // emitted everything raw.
    const control: SourceFile = {
      name: 'page.orbit',
      source: '---\npage page\n---\n<div>{raw}</div>\n',
    };
    const compiled = compile([control]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const out = render(compiled.program, 'page', {
      hostFilters: HOST_FILTERS,
      bindings: { raw: MARKER },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.html).not.toContain(MARKER);
      expect(out.html).toContain('&lt;b data-probe');
    }
  });

  it('holds when the value is forwarded through a second component', () => {
    const files: SourceFile[] = [
      CALLER,
      richTextComponent('<Inner content={content}/>'),
      {
        name: 'inner.orbit',
        source: '---\ncomponent Inner\nprops {\n  content: Html\n}\n---\n<div>{content}</div>\n',
      },
    ];
    const compiled = compile(files);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const out = render(compiled.program, 'page', {
      hostFilters: HOST_FILTERS,
      bindings: { raw: MARKER },
    });
    expect(out.ok && out.html).toBe(`<div>${MARKER}</div>`);
  });

  it('holds when the value crosses into slot content', () => {
    // Slot fills render in the CALLER's scope, which is the least obvious path
    // an Html value can take and therefore the one worth pinning.
    const files: SourceFile[] = [
      {
        name: 'page.orbit',
        source:
          '---\npage page\n---\n<Panel><div slot="body">{richtext(raw)}</div></Panel>\n',
      },
      {
        name: 'panel.orbit',
        source:
          '---\ncomponent Panel\nslots {\n  body\n}\n---\n<section><slot name="body"/></section>\n',
      },
    ];
    const compiled = compile(files);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const out = render(compiled.program, 'page', {
      hostFilters: HOST_FILTERS,
      bindings: { raw: MARKER },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.html).toContain(MARKER);
  });

  it('an htmlTransform filter cannot move the value to another sink', () => {
    // A4 lets Html be a filter operand for one flagged filter. That must not
    // become a way to launder Html into an attribute.
    const compiled = compile([
      CALLER,
      richTextComponent('<div title={truncateHtml(content, 10)}>x</div>'),
    ]);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.codes).toContain('O2076');
  });
});
