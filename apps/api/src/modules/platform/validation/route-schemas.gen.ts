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
