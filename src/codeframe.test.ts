import { describe, expect, it } from 'vitest';
import {
  codeFrame,
  formatDiagnostic,
  formatDiagnostics,
  formatDiagnosticWithSource,
  splitSourceLines,
  type Diagnostic,
  type Span,
} from './diagnostics';

/**
 * Tests for the code-frame renderer.
 *
 * For a language whose entire pitch is "the compiler catches this", the error
 * output IS the product surface — so these tests assert on rendered text
 * fairly aggressively. Where a test pins exact output it is because a human
 * has to read that output, and silent regressions in alignment or caret
 * placement are exactly the kind of thing that degrades unnoticed.
 */

function span(
  line: number,
  col: number,
  endLine = line,
  endCol = col + 1,
): Span {
  // `offset` is required by `Pos` but the code frame locates spans by
  // line/col, so a stable placeholder keeps these fixtures readable.
  return {
    start: { line, col, offset: 0 },
    end: { line: endLine, col: endCol, offset: 0 },
  };
}

/** The caret run of a frame line, with the gutter (`NN | `) stripped. */
function caretMarks(line: string): string {
  const bar = line.indexOf('|');
  return line.slice(bar + 1).trim();
}

/**
 * Display columns a string occupies, counting East-Asian wide glyphs as two.
 *
 * Alignment is a property of rendered *columns*, not of string indices, so
 * comparing `indexOf` between the source line and the caret line silently
 * "passes" only for pure-ASCII input. These helpers keep the assertions
 * honest for the cases that actually exercise the width logic.
 */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Display column at which `marker` begins, after the gutter. */
function columnOf(line: string, marker: string): number {
  const bar = line.indexOf('|');
  const body = line.slice(bar + 1);
  return displayWidth(body.slice(0, body.indexOf(marker)));
}

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'O1053',
    severity: 'error',
    message: 'unescaped "<" in text',
    template: 'product-card.orbit',
    span: span(2, 12),
    ...over,
  };
}

describe('splitSourceLines', () => {
  it('splits on \\n and keeps a trailing empty line', () => {
    expect(splitSourceLines('a\nb\n')).toEqual(['a', 'b', '']);
  });

  it('numbers CRLF files identically to LF and drops the \\r for display', () => {
    // The Scanner counts lines by '\n' alone, so a file that differs only in
    // line endings must produce identical line numbers — otherwise every
    // diagnostic in a CRLF file would point at the wrong place.
    const lf = splitSourceLines('one\ntwo\nthree');
    const crlf = splitSourceLines('one\r\ntwo\r\nthree');
    expect(crlf).toEqual(lf);
    expect(crlf[1]).toBe('two');
  });

  it('handles a file with no newline at all', () => {
    expect(splitSourceLines('solo')).toEqual(['solo']);
  });

  it('handles the empty string as one empty line', () => {
    expect(splitSourceLines('')).toEqual(['']);
  });
});

