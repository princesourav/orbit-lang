/**
 * Expression-island token model. The template surface itself is scanned
 * character-by-character by the parser (HTML-strict trees are not usefully
 * tokenizable as a flat stream); everything inside `{ ... }` and the
 * frontmatter header is lexed into these tokens.
 */
import { type Span } from './diagnostics';

export type TokenKind =
  | 'ident'
  | 'int'
  | 'float'
  | 'string'
  | 'color'
  | 'punct'
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** Raw text for ident/punct; decoded value for string; digits for numbers. */
  text: string;
  span: Span;
}

/** Longest-first so the lexer can match greedily with plain startsWith. */
export const PUNCTUATORS: readonly string[] = [
  '|>',
  '??',
  '?.',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '..',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
  '?',
  '=',
];
