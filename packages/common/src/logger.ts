/**
 * Enbox logger level.
 */
export enum LogLevel {
  Debug = 'debug',
  Silent = 'silent',
}

/**
 * Enbox logger interface.
 */
export interface LoggerInterface {

  /**
   * Sets the log verbose level.
   */
  setLogLevel(logLevel: LogLevel): void;

  /**
   * Same as `info()`.
   * Logs an informational message.
   */
  log (message: string): void;

  /**
   * Logs an informational message.
   */
  info(message: string): void;

  /**
   * Logs an error message.
   */
  error(message: string): void;
}

/**
 * An Enbox logger implementation.
 */
class EnboxLogger implements LoggerInterface {
  private logLevel: LogLevel = LogLevel.Silent; // Default to silent/no-op log level

  setLogLevel(logLevel: LogLevel): void {
    this.logLevel = logLevel;
  }

  public log(message: string): void {
    this.info(message);
  }

  public info(message: string): void {
    if (this.logLevel === LogLevel.Silent) { return; }

    console.info(message);
  }

  public error(message: string): void {
    if (this.logLevel === LogLevel.Silent) { return; }

    console.error(message);
  }
}

// Export a singleton logger instance
export const logger = new EnboxLogger();

// Attach logger to the global window object in browser environment for easy access to the logger instance.
// e.g. can call `enboxLogger.setLogLevel('debug');` directly in browser console.
declare global {
  interface Window { enboxLogger?: EnboxLogger }
}

if (typeof window !== 'undefined') {
  window.enboxLogger = logger;
}

// ---------------------------------------------------------------------------
// Deprecated aliases — migration aid
// ---------------------------------------------------------------------------

/** @deprecated Use {@link LogLevel} instead. Will be removed in a future version. */
export const Web5LogLevel = LogLevel;
/** @deprecated Use {@link LogLevel} instead. Will be removed in a future version. */
export type Web5LogLevel = LogLevel;

/** @deprecated Use {@link LoggerInterface} instead. Will be removed in a future version. */
export type Web5LoggerInterface = LoggerInterface;
