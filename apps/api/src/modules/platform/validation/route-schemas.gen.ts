// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-route-schemas.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_ROUTE_SCHEMAS = {
  "getHealthz": {},
  "registerDevice": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "device_hash",
        "id_source"
      ],
      "properties": {
        "device_hash": {
          "type": "string",
          "description": "lowercase_hex(SHA-256(UTF-8 bytes of the identifier, trimmed and lower-cased)) of IDFV\n(iOS), ANDROID_ID (Android, MVP) or ODID (Harmony) (BR-ID-09 细则「设备标识的无效值」).\n",
          "pattern": "^[0-9a-f]{64}$"
        },
        "id_source": {
          "type": "string",
          "description": "Which device identifier was hashed (enum device_id_source, BR-ID-09).",
          "enum": [
            "idfv",
            "android_id",
            "oaid",
            "odid"
          ]
        }
      }
    }
  }
} as const;
