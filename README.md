# opencode-wechat-notify

给编程 Agent 用的微信桥：用微信 ClawBot（iLink bot API）接收回复、批准权限、发消息。只用 Node 标准库，没有依赖。

| | 推送回复/出错 | 微信里批准 | 微信里发消息、看历史 |
| --- | --- | --- | --- |
| OpenCode 桌面端 | ✓ | ✓ | ✓ |
| OpenCode 终端（`opencode`、`opencode run`，默认模式） | ✓ | ✓ | ✓ |
| OpenCode 终端 `--standalone` | ✓ | 未验证 | 未验证 |
| Codex 桌面端、Codex CLI（hooks） | ✓ | ✓ | 下一步 |

OpenCode 部分是 V2 服务端插件（`index.js`），Codex 部分是 hook 脚本（`codex-hook.js`），两边共用编号和微信登录。

## 前提

- Node.js 20.3 以上（OpenCode 插件跑在 OpenCode 里；Codex hook 用系统的 `node` 运行，读 Codex 会话标题要 Node 22.5 以上，否则标题显示「未命名会话」），OpenCode 2.x 桌面端（后台服务 `opencode serve --service`）。
- 先用 [cli-chat-bridge](https://www.npmjs.com/package/cli-chat-bridge) 的 `wechat-setup` 登录微信机器人。插件只读取它保存的凭据，不会改写：
  - `~/.cli-bridge/account.json`
  - `~/.cli-bridge/context_tokens.json`

## 安装

在全局配置 `~/.config/opencode/opencode.json` 的 `plugins` 里加上本目录的绝对路径：

```jsonc
{
  "plugins": ["C:/path/to/opencode-wechat-notify"]
}
```

然后退出再打开桌面端，或者运行 `opencode service restart`。

终端版 `opencode` / `opencode run` 默认连同一个后台服务，不用另外配置。`--standalone` 会自己起一个私有服务：插件在里面也加载，所以照样推送；微信里的命令发给后台服务处理，对私有服务里正在运行的对话是否有效没验证过（见「注意」）。

## Codex（桌面端和 CLI）

Codex 桌面端和 `codex` CLI 都读 `~/.codex/hooks.json`。在里面加两个 hook（文件已存在就合并进 `hooks` 里，别删别的条目），路径换成本目录：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\opencode-wechat-notify\\codex-hook.js\" Stop", "timeout": 15 }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\opencode-wechat-notify\\codex-hook.js\" PermissionRequest", "timeout": 600, "statusMessage": "等微信批准" }] }
    ]
  }
}
```

新加或改过的 hook 要先信任才会运行，没信任的 hook 会被跳过：在终端运行 `codex`，输入 `/hooks`，把这两个 hook 设为信任。信任记在 `~/.codex/config.toml` 的 `[hooks.state]` 里，桌面端也认（两边读同一份配置）。改了 `command` 或 `timeout` 要重新信任。

- **回复完成**（`Stop`）：推送 `[编号] Codex · 目录 / 标题` 和最终回复，回复里提到的图片也发（规则同下面「图片」）。子代理不推。标题读 `~/.codex/state_5.sqlite`。推送在后台进程里发，不拖慢 Codex。
- **请求批准**（`PermissionRequest`，shell 提权、改文件、MCP 工具）：推送要做的操作和「N y / N n」提示，然后等你回复，等的时候 Codex 停在这一步。`N y` 批准一次，`N n` 拒绝。9 分钟没回复就推「超时，回电脑上处理」，Codex 弹出平常的批准框。等待时长用环境变量 `CODEX_WECHAT_APPROVAL_TIMEOUT`（秒，最多 590）改。
- 微信回复由 OpenCode 后台服务收（见「注意」），它把答案写到 `~/.cli-bridge/codex-pending/`，hook 读到后告诉 Codex。OpenCode 没在运行时照常推送，但会注明微信回复收不到，Codex 直接弹批准框。
- hook 出任何错都直接退出、不做决定，Codex 照常运行。回复推送的结果和错误每次一行，追加在 `~/.cli-bridge/codex-hook.log`；批准 hook 的错误交给 Codex（显示为 hook 失败）。

## 推送

每个对话有一个固定编号，推送的第一行是 `[编号] 项目目录名 / 会话标题`，下面是内容：

- 回复完成（只推顶层会话，子代理不推）：AI 这一轮的最终回复。超过 1500 字会截断，完整内容在桌面端看
- 出错：错误信息
- 请求权限：要做的操作，以及「3 y / 3 n」提示
- 提问/表单：问题、字段和选项

每个事件只推一次（插件在每个项目目录各有一个实例，按事件 ID 去重）。

## 在微信里回复

| 发送 | 作用 |
| --- | --- |
| `3 内容` | 把内容作为新消息发到 [3]，桌面端能看到。[3] 在等表单回答时，内容就作为回答（单个字段的表单才行，选项可以回编号） |
| `内容` | 发给你上一次用编号指定的对话（`3 内容`、`3`、`3 历史` 或 `新对话` 都算指定）。从没指定过时发给最近推送的那个。别的对话的推送不会改变目标 |
| `3 y` / `3 n` | 批准一次 / 拒绝 [3] 的权限请求（也认「是」「否」）。必须带编号，单发「y」不会批准任何请求。拒绝会同时拒绝该对话所有待批准的请求。Codex 对话也一样 |
| `3` | 再发一次 [3] 的最后一条回复 |
| `3 历史` / `3 历史 10` | 按从旧到新逐条发回 [3] 最近的消息（你的和 AI 的，默认 5 条，最多 20 条）。AI 调用的工具合并成一行「调用了 …」，思考过程不发。不带编号就是上一次指定的对话，也认 `/history` |
| `列表` | 最近 10 个顶层对话的编号、目录、标题和状态 |
| `目录` | 列出 OpenCode 打开过的文件夹（按最近使用排序） |
| `目录 2` / `目录 马原` | 选中文件夹，并列出它最近的对话 |
| `新对话 内容` | 在选中的文件夹里新建对话并发出内容（不带内容就只新建，接着直接发即可）。模型沿用该文件夹最近一次对话的模型 |
| `图 路径` / `/img 路径` | 把电脑上的图片发到微信。相对路径按「目录」选中的文件夹算；必须以图片扩展名结尾，所以「图片怎么发」照常发给对话 |
| `帮助` | 显示用法 |

Codex 对话目前只支持 `N y` / `N n`。对 Codex 编号发 `N 内容`、`N`、`N 历史` 会回「Codex 对话暂不支持这个操作」，`列表` 只列 OpenCode 对话。

## 图片

- 回复完成推送文字后，插件会找出回复里提到的图片路径，把存在的图片接着发过来：绝对路径（`C:\a\x.png` 或 `C:/a/x.png`）、`file:///` 链接、相对路径（按该对话的项目目录算），也认 markdown 的 `![](路径)`、`[](路径)` 和反引号。带空格的路径要放在反引号或 markdown 链接里。
- 只发 png / jpg / jpeg / gif / webp 普通文件，http/https 链接不管。去重，每条回复最多 4 张；超过 10 MB 的不发，在文字末尾注明「图片太大没发」。
- 上传走 iLink 协议：AES-128-ECB 加密 → `getuploadurl` → 上传到微信 CDN → `sendmessage` 发图片消息。失败只在日志里写一行 `[wechat-notify]` 警告，文字推送不受影响。

