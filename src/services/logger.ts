/* tslint:disable no-console */
import { Logger, LogFunctionFactory } from '@graphile/logger';
import { createLogger } from '@logdna/logger';
import * as sentry from '@sentry/node';
import * as util from 'util';

import config from '../config';
import { DepError } from './lazy-dep';
import MetadataRepo from './repositories/metadata';

const logFactory: LogFunctionFactory<Logger> = (scope: any) => {
  // Better to check the config once in the factory and return fixed functions instead of checking
  // on each log output
  if (config.logger.logDnaKey) {
    const levels = ['info', 'warn', 'error'];
    if (config.logger.debug) levels.push('debug');
    const logfn = createLogger(config.logger.logDnaKey, {
      levels,
    });
    logfn.on('error', event => {
      if (event.retrying) return;
      console.log(`Fatal error in LogDNA ${util.inspect(event)}`);
    });
    if (config.logger.forceLocal) {
      return async (level, message, meta) => {
        const { dbId } = scope;
        let userId: string | undefined;
        if (dbId) {
          const user = await MetadataRepo.getUserFromDbId(dbId);
          userId = user?.id;
        }
        console.log(`${level}: ${message} ${util.inspect({ ...meta, userId, dbId })}`);
        logfn.log(message, {
          level: level === 'warning' ? 'warn' : level, // Graphile Logger vs LogDNA levels fix
          meta: { ...meta, userId, dbId },
          indexMeta: true,
          app: 'iasql-engine',
          env: process.env.IASQL_ENV,
        });
      };
    } else {
      return async (level, message, meta) => {
        const { dbId } = scope;
        let userId: string | undefined;
        if (dbId) {
          const user = await MetadataRepo.getUserFromDbId(dbId);
          userId = user?.id;
        }
        logfn.log(message, {
          level: level === 'warning' ? 'warn' : level, // Graphile Logger vs LogDNA levels fix
          meta: { ...meta, userId, dbId },
          indexMeta: true,
          app: 'iasql-engine',
          env: process.env.IASQL_ENV,
        });
      };
    }
  } else if (config.logger.debug && config.logger.test) {
    return (level, message, meta) => {
      const str = `${level}: ${message} ${util.inspect(scope)}${
        meta ? ` ${util.inspect(meta, { depth: 6 })}` : ''
      }\n`;
      switch (level) {
        case 'error':
          process.stderr.write(str);
          break;
        case 'debug':
        default:
          process.stdout.write(str);
          break;
      }
    };
  } else if (config.logger.debug) {
    return (level, message, meta) => {
      switch (level) {
        case 'error':
          console.error(`${level}: ${message} ${util.inspect(scope)}  ${util.inspect(meta)}`);
          break;
        case 'debug':
        default:
          console.log(`${level}: ${message} ${util.inspect(scope)}  ${util.inspect(meta)}`);
          break;
      }
    };
  } else if (config.logger.test) {
    return (level, message, meta) => {
      const str = `${level}: ${message} ${util.inspect(scope)}${
        meta ? ` ${util.inspect(meta, { depth: 6 })}` : ''
      }\n`;
      switch (level) {
        case 'error':
          process.stderr.write(str);
          break;
        case 'debug':
          break;
        default:
          process.stdout.write(str);
          break;
      }
    };
  } else {
    return (level, message, meta) => {
      switch (level) {
        case 'error':
          console.error(`${level}: ${message} ${util.inspect(scope)}  ${util.inspect(meta)}`);
          break;
        case 'debug':
          break;
        default:
          console.log(`${level}: ${message} ${util.inspect(scope)}  ${util.inspect(meta)}`);
          break;
      }
    };
  }
};
const singleton = new Logger(logFactory);

export function debugObj(e: any) {
  if (config.logger.debug) console.dir(e, { depth: 6 });
}

// this function should only be used in the catch statement of the routes
// everywhere else `throw` the error upstream
// TODO is there a way to DRY that?
// returns the sentry error id
export function logErrSentry(e: any, uid?: string, email?: string, dbAlias?: string): string {
  if (!(e instanceof DepError) && !(e instanceof Error)) {
    singleton.error(`Invalid error type ${typeof e} when logging to sentry. e = ${JSON.stringify(e)}`);
  }
  let message = e?.message ?? '';
  let err = e;
  let metadata;
  if (e instanceof DepError && e.metadata?.failures) {
    message = mergeErrorMessages(e.metadata.failures);
    err = e.metadata.failures[e.metadata.failures.length - 1];
    metadata = e.metadata;
  }
  if (config.sentry) {
    // TODO figure out how to use the stacktrace for the last error
    message += `\nPlease provide the following error ID if reporting it to the IaSQL team: ${sentry.captureEvent(
      {
        message,
        // https://docs.sentry.io/platforms/node/guides/express/enriching-events/identify-user/
        user: {
          id: uid,
          email,
        },
        extra: {
          dbAlias,
          metadata,
        },
      },
    )}`;
  }
  singleton.error(message, e instanceof DepError ? e.metadata : err);
  return message;
}

export function mergeErrorMessages(es: any[]): string {
  return [...new Set(es.map((f: any) => f?.message))].filter(m => !!m).join('\n');
}

export default singleton;
