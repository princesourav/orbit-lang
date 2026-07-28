/**
 * Orbit language server — the protocol shell.
 *
 * All behaviour lives in `analysis.mjs`, which is pure and tested. This file
 * is transport: it wires LSP requests to those functions and does nothing else.
 * The split exists because an LSP server is otherwise almost untestable, and
 * "the language server works" is not a claim worth making on inspection alone.
 *
 * Compile-only: the server parses, checks and formats. It never renders, and it
 * never invokes a host filter. See the note at the top of `analysis.mjs`.
 */
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { complete, diagnose, format, hover, wordAt } from './analysis.mjs';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasProjectHost = false;

connection.onInitialize((params) => {
  hasProjectHost = params.initializationOptions?.hasProjectHost === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['<', '{', '>', ' '] },
      hoverProvider: true,
      documentFormattingProvider: true,
    },
    serverInfo: { name: 'orbit-language-server', version: '0.5.0' },
  };
});

documents.onDidChangeContent((change) => {
  const name = change.document.uri.split('/').pop() ?? 'buffer.orbit';
  connection.sendDiagnostics({
    uri: change.document.uri,
    diagnostics: diagnose(change.document.getText(), { name, hasProjectHost }),
  });
});

/** Text from the start of the cursor's line up to the cursor. */
function linePrefixAt(document, position) {
  return document.getText({
    start: { line: position.line, character: 0 },
    end: position,
  });
}

/** The whole line the cursor is on. */
function lineAt(document, position) {
  return document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
}

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) return [];
  return complete(document.getText(), linePrefixAt(document, params.position));
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) return null;

  const line = lineAt(document, params.position);
  const word = wordAt(line, params.position.character);
  if (word === undefined) return null;

  // The prefix up to the START of the word is what tells hover whether this is
  // a tag position — see the note on `hover`.
  const wordStart = line.lastIndexOf(word, params.position.character);
  const prefix = wordStart <= 0 ? '' : line.slice(0, wordStart);

  const contents = hover(document.getText(), word, prefix);
  return contents === undefined ? null : { contents: { kind: 'markdown', value: contents } };
});

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) return [];

  const formatted = format(document.getText());
  // Undefined means the buffer does not parse. Returning no edits leaves it
  // alone; the diagnostics already explain why.
  if (formatted === undefined) return [];

  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: document.lineCount, character: 0 },
      },
      newText: formatted,
    },
  ];
});

documents.listen(connection);
connection.listen();