describe('codeFrame', () => {
  it('puts the caret under the exact span, not just its start', () => {
    const src = 'line one\n  <p>oops</p>\n';
    const frame = codeFrame(src, span(2, 3, 2, 6));
    expect(frame).toBeDefined();
    const lines = frame!.split('\n');
    const sourceLine = lines.find((l) => l.includes('<p>'))!;
    const caretLine = lines[lines.indexOf(sourceLine) + 1]!;
    // Three carets for a three-column span (cols 3,4,5).
    expect(caretLine).toContain('^^^');
    expect(caretLine).not.toContain('^^^^');
    // The caret run starts under the '<'.
    expect(caretLine.indexOf('^')).toBe(sourceLine.indexOf('<'));
  });

  it('renders a single-column span as one caret', () => {
    const frame = codeFrame('abc\n', span(1, 2, 1, 3))!;
    const caretLine = frame.split('\n').find((l) => l.includes('^'))!;
    // The line still carries its gutter, so assert on what follows the bar.
    expect(caretMarks(caretLine)).toBe('^');
  });

  it('aligns the gutter to the widest line number', () => {
    const src = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
    const frame = codeFrame(src, span(100, 1, 100, 5))!;
    // Line 100 is three digits, so every gutter cell is at least three wide
    // and the bars line up in a single column.
    const barColumns = new Set(
      frame
        .split('\n')
        .filter((l) => l.includes('|'))
        .map((l) => l.indexOf('|')),
    );
    expect(barColumns.size).toBe(1);
  });

  it('places the label next to the caret when it fits', () => {
    const frame = codeFrame('  <p>x</p>\n', span(1, 3, 1, 6), 'write {"<"} instead')!;
    expect(frame).toContain('write {"<"} instead');
    const caretLine = frame.split('\n').find((l) => l.includes('^'))!;
    expect(caretLine).toContain('write {"<"} instead');
  });

  it('expands tabs so the caret still lands under the right character', () => {
    // A literal tab is one column to the Scanner but renders as several, so a
    // naive renderer puts the caret in the wrong place on tab-indented files.
    const src = '\t\t<p>bad</p>\n';
    const frame = codeFrame(src, span(1, 3, 1, 6), undefined, { tabWidth: 4 })!;
    const lines = frame.split('\n');
    const sourceLine = lines.find((l) => l.includes('<p>'))!;
    const caretLine = lines[lines.indexOf(sourceLine) + 1]!;
    expect(sourceLine).not.toContain('\t');
    expect(caretLine.indexOf('^')).toBe(sourceLine.indexOf('<'));
  });

  it('windows a very long line around the span instead of dumping it whole', () => {
    const long = 'x'.repeat(400) + 'NEEDLE' + 'y'.repeat(400);
    const frame = codeFrame(long, span(1, 401, 1, 407), undefined, { maxWidth: 60 })!;
    for (const line of frame.split('\n')) {
      // Allow generous slack for the gutter, but the 800-char line must not
      // be emitted in full.
      expect(line.length).toBeLessThan(120);
    }
    expect(frame).toContain('NEEDLE');
  });

  it('shows context lines when asked', () => {
    const src = 'a\nb\nc\nd\ne\n';
    const frame = codeFrame(src, span(3, 1, 3, 2), undefined, { contextLines: 1 })!;
    expect(frame).toContain('b');
    expect(frame).toContain('c');
    expect(frame).toContain('d');
    expect(frame).not.toContain('a');
    expect(frame).not.toContain('e');
  });

  it('renders a multi-line span', () => {
    const src = '<div\n  class="x"\n  id="y">\n';
    const frame = codeFrame(src, span(1, 1, 3, 8))!;
    expect(frame).toContain('<div');
    expect(frame).toContain('id="y"');
  });

  it('elides the middle of a very tall span', () => {
    const src = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const frame = codeFrame(src, span(1, 1, 40, 5), undefined, { maxSpanLines: 3 })!;
    expect(frame.split('\n').length).toBeLessThan(20);
  });

  it('keeps wide characters aligned', () => {
    // East-Asian wide glyphs occupy two display columns; if the renderer
    // measures in code units the caret drifts left.
    const src = '日本語のテキスト <p>x</p>\n';
    const frame = codeFrame(src, span(1, 10, 1, 13))!;
    const lines = frame.split('\n');
    const sourceLine = lines.find((l) => l.includes('<p>'))!;
    const caretLine = lines[lines.indexOf(sourceLine) + 1]!;
    // Eight wide glyphs occupy sixteen columns, so the caret line must contain
    // MORE padding characters than the source line has code units — comparing
    // raw indices here would assert the bug rather than the fix.
    expect(columnOf(caretLine, '^')).toBe(columnOf(sourceLine, '<p>'));
    expect(caretLine.indexOf('^')).toBeGreaterThan(sourceLine.indexOf('<p>'));
    expect(caretMarks(caretLine)).toBe('^^^');
  });

  it('returns undefined when the span cannot be located', () => {
    expect(codeFrame('', span(50, 1))).toBeUndefined();
    expect(codeFrame('one line\n', span(99, 1))).toBeUndefined();
  });

  it('emits no ANSI escapes by default and escapes only when asked', () => {
    const plain = codeFrame('abc\n', span(1, 1, 1, 2))!;
    expect(plain).not.toContain('[');
    const colored = codeFrame('abc\n', span(1, 1, 1, 2), undefined, { color: true })!;
    expect(colored).toContain('[');
  });

  it('clamps nonsense options rather than throwing', () => {
    const frame = codeFrame('abc\n', span(1, 1, 1, 2), undefined, {
      contextLines: -5,
      tabWidth: 0,
      maxWidth: 1,
      maxSpanLines: 0,
    });
    expect(frame).toBeDefined();
  });
});

