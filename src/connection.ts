/**
 * Modified by Denys Otrishko <shishugi@gmail.com>
 */

import { EventEmitter } from 'events';
import { applyReducer, Operation } from 'fast-json-patch';
import { camelCase, omit } from 'lodash';
import { Observable, Subscription, Symbol } from 'rxjs';
import {
  ErrorCodes,
  Message,
  StreamMessageReader as VSCodeStreamMessageReader,
  StreamMessageWriter as VSCodeStreamMessageWriter,
} from 'vscode-jsonrpc';
import {
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  NotificationMessage,
  RequestMessage,
  ResponseMessage,
} from 'vscode-jsonrpc/lib/messages';
import { Logger, NoopLogger } from './logging';
import { MetaschemaService } from './metaschema-service';
import { InitializeParams, PartialResultParams } from './request-type';

/**
 * Interface for JSON RPC messages with tracing metadata
 */
export interface HasMeta {
  meta: { [key: string]: any };
}

/**
 * Returns true if the passed argument has a meta field
 */
export function hasMeta(candidate: any): candidate is HasMeta {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.meta === 'object' &&
    candidate.meta !== null
  );
}

/**
 * Returns true if the passed argument is an object with a `.then()` method
 */
function isPromiseLike(candidate: any): candidate is PromiseLike<any> {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.then === 'function'
  );
}

/**
 * Returns true if the passed argument is an object with a
 * `[Symbol.observable]` method
 */
function isObservable(candidate: any): candidate is Observable<any> {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate[Symbol.observable] === 'function'
  );
}

export interface MessageLogOptions {
  /** Logger to use */
  logger?: Logger;

  /** Whether to log all messages */
  logMessages?: boolean;
}

/**
 * Takes a NodeJS ReadableStream and emits parsed messages received on the
 * stream. In opposite to StreamMessageReader, supports multiple listeners and
 * is compatible with Observables
 */
export class MessageEmitter extends EventEmitter {
  constructor(input: NodeJS.ReadableStream, options: MessageLogOptions = {}) {
    super();
    const reader = new VSCodeStreamMessageReader(input);
    // Forward events
    reader.listen(msg => {
      this.emit('message', msg);
    });
    reader.onError(err => {
      this.emit('error', err);
    });
    reader.onClose(() => {
      this.emit('close');
    });
    this.setMaxListeners(Infinity);
    // Register message listener to log messages if configured
    if (options.logMessages && options.logger) {
      const logger = options.logger;
      this.on('message', message => logger.log('-->', message));
    }
  }

  /** Emitted when a new JSON RPC message was received on the input stream */
  public on(event: 'message', listener: (message: Message) => void): this;
  /** Emitted when the underlying input stream emitted an error */
  public on(event: 'error', listener: (error: Error) => void): this;
  /** Emitted when the underlying input stream was closed */
  public on(event: 'close', listener: () => void): this;
  /* istanbul ignore next */
  public on(event: string, listener: (arg?: any) => void): this {
    return super.on(event, listener);
  }

  /** Emitted when a new JSON RPC message was received on the input stream */
  public once(event: 'message', listener: (message: Message) => void): this;
  /** Emitted when the underlying input stream emitted an error */
  public once(event: 'error', listener: (error: Error) => void): this;
  /** Emitted when the underlying input stream was closed */
  public once(event: 'close', listener: () => void): this;
  /* istanbul ignore next */
  public once(event: string, listener: (arg?: any) => void): this {
    return super.on(event, listener);
  }
}

/**
 * Wraps vscode-jsonrpcs StreamMessageWriter to support logging messages,
 * decouple our code from the vscode-jsonrpc module and provide a more
 * consistent event API
 */
export class MessageWriter {
  private logger: Logger;
  private logMessages: boolean;
  private vscodeWriter: VSCodeStreamMessageWriter;

  /**
   * @param output The output stream to write to (e.g. STDOUT or a socket)
   * @param options
   */
  constructor(output: NodeJS.WritableStream, options: MessageLogOptions = {}) {
    this.vscodeWriter = new VSCodeStreamMessageWriter(output);
    this.logger = options.logger || new NoopLogger();
    this.logMessages = !!options.logMessages;
  }

  /**
   * Writes a JSON RPC message to the output stream.
   * Logs it if configured
   *
   * @param message A complete JSON RPC message object
   */
  public write(
    message: RequestMessage | NotificationMessage | ResponseMessage
  ): void {
    if (this.logMessages) {
      this.logger.log('<--', message);
    }
    this.vscodeWriter.write(message);
  }
}

export interface RegisterLanguageHandlerOptions {
  logger?: Logger;
}

/**
 * Registers all method implementations of a LanguageHandler on a connection
 *
 * @param messageEmitter MessageEmitter to listen on
 * @param messageWriter MessageWriter to write to
 * @param handler MetaschemaService object that contains methods for all methods
 *                to be handled
 * @param options
 */
