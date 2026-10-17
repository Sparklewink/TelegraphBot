# TelegraphBot

基于 Cloudflare Workers 架构的高性能 Telegram 智能私信风控与管家机器人。支持访客消息双向转接、全自动 AI/正则内容合规审查、主人自然语言 AI 助理（内置工具调用 / Function Calling）、消息跨域撤回，并内嵌了针对 Cloudflare 网络的 ProxyIP 穿透引擎，彻底解决同生态网络互访触发的 1015 / 1101 阻断难题。

---

## 核心功能

### 1. 访客双向私信与智能回执

* **隐私转接**：访客向机器人发送的所有文字、图片、文件将无缝转发至主人私聊窗口，不暴露主人的真实 Telegram 账号。
* **状态实时回执**：
* 正常消息转发成功后，机器人自动向访客反馈：“已转发，请等待回复”。
* 违规或垃圾消息被拦截时，机器人自动回复：“广告已拉黑”。



### 2. 多层防风控与反垃圾审查

* **动态正则黑名单 (`/banlist`)**：支持主人在聊天中动态添加、删除、查看正则敏感词黑名单。
* **AI 语义风控**：接入大语言模型对消息上下文进行语义分析，精准识别擦边引流、广告买卖、欺诈诱导等隐蔽行为。
* **命中即刻惩处**：违规消息命中后，系统自动向访客发送警示、在 Telegram 端物理删除该条违规消息、向 KV 写入违规日志，并直接拉黑该 UID，不向主人转发骚扰消息，仅发送独立拦截报告。

### 3. 主人专属 AI 管家 (Function Calling)

* **上下文感知操作**：主人回复转发消息或系统拦截报告时，若未加 `/hf` 前缀，AI 将自动读取被回复消息所对应的访客 UID，并理解主人的自然语言（如：“查一下这个人”、“把他拉黑，理由是刷屏”），自动调用后台工具完成操作。
* **内置工具集 (Tools)**：
* `block_user`：根据 UID 拉黑用户并写入自定义拉黑原因。
* `unblock_user`：一键解封指定 UID。
* `get_block_log`：调取指定用户的拦截历史与消息原文。
* `check_user_status`：查询用户的拉黑状态与交互时间戳。
* `count_kv`：真实统计绑定的 KV 空间数据总量（规避大模型幻觉）。
* `manage_banlist`：直接通过自然语言让 AI 添加或清理敏感词。
* `send_to_user`：命令 AI 以机器人身份主动向指定 UID 发送私信。



### 4. 精准人工交互控制

* **精准回复机制 (`/hf`)**：回复转发消息时，必须以 `/hf <回复内容>` 开头，机器人方可将内容原样转交至访客窗口并保留引用关系。
* **跨会话消息撤回 (`/recall`)**：回复某条转发消息并输入 `/recall`，机器人将跨会话直接删除访客端发送的对应原消息。
* **纯净无外部依赖**：彻底剥离了第三方远程拉取接口，所有通知与欢迎语均为本地实现，杜绝外部广告注入风险。

### 5. ProxyIP 隧道穿透引擎

* **智能链路降级**：请求外部 AI 接口时优先采用直连模式；一旦目标站点返回 403、502、1015 等拦截状态，系统将无缝切换至 ProxyIP 底层 Socket 隧道。


* **纯 JS TLS 客户端**：在底层 TCP Socket 之上实现了纯 JavaScript TLS 握手，维持目标域名的 SNI 伪装，穿透 Cloudflare WAF 对同生态 Worker 流量的访问限制。



---

## 环境变量配置

在 Cloudflare Worker 的 **Settings** -> **Variables and Secrets** 中添加以下环境变量：

