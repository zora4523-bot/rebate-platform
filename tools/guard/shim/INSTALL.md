# codex 垫片：安装说明（给负责人）

**现状：还没有安装。** 仓库里只有 `tools/guard/shim/codex` 这个文件，你的 `PATH` 和 `~/.codex` 都没有被改动。安装已获批准（规划/11 §7.3 第 5 项），但要由你本人做，或在对话里明确让 Claude 做。

## 它做什么

垫片是一个也叫 `codex` 的小脚本，排在真正的 codex 前面：

| 在哪里运行 | 结果 |
| --- | --- |
| 凑狸项目目录里（`rebate-platform`、`couli-runs/worktrees/…`、`couli-runs/trusted/…`），或用 `-C` / `--cd` 指到这些目录 | 拒绝，退出码 126，打印中文说明。只有包装脚本 `tools/agent/codex-run.sh`（它会设置 `COULI_CODEX_WRAPPER=1`）能通过 |
| 其他任何目录 | 原样转给真正的 codex，参数和环境都不动。你的其他项目不受影响（规划/11 §7.3 第 9 项选 A：不改 Codex 全局配置） |
| `codex --version`、`codex --help` | 任何目录都放行 |

原因：这台电脑上 Codex 的默认配置是全盘读写加联网，本项目只允许经包装脚本、带显式沙箱调用（规划/11 §2.4）。

## 安装步骤

真正的 codex 现在装在 nvm 目录下（`~/.nvm/versions/node/v24.15.0/bin/codex`），nvm 初始化时会把这个目录排到 `PATH` 最前面，所以垫片要在 **nvm 初始化之后** 再加到最前。

1. 在 `~/.zshrc` 的**最后一行**加上：

   ```bash
   export PATH="/Users/zhixing/我的项目/rebate-platform/tools/guard/shim:$PATH"
   ```

2. 打开一个新终端，检查顺序。第一行应当是垫片：

   ```bash
   which -a codex
   ```

3. 验证：

   ```bash
   cd ~ && codex --version                       # 正常输出版本号
   cd "/Users/zhixing/我的项目/rebate-platform" && codex exec hello; echo $?
   # 应当打印「已拒绝：在凑狸项目目录里不能直接运行 codex」，最后一行是 126
   ```

4. 重开 Claude Code，让新会话带上新的 `PATH`。

注意：

- 不要把垫片文件复制到别处用。它靠自己所在的位置判断哪些目录要保护；复制出去的副本会打印「未启用保护」并直接放行。要放到别的目录，用软链接（`ln -s`），或者设置 `COULI_SHIM_GUARD_DIRS`（用冒号分隔的目录清单）。
- 在某个终端里执行 `nvm use` 之后，nvm 会重新把自己的目录排到最前，垫片在那个终端里失效；新开终端即恢复。Claude 会话一侧还有拦截钩子兜底（见 `../hooks/INSTALL.md`）。
- 可信副本 `couli-runs/trusted/rebate-platform` 建好之后，把第 1 步的路径换成 `…/couli-runs/trusted/rebate-platform/tools/guard/shim`，保护范围不变。

## 卸载

删掉 `~/.zshrc` 里第 1 步加的那一行，重开终端和 Claude Code。

## 已知限制

- 垫片防的是误用，不是有意绕过：用绝对路径直接调用真正的 codex 可以越过它。这一层由拦截钩子补（它不看 `PATH`，按命令内容判断）。
- 垫片不检查参数是否合规（沙箱、`--ignore-rules` 等），那是包装脚本和钩子的事。
- 选 A 的遗留问题没有变：Codex 仍会把每个 worktree 路径写进 `~/.codex/config.toml` 的信任列表，如何避免未测（规划/11 §7.3 第 9 项）。