export function registerLanguageHandler(
  messageEmitter: MessageEmitter,
  messageWriter: MessageWriter,
  handler: MetaschemaService,
  options: RegisterLanguageHandlerOptions = {}
): void {
  const logger = options.logger || new NoopLogger();

  const subscriptions = new Map<string | number, Subscription>();

  /**
   * Whether the handler is in an initialized state.
   * `initialize` sets this to true, `shutdown` to false.
   * Used to determine whether a manual `shutdown` call is needed on error/close
   */
  let initialized = false;

  /** Whether the client supports streaming with $/partialResult */
  let streaming: boolean = false;

  messageEmitter.on('message', async message => {
    // Ignore responses
    if (isResponseMessage(message)) {
      return;
    }
    if (!isRequestMessage(message) && !isNotificationMessage(message)) {
      logger.error('Received invalid message:', message);
      return;
    }
    switch (message.method) {
      case 'initialize':
        initialized = true;
        streaming =
          (message.params as InitializeParams).capabilities.streaming || false;
        break;
      case 'shutdown':
        initialized = false;
        break;
      case 'exit':
        // Ignore exit notification, it's not the responsibility of the
        // MetaschemaService to handle it, but the TCP / STDIO server which
        // needs to close the socket or kill the process
        for (const subscription of subscriptions.values()) {
          subscription.unsubscribe();
        }
        return;
      case '$/cancelRequest':
        // Cancel another request by unsubscribing from the Observable
        const subscription = subscriptions.get(message.params.id);
        if (!subscription) {
          logger.warn(
            `$/cancelRequest for unknown request ID ${message.params.id}`
          );
          return;
        }
        subscription.unsubscribe();
        subscriptions.delete(message.params.id);
        messageWriter.write({
          jsonrpc: '2.0',
          id: message.params.id,
          error: {
            message: 'Request cancelled',
            code: ErrorCodes.RequestCancelled,
          },
        });
        return;
    }
    const method = camelCase(message.method);
    if (typeof (handler as any)[method] !== 'function') {
      // Method not implemented
      if (isRequestMessage(message)) {
        messageWriter.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: ErrorCodes.MethodNotFound,
            message: `Method ${method} not implemented`,
          },
        });
      } else {
        logger.warn(`Method ${method} not implemented`);
      }
      return;
    }
    let observable: Observable<Operation>;
    try {
      // Convert return value to Observable
      const returnValue = (handler as any)[method](message.params);
      if (isObservable(returnValue)) {
        observable = returnValue;
      } else if (isPromiseLike(returnValue)) {
        observable = Observable.from(returnValue);
      } else {
        observable = Observable.of(returnValue);
      }
    } catch (err) {
      observable = Observable.throw(err);
    }
    if (isRequestMessage(message)) {
      const subscription = observable
        .do(patch => {
          if (!streaming) return;
          // Send $/partialResult for partial result patches only if client
          // supports it
          messageWriter.write({
            jsonrpc: '2.0',
            method: '$/partialResult',
            params: {
              id: message.id,
              patch: [patch],
            } as PartialResultParams,
          });
        })
        // Build up final result for BC
        // TODO send null if client declared streaming capability
        .reduce<Operation, any>(applyReducer, null)
        .finally(() => {
          // Delete subscription from Map
          // Make sure to not run this before subscription.set() was called
          // (in case the Observable is synchronous)
          process.nextTick(() => {
            subscriptions.delete(message.id);
          });
        })
        .subscribe(
          result => {
            // Send final result
            messageWriter.write({
              jsonrpc: '2.0',
              id: message.id,
              result,
            });
          },
          err => {
            logger.error(
              `Handler for ${message.method} failed:`,
              err,
              '\nMessage:',
              message
            );
            // Send error response
            messageWriter.write({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                message: err.message + '',
                code:
                  typeof err.code === 'number'
                    ? err.code
                    : ErrorCodes.UnknownErrorCode,
                data: omit(err, ['message', 'code']),
              },
            });
          }
        );
      // Save subscription for $/cancelRequest
      subscriptions.set(message.id, subscription);
    } else {
      // For notifications, still subscribe and log potential error
      observable.subscribe(undefined, err => {
        logger.error(`Handle ${method}:`, err);
      });
    }
  });

  // On stream close, shutdown handler if it was initialized
  messageEmitter.once('close', () => {
    // Cancel all outstanding requests
    for (const subscription of subscriptions.values()) {
      subscription.unsubscribe();
    }
    if (initialized) {
      initialized = false;
      logger.error('Stream was closed without shutdown notification');
      handler.shutdown();
    }
  });

  // On stream error, shutdown handler if it was initialized
  messageEmitter.once('error', err => {
    // Cancel all outstanding requests
    for (const subscription of subscriptions.values()) {
      subscription.unsubscribe();
    }
    if (initialized) {
      initialized = false;
      logger.error('Stream:', err);
      handler.shutdown();
    }
  });
}