describe('formatDiagnosticWithSource', () => {
  it('renders the full rustc-style shape', () => {
    const src = '---\ncomponent Card\n---\n<p>Price < 100</p>\n';
    const d = diag({
      span: span(4, 12, 4, 13),
      message: 'unescaped "<" in text',
      suggestion: 'write {"<"} to emit a literal',
    });
    const out = formatDiagnosticWithSource(d, src);

    expect(out).toContain('error[O1053]: unescaped "<" in text');
    expect(out).toContain('--> product-card.orbit:4:12');
    expect(out).toContain('<p>Price < 100</p>');
    expect(out).toContain('^');
    expect(out).toContain('write {"<"} to emit a literal');
  });

  it('marks warnings as warnings, not errors', () => {
    const out = formatDiagnosticWithSource(
      diag({ severity: 'warning', code: 'O2071', message: 'unsafeHtml filter' }),
      'a\nbcdefghijklmno\n',
    );
    expect(out).toContain('warning[O2071]');
    expect(out).not.toContain('error[');
  });

  it('falls back to the location-only format when there is no span', () => {
    const d = diag({ span: undefined });
    expect(formatDiagnosticWithSource(d, 'irrelevant')).toBe(formatDiagnostic(d));
  });

  it('falls back when the span does not resolve in the given source', () => {
    // A diagnostic carried alongside a stored AST has a span but no source.
    const d = diag({ span: span(999, 1) });
    expect(formatDiagnosticWithSource(d, 'short\n')).toBe(formatDiagnostic(d));
  });

  it('does not lose the suggestion when it cannot sit inline', () => {
    const d = diag({
      span: span(1, 1, 1, 2),
      suggestion: 'x'.repeat(200),
    });
    const out = formatDiagnosticWithSource(d, 'a\n');
    expect(out).toContain('help:');
    expect(out).toContain('x'.repeat(200));
  });
});

describe('formatDiagnostics', () => {
  it('renders every diagnostic in a batch, in order', () => {
    const sources = new Map([['a.orbit', 'one\ntwo\nthree\n']]);
    const out = formatDiagnostics(
      [
        diag({ template: 'a.orbit', code: 'O1001', span: span(1, 1, 1, 2) }),
        diag({ template: 'a.orbit', code: 'O1002', span: span(3, 1, 3, 2) }),
      ],
      sources,
    );
    expect(out.indexOf('O1001')).toBeLessThan(out.indexOf('O1002'));
    expect(out).toContain('one');
    expect(out).toContain('three');
  });

  it('degrades a diagnostic to location-only rather than dropping it when its source is missing', () => {
    // Losing a diagnostic because the CLI could not read one file would be far
    // worse than showing it without an excerpt.
    const out = formatDiagnostics([diag({ template: 'missing.orbit' })], new Map());
    expect(out).toContain('O1053');
    expect(out).toContain('missing.orbit');
  });

  it('returns an empty string for no diagnostics', () => {
    expect(formatDiagnostics([], new Map())).toBe('');
  });
});
