import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CLOCK, DB, type Clock } from '../platform/index.ts';
import { ParsingConfigReader } from './ports.ts';

/** Builds the configuration port; app.module.ts passes content's reader (F1-02b). */
export type ParsingConfigReaderFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => ParsingConfigReader;

function unavailable(): Promise<never> {
  return Promise.reject(new Error('parsing: no database handle in this process'));
}

/** Entries built without database handles (isolated HTTP unit tests) fail at call time. */
const UNAVAILABLE_CONFIG: ParsingConfigReader = { configValue: unavailable };

/**
 * Parsing (规划/02 §4.1), B1-07a: assembles the configuration port (content's cached reader,
 * built once per process by the factory app.module.ts passes), so parsing never imports content.
 * The parsing service itself (createParsing) is built by its HTTP route (B1-07b) once catalog's
 * card entry has its quoter, registrar and item_ref providers wired; no placeholder is provided.
 */
@Module({})
export class ParsingModule {
  static forRoot(configReader: ParsingConfigReaderFactory): DynamicModule {
    return {
      module: ParsingModule,
      providers: [
        {
          provide: ParsingConfigReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): ParsingConfigReader =>
            db === undefined ? UNAVAILABLE_CONFIG : configReader(db, clock),
        },
      ],
      exports: [ParsingConfigReader],
    };
  }
}
