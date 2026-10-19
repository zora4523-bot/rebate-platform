// Generated from specs/app-stores.yaml by content/specs/scripts/generate-text-specs.ts.
// Do not edit by hand. Regenerate after changing the specification.
export const APP_STORES = {
  "version": "0",
  "stores": [
    {
      "key": null,
      "name": "App Store",
      "platform": "ios",
      "channels": [
        "appstore"
      ],
      "install_source_packages": [],
      "detail_page": {
        "open_method": null,
        "target": null
      },
      "source": "规划/03 §4.1（iOS 跳 App Store 的详情页）；商店键与打开方式待接入时按官方文档填"
    },
    {
      "key": null,
      "name": "华为应用市场",
      "platform": "android",
      "channels": [
        "huawei"
      ],
      "install_source_packages": [],
      "detail_page": {
        "open_method": null,
        "target": null
      },
      "source": "规划/03 §4.1（华为渠道 Android 包跳华为应用市场）；商店键、安装来源包名与打开方式待接入时按官方文档填"
    },
    {
      "key": null,
      "name": "鸿蒙系统应用市场",
      "platform": "harmony",
      "channels": [
        "agc"
      ],
      "install_source_packages": [],
      "detail_page": {
        "open_method": null,
        "target": null
      },
      "source": "规划/03 §4.1（鸿蒙跳系统应用市场的详情页）；商店键与打开方式待接入时按官方文档填"
    }
  ]
} as const;
