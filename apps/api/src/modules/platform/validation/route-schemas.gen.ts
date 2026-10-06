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
  },
  "sendSmsCode": {
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
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "purpose"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "purpose": {
          "type": "string",
          "description": "contracts/enums/identity.yaml sms_purpose.",
          "enum": [
            "login",
            "bind",
            "step_up"
          ]
        },
        "captcha_token": {
          "type": "string",
          "description": "Human-verification token, required after 44003 (BR-ID-05).",
          "maxLength": 2048
        },
        "action": {
          "description": "With purpose=step_up the client always sends the action the code is for; the version\ngate and the session scope are decided from it (BR-ID-01 细则): only\naction=account_deletion is exempt, and a step_up request without action is gated.\npurpose=login is exempt regardless of action; purpose=bind is gated.\n",
          "type": "string",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        }
      }
    }
  }
} as const;
