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
            "personalization"
          ]
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The version of the text the user saw (legal.privacy.version and the like)."
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
          "minLength": 1,
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
          "description": "One-time tip (enum tip_key; BR-ATTR-21, BR-INV-03 细则).",
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
