/**
 * Modified by Denys Otrishko <shishugi@gmail.com>
 */

import { Observable, Subscription } from 'rxjs';
import { Disposable } from './disposable';
import { FileSystemUpdater } from './fs';
import { Logger, NoopLogger } from './logging';
import { InMemoryFileSystem } from './memfs';
import { LanguageService, MetaschemaLangService } from './service/metaschema-lang-service';
import {
  isMetaschemaFile,
  isPackageJsonFile,
  isSchemaFile,
  observableFromIterable,
  uri2path,
} from './util';

/**
 * ProjectManager translates VFS files to one or many projects denoted by [tj]config.json.
 * It uses either local or remote file system to fetch directory tree and files from and then
 * makes one or more LanguageService objects. By default all LanguageService objects contain no
 * files, they are added on demand - current file for hover or definition, project's files for
 * references and all files from all projects for workspace symbols.
 *
 * ProjectManager preserves Windows paths until passed to ProjectConfiguration or TS APIs.
 */
export class ProjectManager implements Disposable {
  /**
   * Root path with slashes
   */
  private rootPath: string;

  /**
   * Local side of file content provider which keeps cache of fetched files
   */
  private inMemoryFs: InMemoryFileSystem;

  /**
   * File system updater that takes care of updating the in-memory file system
   */
  private updater: FileSystemUpdater;

  private service!: LanguageService;

  /**
   * URI -> version map. Every time file content is about to change or changed
   * (didChange/didOpen/...), we are incrementing it's version signalling that file is changed and
   * file's user must invalidate cached and requery file content
   */
  private versions: Map<string, number>;

  private ensuredAllFiles?: Observable<never>;
  private ensuredOwnFiles?: Observable<never>;
  private ensuredBasicFiles?: Observable<never>;

  /**
   * Tracks all Subscriptions that are done in the lifetime of this object to dispose on `dispose()`
   */
  private subscriptions = new Subscription();

  /**
   * @param rootPath root path as passed to `initialize`
   * @param inMemoryFileSystem File system that keeps structure and contents in memory
   * @param updater
   * @param logger
   */
  constructor(
    rootPath: string,
    inMemoryFileSystem: InMemoryFileSystem,
    updater: FileSystemUpdater,
    protected logger: Logger = new NoopLogger()
  ) {
    this.rootPath = rootPath;
    this.updater = updater;
    this.inMemoryFs = inMemoryFileSystem;
    this.versions = new Map<string, number>();
    this.service = new MetaschemaLangService(this.inMemoryFs, this.logger);
  }

  public getService(): LanguageService {
    return this.service;
  }

  /**
   * Ensures we added basic files
   */
  public ensureBasicFiles(): Observable<never> {
    this.logger.log('Ensure basic files', this.rootPath);
    if (this.ensuredBasicFiles) return this.ensuredBasicFiles;

    this.ensuredBasicFiles = this.updater
      .ensureStructure()
      .concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
      .filter(uri => isMetaschemaFile(uri) && isSchemaFile(uri))
      .mergeMap(uri => this.updater.ensure(uri))
      .do(
        uri => this.service.updateFile(uri),
        err => {
          this.logger.error('Failed to ensure BASIC files:', err);
          this.ensuredBasicFiles = undefined;
        }
      )
      .publishReplay()
      .refCount() as Observable<never>;
    return this.ensuredBasicFiles;
  }

  /**
   * Ensures a single file is available to the LanguageServiceHost
   * filePath must already be present in inMemoryFs
   *
   * @param filePath full path to the file
   */
  public ensureSourceFile(filePath: string): boolean {
    return this.service.updateFile(filePath);
  }

  /**
   * Disposes the object (removes all registered listeners)
   */
  public dispose(): void {
    this.subscriptions.unsubscribe();
  }

  /**
   * @return root path (as passed to `initialize`)
   */
  public getRemoteRoot(): string {
    return this.rootPath;
  }

  /**
   * @return local side of file content provider which keeps cached copies of fethed files
   */
  public getFs(): InMemoryFileSystem {
    return this.inMemoryFs;
  }

  /**
   * @param filePath file path (both absolute or relative file paths are accepted)
   * @return true if there is a fetched file with a given path
   */
  public hasFile(filePath: string): boolean {
    return this.inMemoryFs.fileExists(filePath);
  }

  /**
   * Invalidates caches for `ensureAllFiles` and `ensureOwnFiles`
   */
  public invalidateModuleStructure(): void {
    this.ensuredAllFiles = undefined;
    this.ensuredBasicFiles = undefined;
    this.ensuredOwnFiles = undefined;
  }

  /**
   * Ensures all files not in node_modules were fetched.
   * This includes all schema files and package.json files.
   * Invalidates project configurations after execution
   */
  public ensureOwnFiles(): Observable<never> {
    this.logger.log('Ensure own files', this.rootPath);
    if (this.ensuredOwnFiles) return this.ensuredOwnFiles;

    this.ensuredOwnFiles = this.updater
      .ensureStructure()
      .concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
      .filter(
        uri => (!uri.includes('/node_modules/') && isSchemaFile(uri)) || isPackageJsonFile(uri)
      )
      .mergeMap(uri => this.updater.ensure(uri))
      .do(
        uri => this.service.updateFile(uri),
        err => {
          this.logger.error('Failed to ensure OWN files:', err);
          this.ensuredOwnFiles = undefined;
        }
      )
      .publishReplay()
      .refCount() as Observable<never>;
    return this.ensuredOwnFiles;
  }

  /**
   * Ensures all files were fetched from the remote file system.
   * Invalidates project configurations after execution
   */
  public ensureAllFiles(): Observable<never> {
    this.logger.log('Ensure all files', this.rootPath);
    if (!this.ensuredAllFiles) {
      this.ensuredAllFiles = this.updater
        .ensureStructure()
        .concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
        .filter(uri => isSchemaFile(uri) || isPackageJsonFile(uri))
        .mergeMap(uri => this.updater.ensure(uri))
        .do(
          uri => this.service.updateFile(uri),
          err => {
            this.logger.error('Failed to ensure ALL files:',  err);
            this.ensuredAllFiles = undefined;
          }
        )
        .publishReplay()
        .refCount() as Observable<never>;
    }
    return this.ensuredAllFiles;
  }

  /**
   * Called when file was opened by client. Current implementation
   * does not differentiates open and change events
   * @param uri file's URI
   * @param text file's content
   */
  public didOpen(uri: string, text: string): void {
    this.didChange(uri, text);
  }
  /**
   * Called when file was closed by client.
   * @param uri file's URI
   */
  public didClose(uri: string): void {
    const filePath = uri2path(uri);
    this.inMemoryFs.didClose(uri);
    let version = this.versions.get(uri) || 0;
    this.versions.set(uri, ++version);
    this.service.updateFile(filePath);
  }

  /**
   * Called when file was changed by client.
   *
   * @param uri file's URI
   * @param text file's content
   */
  public didChange(uri: string, text: string): void {
    const filePath = uri2path(uri);
    this.inMemoryFs.didChange(uri, text);
    let version = this.versions.get(uri) || 0;
    this.versions.set(uri, ++version);
    this.service.updateFile(filePath);
  }

  /**
   * Called when file was saved by client
   * @param uri file's URI
   */
  public didSave(uri: string): void {
    this.inMemoryFs.didSave(uri);
  }
}