## 注意

- **安全**：只处理机器人登录账号本人（`account.json` 里的 `userId`）发来的消息，其他人发的一律忽略。但能用这个微信号、或能拿到 `~/.cli-bridge` 里凭据的人，就能让 OpenCode 执行命令、批准权限。保管好手机和这些文件。
- 不要同时运行 cli-chat-bridge 的 `wechat-opencode` 守护进程。两边会抢同一个机器人的消息。
- 微信的 context_token 大约 24 小时后过期。很久没给机器人发消息时推送会失败（日志里出现 `ret=-2`）。随便给机器人发一条消息就会刷新。
- 只有桌面端后台服务接收微信消息，其他 `opencode serve` 进程只推送。想让别的进程收消息，可以设置 `WECHAT_NOTIFY_POLL=1`，但同一时间只能有一个进程在收。
- 插件自己的状态（编号、收消息游标、最新的 context_token）存在 `~/.cli-bridge/opencode-wechat-notify.json`，OpenCode 和 Codex 共用（Codex 对话的键是 `codex:<线程 id>`）。可以用环境变量 `WECHAT_NOTIFY_DIR` 换目录。
- `opencode --standalone` 的对话会推送，但微信里的 `N 内容`、`N y` 等命令由后台服务执行。后台服务能读到这个对话（数据库共用），可私有服务里等待中的批准请求它大概率管不到。要在微信里操作就别加 `--standalone`。
- Codex 只有 hook，从微信给 Codex 发消息、看 Codex 历史要接 Codex app-server，下一步做。
- 凭据缺失、发送失败或 OpenCode 接口出错时，只在服务日志（`~/.local/share/opencode/log/opencode.log`）里打一行 `[wechat-notify]` 警告，不影响 OpenCode。

## 测试

```sh
npm test            # 命令解析、格式化、截断、去重、Codex 批准握手等自检，不联网
npm run send-test   # 真实发送一条测试消息到微信
```

## 许可证

MIT
