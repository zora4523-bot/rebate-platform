// GENERATED FILE. Do not edit by hand.
// Source: contracts/openapi.yaml
// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness probe
         * @description Returns 200 as soon as the process has finished initialising. It checks no
         *     dependency (database, cache, queue). Served by every HTTP entry.
         */
        get: operations["getHealthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description Process entry that produced the response (ADR-0001 §2).
         * @enum {string}
         */
        EntryName: "api" | "stream" | "admin" | "worker" | "payout";
        HealthzData: {
            /** @enum {string} */
            status: "ok";
            entry: components["schemas"]["EntryName"];
            /**
             * Format: date-time
             * @description Current instant of the process clock (follows CLOCK_NOW outside prod).
             */
            now: string;
        };
        /** @description Response envelope of 规划/04 §5 carrying the health payload. */
        HealthzResponse: {
            /**
             * Format: int32
             * @description 0 means success.
             * @enum {integer}
             */
            code: 0;
            msg: string;
            data: components["schemas"]["HealthzData"];
            /** @description Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID. */
            trace_id: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealthz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The process is initialised. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "status": "ok",
                     *         "entry": "api",
                     *         "now": "2026-10-01T04:00:00.000Z"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["HealthzResponse"];
                };
            };
        };
    };
}
