import { Injectable, type LoggerService } from '@nestjs/common';

import { ApplicationConfigService } from '../../config/application-config.service';
import { redactSensitiveData } from '../utils/redact-sensitive-data';
import { RequestContextService } from '../request-context/request-context.service';

type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 1,
  warn: 2,
  log: 3,
  debug: 4,
  verbose: 5,
};

@Injectable()
export class StructuredLoggerService implements LoggerService {
  constructor(
    private readonly configuration: ApplicationConfigService,
    private readonly requestContext: RequestContextService
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: readonly unknown[]
  ): void {
    if (!this.isEnabled(level)) {
      return;
    }

    const params = [...optionalParams];
    const possibleContext = params.at(-1);
    const context =
      typeof possibleContext === 'string' ? String(params.pop()) : undefined;
    const metadata =
      params.length === 0
        ? undefined
        : params.length === 1
          ? params[0]
          : params;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestContext.requestId ?? null,
      ...(context ? { context } : {}),
      message: redactSensitiveData(message),
      ...(metadata === undefined
        ? {}
        : { metadata: redactSensitiveData(metadata) }),
    };
    const output = `${JSON.stringify(record)}\n`;

    if (level === 'fatal' || level === 'error') {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  }

  private isEnabled(level: LogLevel): boolean {
    return (
      LOG_LEVEL_PRIORITY[level] <=
      LOG_LEVEL_PRIORITY[this.configuration.app.logLevel]
    );
  }
}
