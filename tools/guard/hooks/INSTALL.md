# PreToolUse 拦截钩子：安装说明（给负责人）

**现状：还没有安装。** 仓库里只有文件，`~/.claude/settings.json` 没有被改动，现在任何会话都不受这个钩子保护。安装已获批准（规划/11 §7.3 第 5 项），但要由你本人做，或在对话里明确让 Claude 做。装好并验证后，才启用定时心跳（规划/11 §2.2）。

## 它做什么

Claude 每次要执行命令或读写文件之前，先把这次调用交给 `pretooluse.ts` 判断，结果有三种：

| 结果 | 表现 | 对应内容 |
| --- | --- | --- |
| 放行 | 钩子不输出任何东西，原有的权限流程照常 | 下表之外的一切 |
| 要你确认 | 对话里弹出确认，写明中文原因 | 「要确认」各行 |
| 拒绝 | 命令不执行，Claude 收到中文原因 | 「拒绝」各行 |

### 拒绝（没有例外）

| 规则 | 说明 |
| --- | --- |
| 命令里出现 `--dangerously-bypass-approvals-and-sandbox` | 出现在任何位置都拒绝，包括 `echo`、`grep` 的参数和写文件用的 here-document；要查这个词请用 Read / Grep 工具 |
| 不经包装脚本的 `codex exec` | 不满足以下任一条件就拒绝：这条命令自己的前缀里写着 `COULI_CODEX_WRAPPER=1`；`-s` / `--sandbox` 是 `read-only` 或 `workspace-write`；带 `--ignore-rules` 和 `--ignore-user-config`；没有 `network_access=true`、`--add-dir`、`--worktree`、`danger-full-access`、`sandbox_mode=`。另外比规划/11 §8 多拦几种等效写法（对照本机 codex-cli 0.154.0 的 `codex exec --help` 加的，只收紧不放宽）：`--yolo` 和任何 `--dangerously-…` 参数、`-p` / `--profile`、`--approve-for-me`、用 `-c` 改 `sandbox…` 开头的配置（只允许包装脚本自己用的 `sandbox_workspace_write.exclude_slash_tmp`）。全部满足的手打命令也**不放行而是要你确认**：包装脚本内部的 `codex exec` 不经过钩子，所以手打的即使参数合规，也绕过了位置断言、超时击杀、额度账本和产出校验。正常做法是运行 `tools/agent/codex-run.sh`，它不受影响 |

写法上的变化都算：多余空格、绝对路径、`command` / `env` / `nohup` / `timeout` / `xargs` / `npx` 包一层、`bash -c "…"`、`eval`、`$(…)`、反引号、喂给 shell 的 here-document、用 `;` `&&` `|` 或换行串在别的命令后面。

### 要你确认

| 规则 | 例子 |
| --- | --- |
| 读环境文件和密钥文件 | `.env`、`.env.local`（`.env.example` 除外）、`*.p12`、`*.jks`、`*.p7b`、`*.mobileprovision`、`*.pem`、`*.key`、`*.pfx`、`*.keystore`、`*.cer`、`*.csr`（与 `.gitignore` 同一份清单）、`~/.ssh` 下的任何东西；Read / Edit / Write / Grep 工具同样适用 |
| 输出环境变量 | `printenv`、不带命令的 `env`、`export -p` |
| 建库、删库、改仓库设置 | `gh repo create` / `delete` / `edit` / `rename` / `archive` |
| 仓库密钥与登录令牌 | `gh secret …`、`gh auth token` |
| 经接口写入、修改或删除 | `gh api -X DELETE` / `PUT` / `PATCH` / `POST`（`--method` 写法相同），以及带 `-f` / `-F` / `--field` / `--raw-field` / `--input` 的隐式 POST（提交状态、标签、规则集都走这里） |
| 替负责人批准保护路径改动 | `gh pr edit` / `gh issue edit` 加 `owner-approved-*` 标签（或标签来自变量）、`gh label …` |
| 强推、删远端分支、直接推 main | `git push --force`、`-f`、`--force-with-lease`、`+分支`、`--delete`、`--all`、`--prune`、`git push origin main`、在 main 分支上直接 `git push`、目标分支来自变量 / 命令替换 / 通配 |
| 绕过提交前密钥检查 | `git commit` / `git merge` 带 `--no-verify` 或 `-n`、`git -c core.hooksPath=…`、`git config core.hooksPath` |
| 绕过检查合并、发布、手动触发或重跑工作流 | `gh pr merge --admin`、`gh pr merge --auto`、`gh run rerun` / `cancel` / `delete`、`gh release …`（`list` / `view` 除外）、`gh workflow run` |
| 在工作区之外删除 | `rm` / `rmdir` / `find … -delete` 的目标不在当前项目目录，也不在系统临时目录；目标看不出来（变量、`xargs`）也要确认 |
| 访问生产地址 | 命令或网址里出现 `prod-hosts.txt` 列出的主机（清单现在是空的，域名开通后补） |
| 其他方式启动 codex | 直接敲 `codex`、`codex login` 等不经包装脚本的调用；把含 `codex` 的文本用管道喂给 `sh` / `bash`；`python3 -c` / `node -e` / `perl -e` 等内联脚本、`alias`、`trap` 的参数里出现 `codex` |

