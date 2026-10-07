// The configuration port parsing reads (parse.tpwd.enabled, product_key.jd.mode). content's
// ContentReader implements it (F1-02b); app.module.ts assembles it through ParsingModule, so
// parsing never imports content. The abstract class is both the type and the Nest token.
import type { DB } from '@couli/db';

export abstract class ParsingConfigReader {
  abstract configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null>;
}
