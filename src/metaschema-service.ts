/**
 * Modified by Denys Otrishko <shishugi@gmail.com>
 */

import { Operation } from 'fast-json-patch';
import { merge } from 'lodash';
import { Observable } from 'rxjs';
import {
  CodeActionParams,
  Command,
  CompletionItemKind,
  CompletionList,
  DidChangeConfigurationParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DidSaveTextDocumentParams,
  DocumentSymbolParams,
  ExecuteCommandParams,
  Hover,
  InsertTextFormat,
  Location,
  MarkedString,
  ParameterInformation,
  ReferenceParams,
  RenameParams,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import { FileSystem, FileSystemUpdater, LocalFileSystem, RemoteFileSystem } from './fs';
import { LanguageClient } from './lang-handler';
import { Logger, LSPLogger } from './logging';
import { InMemoryFileSystem } from './memfs';
import { PackageManager } from './packages';
import { ProjectManager } from './project-manager';
import {
  CompletionItem,
  DependencyReference,
  InitializeParams,
  InitializeResult,
  PackageDescriptor,
  PackageInformation,
  ReferenceInformation,
  SymbolDescriptor,
  SymbolLocationInformation,
  WorkspaceReferenceParams,
  WorkspaceSymbolParams,
} from './request-type';
import {
  isSchemaFile,
  normalizeUri,
  path2uri,
  uri2path,
} from './util';

export interface MetaschemaServiceOptions {
  strict: boolean;
}

export type MetaschemaServiceFactory = (
  client: LanguageClient,
  options?: MetaschemaServiceOptions
) => MetaschemaService;

export interface FormatCodeSettings {
  tabSize: number;
  indentSize: number;
  newLine: string;
}

/**
 * Settings synced through `didChangeConfiguration`
 */
export interface Settings {
  format: FormatCodeSettings;
}

/**
 * Handles incoming requests and return responses. There is a one-to-one-to-one
 * correspondence between TCP connection, MetaschemaService instance, and
 * language workspace. MetaschemaService caches data from the compiler across
 * requests. The lifetime of the MetaschemaService instance is tied to the
 * lifetime of the TCP connection, so its caches are deleted after the
 * connection is torn down.
 *
 * Methods are camelCase versions of the LSP spec methods and dynamically
 * dispatched. Methods not to be exposed over JSON RPC are prefixed with an
 * underscore.
 */
export class MetaschemaService {
  public projectManager!: ProjectManager;

  /**
   * The rootPath as passed to `initialize` or converted from `rootUri`
   */
  public root!: string;

  /**
   * The root URI as passed to `initialize` or converted from `rootPath`
   */
  protected rootUri!: string;

  /**
   * The remote (or local), asynchronous, file system to fetch files from
   */
  protected fileSystem!: FileSystem;

  /**
   * Holds file contents and workspace structure in memory
   */
  protected inMemoryFileSystem!: InMemoryFileSystem;

  /**
   * Syncs the remote file system with the in-memory file system
   */
  protected updater!: FileSystemUpdater;

  /**
   * Keeps track of package.jsons in the workspace
   */
  protected packageManager!: PackageManager;

  /**
   * Settings synced though `didChangeConfiguration`
   */
  protected settings: Settings = {
    format: {
      tabSize: 2,
      indentSize: 2,
      newLine: '\n',
    },
  };

  protected logger: Logger;

  /**
   * Cached response for empty workspace/symbol query
   */
  private emptyQueryWorkspaceSymbols!: Observable<Operation>;

  constructor(
    protected client: LanguageClient,
    protected options: MetaschemaServiceOptions = {
      strict: false,
    }
  ) {
    this.logger = new LSPLogger(client);
  }

  /**
   * The initialize request is sent as the first request from the client to the server. If the
   * server receives request or notification before the `initialize` request it should act as
   * follows:
   *
   * - for a request the respond should be errored with `code: -32002`. The message can be picked by
   * the server.
   * - notifications should be dropped, except for the exit notification. This will allow the exit a
   * server without an initialize request.
   *
   * Until the server has responded to the `initialize` request with an `InitializeResult` the
   * client must not sent any additional requests or notifications to the server.
   *
   * During the `initialize` request the server is allowed to sent the notifications
   * `window/showMessage`, `window/logMessage` and `telemetry/event` as well as the
   * `window/showMessageRequest` request to the client.
   *
   * @return Observable of JSON Patches that build an `InitializeResult`
   */
  public initialize(params: InitializeParams): Observable<Operation> {
    if (params.rootUri || params.rootPath) {
      this.root = params.rootPath || uri2path(params.rootUri!);
      this.rootUri = params.rootUri || path2uri(params.rootPath!);

      // The root URI always refers to a directory
      if (!this.rootUri.endsWith('/')) {
        this.rootUri += '/';
      }
      this._initializeFileSystems(
        !this.options.strict &&
          !(params.capabilities.xcontentProvider && params.capabilities.xfilesProvider)
      );
      this.updater = new FileSystemUpdater(this.fileSystem, this.inMemoryFileSystem, this.logger);
      this.projectManager =
        new ProjectManager(this.root, this.inMemoryFileSystem, this.updater, this.logger);
      this.packageManager = new PackageManager(this.updater, this.inMemoryFileSystem, this.logger);
      const normRootUri = this.rootUri.endsWith('/') ? this.rootUri : this.rootUri + '/';
      const rootPackageJsonUri = normRootUri + 'package.json';
      this.packageManager.getPackageJson(rootPackageJsonUri);
      Observable.zip(this.projectManager.ensureBasicFiles(), this.projectManager.ensureOwnFiles())
        .subscribe(undefined, err => {
          this.logger.error(err);
        });
    }
    const result: InitializeResult = {
      // disable everything but completionProvider for now
      capabilities: {
        // Tell the client that the server works in FULL text document sync mode
        textDocumentSync: TextDocumentSyncKind.Full,
        hoverProvider: false,
        signatureHelpProvider: {
          triggerCharacters: [],
          // triggerCharacters: ['(', ','],
        },
        definitionProvider: false,
        typeDefinitionProvider: false,
        referencesProvider: false,
        documentSymbolProvider: false,
        workspaceSymbolProvider: false,
        xworkspaceReferencesProvider: false,
        xdefinitionProvider: false,
        xdependenciesProvider: false,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: ['.'],
        },
        codeActionProvider: false,
        renameProvider: false,
        executeCommandProvider: {
          commands: [],
        },
        xpackagesProvider: false,
      },
    };
    return Observable.of({
      op: 'add',
      path: '',
      value: result,
    } as Operation);
  }

  /**
   * The shutdown request is sent from the client to the server. It asks the server to shut down,
   * but to not exit (otherwise the response might not be delivered correctly to the client).
   * There is a separate exit notification that asks the server to exit.
   *
   * @return Observable of JSON Patches that build a `null` result
   */
  public shutdown(): Observable<Operation> {
    this.projectManager.dispose();
    this.packageManager.dispose();
    return Observable.of({ op: 'add', path: '', value: null } as Operation);
  }

  /**
   * A notification sent from the client to the server to signal the change of configuration
   * settings.
   */
  public workspaceDidChangeConfiguration(params: DidChangeConfigurationParams): void {
    merge(this.settings, params.settings);
  }

  /**
   * The Completion request is sent from the client to the server to compute completion items at a
   * given cursor position. Completion items are presented in the
   * [IntelliSense](https://code.visualstudio.com/docs/editor/editingevolved#_intellisense) user
   * interface. If computing full completion items is expensive, servers can additionally provide
   * a handler for the completion item resolve request ('completionItem/resolve'). This request is
   * sent when a completion item is selected in the user interface. A typically use case is for
   * example: the 'textDocument/completion' request doesn't fill in the `documentation` property
   * for returned completion items since it is expensive to compute. When the item is selected in
   * the user interface then a 'completionItem/resolve' request is sent with the selected
   * completion item as a param. The returned completion item should have the documentation
   * property filled in.
   *
   * @return Observable of JSON Patches that build a `CompletionList` result
   */
  public textDocumentCompletion(params: TextDocumentPositionParams): Observable<Operation> {
    const uri = normalizeUri(params.textDocument.uri);

    return this.projectManager
      // Ensure files needed to suggest completions are fetched
      .ensureOwnFiles()
      .toArray()
      .mergeMap(() => {
        const filePath: string = uri2path(uri);

        if (!this.projectManager.ensureSourceFile(filePath)) {
          return [];
        }

        const completions = this.projectManager
          .getService()
          .getCompletionsAtPosition(filePath, params.position.line, params.position.character);

        if (!completions) {
          return [];
        }

        return Observable.from(completions)
          .map(entry => {
            // context for future resolve requests:
            entry.data = {
              uri,
              line: params.position.line,
              character: params.position.character,
              entryName: entry.label,
            };
            return { op: 'add', path: '/items/-', value: entry } as Operation;
          })
          .startWith({
            op: 'add',
            path: '/isIncomplete',
            value: false,
          } as Operation);
      })
      .startWith({
        op: 'add',
        path: '',
        value: { isIncomplete: true, items: [] } as CompletionList,
      } as Operation);
  }

  /**
   * Initializes the remote file system and in-memory file system.
   * Can be overridden
   *
   * @param accessDisk Whether the language server is allowed to access the local file system
   */
  protected _initializeFileSystems(accessDisk: boolean): void {
    this.fileSystem = accessDisk
      ? new LocalFileSystem(this.rootUri)
      : new RemoteFileSystem(this.client);
    this.inMemoryFileSystem = new InMemoryFileSystem(
      this.root,
      uri =>
        isSchemaFile(uri) && (uri.includes('/taxonomy/') || uri.includes('/schema/')),
      this.logger
    );
  }
}
