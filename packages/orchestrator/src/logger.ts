/** Minimal logger. All lines go to stderr (stdout is reserved for user output). Secrets are masked. */
import { maskSecret } from './config.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  verbose?: boolean;
  /** Secret to mask everywhere in output (typically the API key). */
  secret?: string;
  /** Sink for lines; defaults to stderr. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const mask = (msg: string): string => maskSecret(msg, options.secret);
  return {
    info: (msg) => sink(mask(msg)),
    warn: (msg) => sink(mask(`WARN  ${msg}`)),
    error: (msg) => sink(mask(`ERROR ${msg}`)),
    debug: (msg) => {
      if (options.verbose) sink(mask(`debug ${msg}`));
    },
  };
}
