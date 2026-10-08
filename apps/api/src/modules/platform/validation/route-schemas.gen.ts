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
  },
  "loginBySms": {
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
        "code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "pattern": "^[0-9]{6}$"
        },
        "legal_versions": {
          "type": "object",
          "description": "Versions of the privacy policy and user agreement the user agreed to (BR-ID-04).",
          "additionalProperties": false,
          "required": [
            "privacy",
            "agreement"
          ],
          "properties": {
            "privacy": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            "agreement": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            }
          }
        },
        "consent_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the box was ticked or the confirm dialog accepted (client clock)."
        },
        "invite_code": {
          "type": "string",
          "description": "Optional invite code; ignored for an existing account (BR-INV-06).",
          "maxLength": 32
        }
      }
    }
  },
  "refreshToken": {
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
        "refresh_token"
      ],
      "properties": {
        "refresh_token": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  "logout": {
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
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getUnionAuthUrl": {
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
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "installed": {
          "type": "string",
          "description": "Whether the platform app is installed, as detected by the client (BR-ATTR-27 ①); the\nstrings \"true\" / \"false\" / \"unknown\" (enum installed_state).\n",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "abandonIdempotencyKey": {
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
        "action",
        "idempotency_key"
      ],
      "properties": {
        "action": {
          "type": "string",
          "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        },
        "idempotency_key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      }
    }
  },
  "searchProducts": {
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
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "sort": {
          "type": "string",
          "description": "Search sort (contracts/enums/trade.yaml sort).",
          "enum": [
            "relevance",
            "sales_desc",
            "final_price_asc",
            "rebate_desc"
          ]
        },
        "has_coupon": {
          "type": "boolean"
        },
        "price_min_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "price_max_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [
        "platform",
        "q"
      ],
      "additionalProperties": false
    }
  },
  "getProduct": {
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
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "product_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "parseInput": {
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
        "text",
        "scene"
      ],
      "properties": {
        "text": {
          "type": "string",
          "description": "Locally filtered clipboard or typed text (03 §4.6). Text outside links and tokens\nis untrusted (BR-AI-05); prices in it are only material.claimed_price_fen.\n",
          "minLength": 1,
          "maxLength": 4000
        },
        "scene": {
          "type": "string",
          "description": "Entry the text came from (subset of contracts/enums scene). Attribution-bearing\nscenes (share, agent, …) cannot be chosen by the client: share links come only from\nPOST /v1/shares (phone level), Agent cards from the Agent service (BR-ATTR-05, 08).\nshare_ext is P1.\n",
          "enum": [
            "clipboard",
            "search",
            "share_ext"
          ]
        }
      }
    }
  },
  "openLink": {
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
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "installed": {
          "description": "Default unknown; H5 always sends unknown (BR-ATTR-27 ①).",
          "type": "string",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
        },
        "no_rebate": {
          "type": "boolean",
          "default": false,
          "description": "Buy without rebate (BR-ID-18)."
        },
        "no_rebate_reason": {
          "type": "string",
          "description": "Only with no_rebate=true; default auth_declined. The server overrides it with\nrelation_conflict / binding_blocked when it decides so (BR-ID-18).\n",
          "enum": [
            "auth_declined",
            "auth_failed"
          ]
        },
        "spm": {
          "type": "string",
          "description": "page.module.slot of the tapped button (03 §4.7).",
          "maxLength": 128
        }
      }
    }
  },
  "getLink": {
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
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    }
  }
} as const;