| 变量名称 | 是否必须 | 说明与示例 |
| --- | --- | --- |
| `ENV_BOT_TOKEN` | **必须** | 从 [@BotFather](https://t.me/BotFather) 获取的 Telegram Bot API Token，例如 `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ` |
| `ENV_BOT_SECRET` | **必须** | Webhook 密钥，仅允许字母、数字、下划线及减号，例如 `MySecretToken_2026` |
| `ENV_ADMIN_UID` | **必须** | 主人的 Telegram 数字 User ID，例如 `123456789` |
| `ENV_AI_BASE_URL` | *可选* | AI 服务的 Base URL（开启 AI 必须），例如 `[https://api.openai.com/v1](https://api.openai.com/v1)` 或 `[https://apihub.agnes-ai.com/v1](https://apihub.agnes-ai.com/v1)` |
| `ENV_AI_TOKEN` | *可选* | AI 平台的 API Key（开启 AI 必须），例如 `sk-xxxxxxxxxxxxxxxxxxxxxxxx` |
| `ENV_AI_MODEL` | *可选* | 使用的模型标识（开启 AI 必须），例如 `gpt-4o-mini` 或 `agnes-2.5-flash` |
| `cfip` | *可选* | 穿透 Cloudflare 站点所需的反代 IP/域名池，支持单 IP、带端口或多地址混合，例如 `1.2.3.4:443, proxy.example.com:8443`

 |
| `PROXY_CONCURRENT_DIAL` | *可选* | 底层 Socket 拨号并发数，默认为 `1`<br> |

---

## 部署流程

### 第一步：创建 KV 数据库并绑定

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，导航至 **Workers & Pages** -> **KV**。
2. 点击 **Create a namespace**，创建一个新的命名空间（例如命名为 `bot_kv`）。
3. 进入你创建的 Worker，进入 **Settings** -> **Bindings**。
4. 点击 **Add** -> 选择 **KV Namespace**：
* **Variable name**：必须填入 `nfd`
* **KV namespace**：选择刚才创建的 `bot_kv`


5. 保存并重新部署。

### 第二步：配置环境变量

在 Worker 的 **Settings** -> **Variables and Secrets** 页面，依据上文的变量表格完整填入相应的配置项并保存。

### 第三步：部署代码

将项目的完整代码复制到 Worker 编辑器中，点击右上角 **Save and Deploy**。

### 第四步：注册 Webhook 与菜单命令

部署成功后，使用浏览器直接访问 Worker 提供的注册路由：

```text
https://<你的Worker域名>.workers.dev/registerWebhook

```

* 当浏览器窗口输出 `Ok` 时，表明 Webhook 设置完毕，同时机器人的快捷斜杠命令菜单（`/aiopen`、`/recall` 等）已同步向 Telegram 官方注册生效。

---

## 主人常用指令指南

| 指令 | 说明 |
| --- | --- |
| `/aiopen` | 开启 AI 自动风控拦截与主人管家助理模式 |
| `/aiclose` | 关闭 AI 助理与 AI 风控 |
| `/banlist add <关键词>` | 向敏感词库新增黑名单（支持正则表达式） |
| `/banlist rm <关键词>` | 从敏感词库移除黑名单 |
| `/banlist ls` | 打印当前生效的敏感词列表 |
| `/hf <回复内容>` | **回复某条转发消息时使用**：将文本转发回给对应的访客并建立引用框 |
| `/recall` | **回复某条转发消息时使用**：远程删除访客端发送的原消息 |
| `/block` | **回复某条转发消息时使用**：手动将该访客加入拉黑名单 |
| `/unblock` | **回复某条转发消息时使用**：手动解除该访客的拉黑状态 |
| `/checkblock` | **回复某条转发消息时使用**：查看该访客当前是否在黑名单中 |

---

## 致谢与鸣谢

本项目在实现穿透 Cloudflare 防火墙（解决同域或使用了 Cloudflare 服务的外部 API 抛出 `1015 Rate Limited` 及 `1101` 异常）的网络层方案中，深度参考并借鉴了 [cmliussss](https://github.com/cmliu) 在 [edgetunnel](https://github.com/cmliu/edgetunnel) 项目中设计的 **ProxyIP 架构体系与底层实现方案**：

* 利用 `cloudflare:sockets` 建立直接 TCP 会话，结合动态 DoH 解析地址端口池与并发竞速拨号。


* 移植了轻量级纯 JavaScript TLS 1.2/1.3 客户端握手与报文封包实现，使 Worker 能够通过指定 Anycast 反代节点向受 Cloudflare 保护的 API 站点伪装 SNI 发起通信，彻底突破了 Serverless 运行环境跨边缘节点的互访限制。
