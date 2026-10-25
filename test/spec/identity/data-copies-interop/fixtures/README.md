# B1-27k 已知答案夹具（编排者在宿主机生成，测试作者只消费、不得修改或重算）

- 生成时间：2026-10-25 17:55，18:4x 以 prettier 排版后的 profile.json 重新生成（Asia/Shanghai）；生成者：admin-backend 编排会话（宿主机，沙箱外）。
- 工具：`/Users/zhixing/miniconda3/bin/bsdtar`，`--version` 整行见 bsdtar-version.txt：
  `bsdtar 3.7.4 - libarchive 3.7.4 zlib/1.2.13 liblzma/5.2.6 bz2lib/1.0.8 liblz4/1.9.3 libzstd/1.5.6`
- 明文：src/profile.json、src/readme.txt（逐字节即夹具内容）。
- 口令：`interop-fixture-pass`
- 命令（在 src/ 目录下）：
  `bsdtar --format zip --options zip:encryption=aes256,zip:compression=store --passphrase interop-fixture-pass -cf ../standard-ae2.zip profile.json readme.txt`
- 产物：standard-ae2.zip。两个条目 compression method 99（WinZip AES），AES 扩展字段 0x9901：strength 3（AES-256）、实际方法 0（stored），通用标志 0x9（加密 + data descriptor）。
- **注意：libarchive 按条目选 vendor version——本夹具 profile.json 为 AE-1（CRC-32 照记），readme.txt 为 AE-2（CRC 记 0）**；本系统 encryptDataCopyZip 一律写 AE-2。两者的 AES 负载格式相同（salt 16 字节 ‖ 口令校验值 2 字节 ‖ AES-CTR 密文 ‖ HMAC-SHA1 截 10 字节），只差 CRC 字段与 vendor version。逐字节对照只比单条目 AES 负载，CRC / vendor version 不比。
- 宿主机核验：`bsdtar -xf standard-ae2.zip --passphrase interop-fixture-pass` 解出的内容与 src/ 逐字节相同（diff -r 无差异）；`--passphrase wrong` 退出码 1。
