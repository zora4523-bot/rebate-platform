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
  "reportPushToken": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider",
        "token"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "description": "Push provider; a string until the provider is chosen (D-14).",
          "minLength": 1,
          "maxLength": 32
        },
        "token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
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
  "createOauthAttempt": {
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
      "description": "`action` is required exactly for purpose=step_up. purpose=payout_bind is for WeChat only\nand carries no `action`. The oneOf branches declare the properties they constrain (strict\nAjv2020, ADR-0001 §4.2 #15).\n",
      "additionalProperties": false,
      "required": [
        "provider",
        "purpose"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "description": "Third-party identity provider (enum login_provider, BR-ID-04).",
          "enum": [
            "wechat",
            "apple",
            "huawei"
          ]
        },
        "purpose": {
          "type": "string",
          "description": "What a third-party authorization attempt is for (enum oauth_attempt_purpose).",
          "enum": [
            "login",
            "step_up",
            "payout_bind"
          ]
        },
        "action": {
          "type": "string",
          "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        }
      },
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "login"
              ]
            }
          },
          "required": [
            "purpose"
          ]
        },
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "step_up"
              ]
            },
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            }
          },
          "required": [
            "purpose",
            "action"
          ]
        },
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "payout_bind"
              ]
            },
            "provider": {
              "type": "string",
              "enum": [
                "wechat"
              ]
            }
          },
          "required": [
            "purpose",
            "provider"
          ],
          "not": {
            "type": "object",
            "additionalProperties": true,
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
              }
            },
            "required": [
              "action"
            ]
          }
        }
      ]
    }
  },
  "loginByWechat": {
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
        "attempt_id",
        "code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "code": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
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
          "format": "date-time"
        }
      }
    }
  },
  "loginByApple": {
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
        "attempt_id",
        "identity_token",
        "authorization_code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "identity_token": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
        },
        "authorization_code": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
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
          "format": "date-time"
        }
      }
    }
  },
  "stepUp": {
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
      "description": "Exactly one way of second verification: an SMS code, or a new authorization with one\nprovider carrying that provider's login credential fields (BR-ID-08). Each branch is a\nclosed object, so a body mixing two ways matches none.\n",
      "unevaluatedProperties": false,
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "code"
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
            "code": {
              "type": "string",
              "pattern": "^[0-9]{6}$"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "code"
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
            "provider": {
              "type": "string",
              "enum": [
                "wechat"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "identity_token",
            "authorization_code"
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
            "provider": {
              "type": "string",
              "enum": [
                "apple"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "identity_token": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "authorization_code"
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
            "provider": {
              "type": "string",
              "enum": [
                "huawei"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        }
      ]
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
  "recordConsent": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type",
        "version",
        "accepted",
        "channel",
        "client_at"
      ],
      "properties": {
        "type": {
          "type": "string",
          "description": "consent_type without labor_agreement (BR-ID-12, BR-WDR-31).",
          "enum": [
            "privacy",
            "agreement",
            "ai_third_party",
            "id_verification",
            "personalization",
            "clipboard_auto_import"
          ]
        },
        "version": {
          "description": "The version of the text the user saw. A positive integer (legal.privacy.version and the\nlike) for every type except clipboard_auto_import, which takes the string\nconfig.clipboard.consent_version (BR-ID-12 细则, BR-ID-16). A form that does not pair\nwith `type` → 20001 with data.fields=[version].\n",
          "oneOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 32
            }
          ]
        },
        "accepted": {
          "type": "boolean",
          "description": "true = agreed; false = withdrawn."
        },
        "channel": {
          "type": "string",
          "description": "consent_channel without the server-written login_merge, h5_landing and withdraw_flow.",
          "enum": [
            "first_launch",
            "login_page",
            "agent_sheet",
            "realname_sheet",
            "privacy_center"
          ]
        },
        "client_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the user tapped (device clock)."
        }
      }
    }
  },
  "issueH5Token": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scope": {
          "description": "Filled by the native app from its force-update state; H5 cannot choose it. The value\nused when it is absent is set in BR-ID-32 细则「只读作用域」.\n",
          "type": "string",
          "enum": [
            "standard",
            "read_only"
          ]
        }
      }
    }
  },
  "listUnionBindings": {
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
  "bindUnion": {
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
    "body": {
      "type": "object",
      "description": "Exactly one authorization method (BR-ID-17 细则「授权方式」); each branch is closed, so\nundefined fields are 20001.\n",
      "unevaluatedProperties": false,
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "state",
            "auth_method",
            "code"
          ],
          "properties": {
            "state": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "auth_method": {
              "type": "string",
              "enum": [
                "web_code"
              ]
            },
            "code": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "state",
            "auth_method",
            "access_token",
            "expires_in"
          ],
          "properties": {
            "state": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "auth_method": {
              "type": "string",
              "enum": [
                "sdk_token"
              ]
            },
            "access_token": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "expires_in": {
              "type": "integer",
              "format": "int64",
              "minimum": 1,
              "description": "Lifetime of the access token in seconds, as the SDK returned it."
            }
          }
        }
      ]
    }
  },
  "listOrders": {
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
        "scope": {
          "type": "string",
          "enum": [
            "self",
            "share"
          ]
        },
        "status_group": {
          "type": "string",
          "description": "Status group of the order list (enum order_status_group; members in BR-TEXT-02 细则).",
          "enum": [
            "all",
            "estimating",
            "credited",
            "no_rebate"
          ]
        },
        "display_status": {
          "type": "string",
          "description": "User-visible order status (enum display_status; BR-FUND-17); unknown codes map to UNKNOWN.",
          "enum": [
            "PAID",
            "DEPOSIT_PAID",
            "WAITING",
            "CREDITING",
            "REVIEWING",
            "RIGHTS_PENDING",
            "CREDITED",
            "CREDITED_PART_CLAWED",
            "NO_REBATE",
            "INVALID",
            "CLAWED_BACK"
          ]
        },
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
          "maxLength": 40
        },
        "paid_month": {
          "type": "string",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
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
        "scope"
      ],
      "additionalProperties": false
    }
  },
  "listOrderClaims": {
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
      "required": [],
      "additionalProperties": false
    }
  },
  "createOrderClaim": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "platform",
        "order_no",
        "paid_date"
      ],
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
        "order_no": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "Order number; spaces are removed, then it is matched exactly as a string, first against child order numbers, then against parent order numbers (BR-ATTR-17). For pdd the hyphens are removed from both the input and the stored numbers before comparing; stored and displayed numbers are unchanged. Empty after removing spaces is 20001."
        },
        "paid_date": {
          "type": "string",
          "format": "date",
          "description": "Payment date, YYYY-MM-DD in +08:00 (second factor); for a pre-sale order the date the deposit was paid."
        }
      }
    }
  },
  "listPendingTracks": {
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
  "dismissPendingTrack": {
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
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_id"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "getOrder": {
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
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    }
  },
  "getAgreements": {
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
    }
  },
  "getAgreementVersion": {
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
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type).",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement"
          ]
        }
      },
      "required": [
        "type"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listArticles": {
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
    "querystring": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "help_section": {
          "type": "string",
          "description": "Sub-section of a help article (04 §3.2 articles.help_section; 变更记录 20261020-内容线默认回写\n§1.6). Codes are defined by the contract line (no enums/ entry, same as ArticleCategory);\nthe list follows the help-centre board and grows or shrinks with it under the enum\nextension rules: getting_started = 新手教程, rebate_settlement = 返利与结算, orders_claims =\n订单与找回, withdraw = 提现, invite = 邀请好友, account_privacy = 账号与隐私. Only an article of\ncategory help may carry one.\n",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
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
        "category"
      ],
      "additionalProperties": false
    }
  },
  "getArticle": {
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
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "checkAppVersion": {
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
  "getPage": {
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
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    }
  },
  "previewPage": {
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
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        }
      },
      "required": [
        "token"
      ],
      "additionalProperties": false
    }
  },
  "getMessage": {
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
        "message_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    }
  },
  "listMessages": {
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
      "required": [],
      "additionalProperties": false
    }
  },
  "markMessagesRead": {
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
    "body": {
      "description": "Exactly one of message_ids (1–100 ids, duplicates counted once) or all=true.",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "message_ids"
          ],
          "properties": {
            "message_ids": {
              "type": "array",
              "minItems": 1,
              "maxItems": 100,
              "items": {
                "type": "string",
                "description": "Entity id, a UUIDv7 string (04 §5).",
                "minLength": 1,
                "maxLength": 64
              }
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "all"
          ],
          "properties": {
            "all": {
              "type": "boolean",
              "enum": [
                true
              ]
            }
          }
        }
      ]
    }
  },
  "getUnreadMessageCount": {
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
  "getMe": {
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
  "updateMe": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "nickname"
      ],
      "properties": {
        "nickname": {
          "type": "string",
          "description": "New nickname. The server trims leading and trailing white space and checks the length\nas 1–16 extended grapheme clusters (BR-ID-39); no minLength / maxLength here because\nJSON Schema counts code points.\n"
        }
      }
    }
  },
  "bindPhone": {
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
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "code"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "description": "purpose=bind SMS code sent to the new number.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "bindInviter": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "invite_code"
      ],
      "properties": {
        "invite_code": {
          "type": "string",
          "description": "Invite code as typed or pasted. The server normalises it and checks the format\n(BR-INV-02); an empty or malformed code is 30401 and counts towards the daily limit, so\nthe schema has no pattern or minLength.\n",
          "maxLength": 64
        }
      }
    }
  },
  "getMyInvite": {
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
  "sendLandingSmsCode": {
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
        "phone"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      }
    }
  },
  "landingRegister": {
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
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "sms_code",
        "invite_code",
        "agreed"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "sms_code": {
          "type": "string",
          "description": "The purpose=login code from POST /v1/landing/sms-codes; a wrong or expired code is\n20002 / 20003 (BR-ID-05).\n",
          "maxLength": 64
        },
        "invite_code": {
          "type": "string",
          "description": "Invite code of the landing link. Normalised and checked by the server (BR-INV-02); an\nempty or malformed code is 30401 and counts towards the daily limit, so the schema has\nno pattern or minLength.\n",
          "maxLength": 64
        },
        "agreed": {
          "type": "boolean",
          "description": "The user agreement and privacy policy box was ticked. false is 10004 with\ndata.consent_type=agreement, not a validation error; on success the agreement and\nprivacy consents are recorded with channel h5_landing (BR-INV-05, BR-ID-32).\n"
        },
        "channel": {
          "type": "string",
          "description": "Optional channel code of the landing link, kept as the account's registered channel\n(BR-ID-04, BR-INV-05).\n",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      }
    }
  },
  "getPayoutAccount": {
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
  "savePayoutAccount": {
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
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
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
    "body": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "payout_method",
            "alipay_logon_id",
            "payee_name"
          ],
          "properties": {
            "payout_method": {
              "type": "string",
              "enum": [
                "alipay"
              ]
            },
            "alipay_logon_id": {
              "type": "string",
              "description": "Alipay logon id (phone or e-mail form), normalised by the server (BR-WDR-02 细则).",
              "minLength": 1,
              "maxLength": 128
            },
            "payee_name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "payout_method",
            "card_no",
            "payee_name"
          ],
          "properties": {
            "payout_method": {
              "type": "string",
              "enum": [
                "bank_card"
              ]
            },
            "card_no": {
              "type": "string",
              "description": "Card number as typed; the server removes spaces and hyphens, then checks 12–19 digits and\nLuhn (20001 data.fields=[card_no], BR-WDR-02 ⑥ and 细则).\n",
              "minLength": 1,
              "maxLength": 32
            },
            "bank_name": {
              "type": "string",
              "description": "Optional and ignored by the server: the opening bank is taken from the card BIN, the\nuser does not type it (BR-WDR-02 细则「只支持本人名下借记卡」). Accepted so that older\nclients sending it are not refused.\n",
              "minLength": 1,
              "maxLength": 64
            },
            "payee_name": {
              "type": "string",
              "description": "Account holder name (BR-WDR-02 ①).",
              "minLength": 1,
              "maxLength": 64
            }
          }
        }
      ]
    }
  },
  "submitRealname": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name",
        "id_no"
      ],
      "properties": {
        "name": {
          "type": "string",
          "description": "Real name as typed; normalised by the server.",
          "minLength": 1,
          "maxLength": 64
        },
        "id_no": {
          "type": "string",
          "description": "18-digit resident ID number as typed. No pattern here: length and check digit are judged\nby the server (20001 data.fields=[id_no], BR-ID-25) after the phone and consent checks.\n",
          "maxLength": 32
        }
      }
    }
  },
  "getLaborAgreement": {
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
  "signLaborAgreement": {
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
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "text_sha256",
        "agreed"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "description": "The version shown to the user (GET /v1/me/labor-agreement); must be the current one."
        },
        "text_sha256": {
          "type": "string",
          "description": "sha256 of the text shown; must match that version (20001 data.fields=[text_sha256])."
        },
        "agreed": {
          "type": "boolean",
          "description": "Must be true; the server returns 20001 data.fields=[agreed] otherwise."
        }
      }
    }
  },
  "getTips": {
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
  "markTipRead": {
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
        "tip_key": {
          "type": "string",
          "description": "One-time tip (enum tip_key; BR-ATTR-21, BR-INV-03 细则). inviter_before_buy is deprecated\nsince 2026-10-19 (first-purchase inviter tip cancelled): kept and accepted as before, not\nused by clients, never reused.\n",
          "enum": [
            "jump_tip",
            "inviter_before_buy"
          ]
        }
      },
      "required": [
        "tip_key"
      ],
      "additionalProperties": false
    }
  },
  "resetTip": {
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
        "tip_key": {
          "type": "string",
          "description": "The tip that settings can show again (subset of tip_key).",
          "enum": [
            "jump_tip"
          ]
        }
      },
      "required": [
        "tip_key"
      ],
      "additionalProperties": false
    }
  },
  "listAppeals": {
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
      "required": [],
      "additionalProperties": false
    }
  },
  "submitAppeal": {
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
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "target_type",
        "content"
      ],
      "properties": {
        "target_type": {
          "type": "string",
          "description": "Subset of contracts/enums/identity.yaml appeal_target_type (04 §6.1, BR-ID-36): the\nuser-side appeal endpoints take and return account and order only. blocked_request (a\nwrite request blocked with 44001) is registered by customer service in the admin console\nonly and is not accepted here (04 §3.2 appeals, §6.1; BR-ID-36 细则「被拦截请求申诉」).\n",
          "enum": [
            "account",
            "order"
          ]
        },
        "target_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "content": {
          "type": "string",
          "minLength": 1
        }
      }
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
  "getConfig": {
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
        "if-none-match": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    }
  },
  "getDict": {
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
        "x-app-version"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32
        }
      },
      "required": [],
      "additionalProperties": false
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
  "getProductPriceTrend": {
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
    }
  },
  "listFavorites": {
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
        "cursor": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "addFavorite": {
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
        "idempotency-key"
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
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "platform",
        "product_key"
      ],
      "additionalProperties": false
    }
  },
  "removeFavorite": {
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
        "idempotency-key"
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
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "platform",
        "product_key"
      ],
      "additionalProperties": false
    }
  },
  "batchDeleteFavorites": {
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
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "platform",
              "product_key"
            ],
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
              "product_key": {
                "type": "string",
                "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
                "minLength": 3,
                "maxLength": 128
              }
            }
          }
        }
      }
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
  "convertLink": {
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
    "body": {
      "type": "object",
      "description": "Either product_key (with the tapped card's item_ref) or url; neither, or both, is 20001.\nThe oneOf branches declare the property they require (strict Ajv2020, ADR-0001 §4.2 #15).\nA Taobao url is first resolved to an item_id and answered with a Baichuan open instruction\n(JumpStep.sdk); the pasted link or token itself is never passed on (BR-PRICE-21).\n",
      "additionalProperties": false,
      "required": [
        "platform",
        "scene"
      ],
      "oneOf": [
        {
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
          ]
        },
        {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "format": "uri",
              "maxLength": 2048
            }
          },
          "required": [
            "url"
          ]
        }
      ],
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
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        },
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        },
        "url": {
          "type": "string",
          "format": "uri",
          "maxLength": 2048
        },
        "scene": {
          "type": "string",
          "description": "Only the H5 entry (trade.convertAndOpen) uses convert (拍板第二批 TRADE-03); other\nscenes are rejected with 20001 so that the client cannot pick an attribution scene\nsuch as share (BR-ATTR-05, BR-ATTR-08).\n",
          "enum": [
            "h5"
          ]
        },
        "spm": {
          "type": "string",
          "maxLength": 128
        },
        "installed": {
          "description": "Default unknown; H5 always sends unknown (BR-ATTR-27 ①).",
          "type": "string",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
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
  },
  "adminLogin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "username",
        "password"
      ],
      "properties": {
        "username": {
          "type": "string",
          "description": "Account name (unique; a disabled account keeps its name, BR-ID-34).",
          "minLength": 1,
          "maxLength": 64
        },
        "password": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      }
    }
  },
  "adminChangeInitialPassword": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "new_password"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "new_password": {
          "type": "string",
          "description": "Must differ from the initial password; composition rules are set by the server.",
          "minLength": 1,
          "maxLength": 128
        }
      }
    }
  },
  "adminGetTotpBindingSecret": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        }
      }
    }
  },
  "adminBindTotp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "code"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminVerifyTotp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "code"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminLogout": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminSendStepUpSms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminStepUp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "tier",
        "code"
      ],
      "properties": {
        "tier": {
          "type": "string",
          "description": "Admin step-up tier (enum admin_step_up_tier, BR-ID-34).",
          "enum": [
            "totp",
            "sms"
          ]
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminGetMyPermissions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListAdmins": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetAdmin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    }
  },
  "adminListUsers": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "risk_state": {
          "type": "string",
          "description": "Risk state of a user (enum risk_state; BR-ID-31, BR-ID-36).",
          "enum": [
            "normal",
            "frozen",
            "appealing",
            "banned"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminLookupUser": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetUser": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  "adminRevealUserField": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "field",
        "reason"
      ],
      "properties": {
        "field": {
          "type": "string",
          "description": "The sensitive field to show in full. Only phone (permission point pii.reveal_phone) for\nnow; the identity number and payout account (pii.reveal_identity) come later.\n",
          "enum": [
            "phone"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminUpdateUserRiskState": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action",
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "action": {
          "type": "string",
          "description": "ban and unban (permission point risk.ban), freeze and unfreeze (risk.freeze); 04 §11.2,\nBR-ID-31, BR-ID-36.\n",
          "enum": [
            "ban",
            "unban",
            "freeze",
            "unfreeze"
          ]
        },
        "reason_category": {
          "allOf": [
            {
              "type": "string",
              "description": "User-visible reason category of a ban or freeze (enum risk_reason_category; BR-TEXT-23 细则\n「原因类别」, user text from the dictionary risk_reason.<category>).\n",
              "enum": [
                "malicious_rights",
                "fraud_invite",
                "abnormal_trade",
                "account_security",
                "other"
              ]
            }
          ],
          "description": "Required for ban and freeze; not accepted for unban and unfreeze (20001)."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "frozen_until": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Only for freeze: end of the freeze, later than the server's current time; null or\nabsent = without end (BR-ID-36). Given with another action → 20001.\n"
        },
        "expected_row_version": {
          "anyOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding); plus 1 on every\nchange. The CAS value `expected_row_version` of the writes.\n"
            },
            {
              "type": "null"
            }
          ],
          "description": "risk.row_version as the console showed it; null = no row seen, only accepted while the\nuser still has no row. Any mismatch (null against an existing row, an integer against\nno row or another version) is 20902.\n"
        }
      }
    }
  },
  "adminResetUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
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
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding); plus 1 on every\nchange. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminDisableUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
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
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding); plus 1 on every\nchange. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminEnableUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
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
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding); plus 1 on every\nchange. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListClaims": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
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
        "evidence_level": {
          "type": "string",
          "description": "Evidence level of a claim or of one child order (contracts/enums/order.yaml claim_evidence_level; BR-ATTR-18).",
          "enum": [
            "strong",
            "weak",
            "none"
          ]
        },
        "status": {
          "type": "string",
          "description": "Claim status (contracts/enums/order.yaml claim_status; BR-ATTR-16, BR-ATTR-18).",
          "enum": [
            "submitted",
            "auto_matched",
            "manual_review",
            "approved",
            "rejected",
            "cancelled"
          ]
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "q": {
          "type": "string"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetClaim": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "claim_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "claim_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminListPlatformIcons": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListPlatformIconVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreatePlatformIconVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "upload_id"
      ],
      "properties": {
        "upload_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "sanitized_confirmed": {
          "type": "boolean",
          "description": "The operator confirmed the cleaned preview; absent means false. Must be true when the\nupload has sanitized=true.\n"
        },
        "source_url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://",
          "maxLength": 2048,
          "description": "Official brand or asset download page the file was taken from (BR-TEXT-24 细则「必填登记」)."
        },
        "downloaded_on": {
          "type": "string",
          "format": "date"
        }
      }
    }
  },
  "adminUploadPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "multipart": true
  },
  "adminUpdatePlatformIconVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "key",
        "version"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "The version's revision as shown plus at least one of the two registrations.",
      "additionalProperties": false,
      "required": [
        "expected_revision"
      ],
      "minProperties": 2,
      "properties": {
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The version's `revision` as the console showed it; a mismatch is 20902."
        },
        "source_url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://",
          "maxLength": 2048,
          "description": "Official brand or asset download page the file was taken from (BR-TEXT-24 细则「必填登记」)."
        },
        "downloaded_on": {
          "type": "string",
          "format": "date"
        }
      }
    }
  },
  "adminPublishPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Version to publish; older than the current one = rollback."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The mark's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminRestoreBuiltinPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_revision"
      ],
      "properties": {
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The mark's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListPageConfigs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    }
  },
  "adminListPageConfigVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreatePageConfigVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "sections",
        "expected_revision"
      ],
      "properties": {
        "sections": {
          "type": "array",
          "description": "The whole page; section shape contracts/home-schema.json `$defs/section`.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it, 0 for a page not saved yet; a mismatch is 20902."
        }
      }
    }
  },
  "adminGetPageConfigVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "page_key",
        "version"
      ],
      "additionalProperties": false
    }
  },
  "adminPublishPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "gray_percent",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Draft version to publish."
        },
        "gray_percent": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 100,
          "description": "100 = release fully; 1..99 = gray rollout to that share of devices."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminUpdatePageConfigGray": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "gray_percent",
        "expected_revision"
      ],
      "properties": {
        "gray_percent": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 100,
          "description": "New share of devices on the gray version; 100 = release the gray version fully."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminRollbackPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The current gray version or the current fully released version."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminCreatePagePreviewToken": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Version to preview, in any status."
        }
      }
    }
  },
  "adminListAgreements": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type).",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminPublishAgreementVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type).",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement"
          ]
        }
      },
      "required": [
        "type"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title",
        "body",
        "min_version",
        "requires_resign",
        "legal_confirmed_by",
        "legal_confirm_note",
        "legal_confirmed_on",
        "expected_version"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON of the text, as a string; nodes and marks outside the agreement body whitelist are 20001 with data.fields=[body]."
        },
        "min_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Where re-consent or re-signing starts; not below the current version's, not above the new version."
        },
        "requires_resign": {
          "type": "boolean",
          "description": "Whether the new version requires a new signature; must agree with the publish rules for the type and min_version."
        },
        "legal_confirmed_by": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "Who confirmed the version for legal (OPS-14)."
        },
        "legal_confirm_note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "The legal confirmation note (OPS-14)."
        },
        "legal_confirmed_on": {
          "type": "string",
          "format": "date",
          "description": "Date of the legal confirmation, written to the audit record (BR-ID-12)."
        },
        "expected_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The type's newest version as the console showed it, 0 when none is published; a mismatch is 20902."
        }
      }
    }
  },
  "adminGetAgreementVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type).",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement"
          ]
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "type",
        "version"
      ],
      "additionalProperties": false
    }
  },
  "adminListArticles": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "status": {
          "type": "string",
          "description": "Status of one article version row (04 §6.2): draft = saved, never published; published =\npublished (counts only once published_at is not later than now); offline = taken offline.\n",
          "enum": [
            "draft",
            "published",
            "offline"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "article_id",
        "category",
        "title",
        "body"
      ],
      "properties": {
        "article_id": {
          "description": "Client-generated UUIDv7 (lowercase canonical form), generated once per new article and\nreused on every retry of the same create. An id that already exists → 20902\n`data.resource=article` (no second article); read it back with GET\n/admin/v1/articles/{article_id}.\n",
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON document as a string."
        },
        "notice_closable": {
          "type": "boolean",
          "description": "Notices only (default true); ignored for other categories."
        },
        "notice_end_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Notices only; required when notice_closable is false. Ignored for other categories."
        },
        "help_section": {
          "description": "Help articles only; omitted = no sub-section. Not nullable. Sent with a category\nother than help → 20001 `data.fields` containing help_section.\n",
          "type": "string",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
        }
      }
    }
  },
  "adminGetArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    }
  },
  "adminSaveArticleDraft": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title",
        "body",
        "expected_row_version"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON document as a string."
        },
        "notice_closable": {
          "type": "boolean",
          "description": "Notices only (default true); ignored for other categories."
        },
        "notice_end_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Notices only; required when notice_closable is false. Ignored for other categories."
        },
        "help_section": {
          "description": "Help articles only; omitted = no sub-section (a draft is a whole new version row, so\nomitting it clears the value). Not nullable. Sent with a category other than help →\n20001 `data.fields` containing help_section.\n",
          "type": "string",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminPublishArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_row_version"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The newest version, in status draft."
        },
        "published_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the version takes effect; default now, earlier than now is 20001."
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminOfflineArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "class": {
          "type": "string",
          "description": "Which permission point writes a dictionary key (BR-TEXT-12 细则, 04 §11.2): general →\nconfig.general, fund_terms → content.fund_terms, agreement (table D, `privacy.` and\n`perm.`) → content.agreement.\n",
          "enum": [
            "general",
            "fund_terms",
            "agreement"
          ]
        },
        "key_prefix": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminSaveDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "changes",
        "expected_version"
      ],
      "properties": {
        "changes": {
          "type": "array",
          "description": "Keys of one class, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "text"
            ],
            "properties": {
              "key": {
                "type": "string",
                "description": "A key of contracts/texts.default.json or contracts/texts.admin.default.json.",
                "minLength": 1,
                "maxLength": 128
              },
              "text": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "The override text; null = back to the bundled default.",
                "minLength": 1,
                "maxLength": 2000
              }
            }
          }
        },
        "expected_version": {
          "type": "string",
          "description": "A dictionary version (dict_version, an integer as a string; \"0\" before the first publish).",
          "minLength": 1,
          "maxLength": 32
        },
        "legal_confirmed_by": {
          "type": "string",
          "description": "Who in legal confirmed the change; required when the keys are of class agreement (04 §11.2 content.agreement).",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminListDictItemVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminRollbackDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "keys",
        "to_version",
        "expected_version"
      ],
      "properties": {
        "keys": {
          "type": "array",
          "description": "Keys of one class, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "string",
            "description": "A key of contracts/texts.default.json or contracts/texts.admin.default.json.",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "to_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The dictionary version to restore the keys to; lower than the current one, 0 = the bundled default."
        },
        "expected_version": {
          "type": "string",
          "description": "A dictionary version (dict_version, an integer as a string; \"0\" before the first publish).",
          "minLength": 1,
          "maxLength": 32
        },
        "legal_confirmed_by": {
          "type": "string",
          "description": "Who in legal confirmed the change; required when the keys are of class agreement (04 §11.2 content.agreement).",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminGetDict": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListAppVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminGetAppVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
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
        "channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        }
      },
      "required": [
        "platform",
        "channel"
      ],
      "additionalProperties": false
    }
  },
  "adminSaveAppVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Client platforms whose version row the console saves (a subset of ClientPlatformCode; h5 and admin rows are read-only).",
          "enum": [
            "ios",
            "android",
            "harmony"
          ]
        },
        "channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        }
      },
      "required": [
        "platform",
        "channel"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "latest_version",
        "min_supported_version",
        "recommended_version",
        "update_title",
        "update_notes",
        "store_url",
        "default_store",
        "store_listings",
        "confirmed_stores",
        "expected_row_version"
      ],
      "properties": {
        "latest_version": {
          "type": "string",
          "description": "Semantic version x.y.z.",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
        },
        "min_supported_version": {
          "anyOf": [
            {
              "type": "string",
              "description": "Semantic version x.y.z.",
              "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
            },
            {
              "type": "null"
            }
          ],
          "description": "Null = no minimum. Saving a higher one than before (none before counts) needs the totp tier."
        },
        "recommended_version": {
          "anyOf": [
            {
              "type": "string",
              "description": "Semantic version x.y.z.",
              "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
            },
            {
              "type": "null"
            }
          ]
        },
        "update_title": {
          "type": "string",
          "maxLength": 100
        },
        "update_notes": {
          "type": "string",
          "maxLength": 2000
        },
        "store_url": {
          "type": "string",
          "format": "uri"
        },
        "default_store": {
          "type": "string",
          "pattern": "^[a-z0-9_]{1,32}$",
          "description": "Store key of store_url (specs/app-stores.yaml)."
        },
        "store_listings": {
          "type": "array",
          "description": "In the order the console shows; a store repeated is 20001 with data.fields=[store_listings].",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "store",
              "listed_version"
            ],
            "properties": {
              "store": {
                "type": "string",
                "minLength": 1,
                "description": "Store key of specs/app-stores.yaml (that file comes with CT-19b)."
              },
              "listed_version": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Semantic version x.y.z.",
                    "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        },
        "confirmed_stores": {
          "type": "array",
          "description": "Stores whose listed_version is below min_supported_version that the operator confirmed one by one (BR-ID-01 细则); may be empty.",
          "items": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$"
          }
        },
        "expected_row_version": {
          "anyOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ],
          "description": "The row's row_version as the console showed it, null when there is no row yet; a mismatch is 20902."
        }
      }
    }
  },
  "adminListKillSwitches": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminUpdateKillSwitch": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "value",
        "expected_version"
      ],
      "properties": {
        "value": {
          "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
        },
        "expected_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
            }
          ],
          "description": "The switch's `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminListConfigItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminBatchUpdateConfigItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "description": "Keys of one permission point, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "value",
              "expected_version"
            ],
            "properties": {
              "key": {
                "type": "string",
                "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
              },
              "value": {
                "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
              },
              "expected_version": {
                "allOf": [
                  {
                    "type": "integer",
                    "format": "int32",
                    "minimum": 0,
                    "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
                  }
                ],
                "description": "The item's `version` as the console showed it; any mismatch is 20902 for the whole batch."
              }
            }
          }
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminGetConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  "adminUpdateConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "value",
        "expected_version"
      ],
      "properties": {
        "value": {
          "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
        },
        "expected_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
            }
          ],
          "description": "The item's `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminListConfigItemVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminRollbackConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "to_version",
        "expected_version"
      ],
      "properties": {
        "to_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The stored version whose value becomes the new current value; must be older than the current one."
        },
        "expected_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The item's current `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  }
} as const;