## 安装步骤

1. 确认 Node 版本不低于 24.15：

   ```bash
   node --version
   ```

2. 先空跑一次，确认脚本能用。下面这条应当打印一段中文拒绝原因，最后一行是 `2`：

   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"codex exec hello"}}' \
     | node "/Users/zhixing/我的项目/rebate-platform/tools/guard/hooks/pretooluse.ts"; echo $?
   ```

3. 打开 `~/.claude/settings.json`，把 `settings.example.json` 里的 `hooks` 一段合并进去。文件里已经有 `hooks` 的话，只把 `PreToolUse` 数组里的那一项加进去，别覆盖原有内容。现在这个文件里没有 `hooks`，直接加一个顶层的 `"hooks": { … }` 即可。

4. 关掉所有 Claude Code 会话再重新打开（钩子在会话启动时读取）。

5. 验证。在任意项目的新会话里让 Claude 执行下面两条：
   - `printenv`：应当弹出确认。
   - `codex exec hello`：应当被拒绝，Claude 会转述中文原因。

   第一条如果没有弹确认而是直接执行了，说明这个版本的「要你确认」在跳过权限模式下不生效（规划/11 §8 已预料这种情况）。把第 3 步里的命令改成下面这样，凡是该确认的一律拒绝：

   ```json
   "command": "COULI_HOOK_ASK_AS_DENY=1 node \"/Users/zhixing/我的项目/rebate-platform/tools/guard/hooks/pretooluse.ts\""
   ```

## 对其他项目的影响

钩子装在用户级，这台电脑上从任何目录启动的 Claude 会话都生效（规划/11 §8 就是这样要求的）。也就是说：

- 在你的其他项目里，Claude 读 `.env`、在项目目录外删文件、强推等，同样会先问你。
- 在你的其他项目里，Claude 直接运行不带沙箱的 `codex exec` 也会被**拒绝**。带齐上面那组参数的调用不受影响。

如果你希望其他项目里的 `codex exec` 只是「要你确认」而不是拒绝，把第 3 步的命令改成下面这样。凑狸项目目录内（`rebate-platform`、`couli-runs`，包括用 `-C` 指进来）仍然一律拒绝：

```json
"command": "COULI_HOOK_CODEX_SCOPE=project node \"/Users/zhixing/我的项目/rebate-platform/tools/guard/hooks/pretooluse.ts\""
```

两个开关可以同时写：`COULI_HOOK_ASK_AS_DENY=1 COULI_HOOK_CODEX_SCOPE=project node …`。

## 路径什么时候要改

`settings.example.json` 里写的是主仓库里的脚本。门禁脚本的可信副本 `couli-runs/trusted/rebate-platform` 建好之后（规划/11 §0），把路径换成：

```
/Users/zhixing/我的项目/couli-runs/trusted/rebate-platform/tools/guard/hooks/pretooluse.ts
```

这样被测分支改不到正在生效的钩子。路径指向不存在的文件时钩子不拦任何东西，也不报错，所以改完路径要重做一次第 2 步和第 5 步。

## 卸载

从 `~/.claude/settings.json` 里删掉第 3 步加进去的那一项，重开会话。仓库里的文件不用动。

## 已知限制

- 无人值守时，「要你确认」的命令会停在那里等人，所以编排脚本自己不用这些命令；清理 `couli-runs` 下的目录不需要确认（它算本项目的工作区）。
- 这是文本层面的判断，不是沙箱：把命令藏进脚本文件再执行，钩子看不到脚本里面。Codex 一侧的保护靠包装脚本和 `codex` 垫片（见 `../shim/INSTALL.md`），越界改动靠路径守卫。
- 事件名和输入字段对照过官方文档，没有在真实会话里触发过（规划/11 §9.3 #5）；第 5 步就是这次实测。
- 生产主机清单 `prod-hosts.txt` 为空：TODO(规划/11 §8)，等域名和云资源开通后由负责人给出。
