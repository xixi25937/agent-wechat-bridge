# opencode-wechat-notify

OpenCode V2 服务端插件。用微信 ClawBot（iLink bot API）查看和操作 OpenCode 桌面端的每个对话。只用 Node 标准库，没有依赖。

## 前提

- Node.js 20.3 以上（只用于 `npm test` / `npm run send-test`，插件本身跑在 OpenCode 里），OpenCode 2.x 桌面端（后台服务 `opencode serve --service`）。
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
| `内容` | 发给最近一次推送的那个对话 |
| `3 y` / `3 n` | 批准一次 / 拒绝 [3] 的权限请求（也认「是」「否」）。必须带编号，单发「y」不会批准任何请求。拒绝会同时拒绝该对话所有待批准的请求 |
| `3` | 再发一次 [3] 的最后一条回复 |
| `3 历史` / `3 历史 10` | 按从旧到新逐条发回 [3] 最近的消息（你的和 AI 的，默认 5 条，最多 20 条）。AI 调用的工具合并成一行「调用了 …」，思考过程不发。不带编号就是最近推送的那个对话，也认 `/history` |
| `列表` | 最近 10 个顶层对话的编号、目录、标题和状态 |
| `目录` | 列出 OpenCode 打开过的文件夹（按最近使用排序） |
| `目录 2` / `目录 马原` | 选中文件夹，并列出它最近的对话 |
| `新对话 内容` | 在选中的文件夹里新建对话并发出内容（不带内容就只新建，接着直接发即可）。模型沿用该文件夹最近一次对话的模型 |
| `帮助` | 显示用法 |

## 注意

- **安全**：只处理机器人登录账号本人（`account.json` 里的 `userId`）发来的消息，其他人发的一律忽略。但能用这个微信号、或能拿到 `~/.cli-bridge` 里凭据的人，就能让 OpenCode 执行命令、批准权限。保管好手机和这些文件。
- 不要同时运行 cli-chat-bridge 的 `wechat-opencode` 守护进程。两边会抢同一个机器人的消息。
- 微信的 context_token 大约 24 小时后过期。很久没给机器人发消息时推送会失败（日志里出现 `ret=-2`）。随便给机器人发一条消息就会刷新。
- 只有桌面端后台服务接收微信消息，其他 `opencode serve` 进程只推送。想让别的进程收消息，可以设置 `WECHAT_NOTIFY_POLL=1`，但同一时间只能有一个进程在收。
- 插件自己的状态（编号、收消息游标、最新的 context_token）存在 `~/.cli-bridge/opencode-wechat-notify.json`。可以用环境变量 `WECHAT_NOTIFY_DIR` 换目录。
- 凭据缺失、发送失败或 OpenCode 接口出错时，只在服务日志（`~/.local/share/opencode/log/opencode.log`）里打一行 `[wechat-notify]` 警告，不影响 OpenCode。

## 测试

```sh
npm test            # 命令解析、格式化、截断、去重等自检，不联网
npm run send-test   # 真实发送一条测试消息到微信
```

## 许可证

MIT
