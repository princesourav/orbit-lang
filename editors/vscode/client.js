/**
 * VS Code extension entry point.
 *
 * Thin by design: it starts the language server in `../lsp/server.mjs` and
 * forwards configuration. All behaviour lives in the server, so Neovim, Zed and
 * Helix get exactly the same features by pointing at the same binary — an
 * extension that reimplemented anything here would make VS Code the only
 * editor where Orbit worked properly.
 */
const path = require('node:path');
const { workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const serverModule = context.asAbsolutePath(path.join('..', 'lsp', 'server.mjs'));

  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const config = workspace.getConfiguration('orbit');

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'orbit' }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.orbit'),
    },
    initializationOptions: {
      // Off by default. Without a project host the server cannot know the
      // object model, and reporting every data reference as unknown would bury
      // the diagnostics that are actionable.
      hasProjectHost: config.get('hasProjectHost', false),
    },
  };

  client = new LanguageClient('orbit', 'Orbit Language Server', serverOptions, clientOptions);
  client.start();
  context.subscriptions.push(client);
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
