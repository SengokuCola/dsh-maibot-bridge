# dsh-maibot-bridge

让麦麦连接正在运行的 **dsh Desktop**。任务、思考和工具操作显示在 Desktop 的「麦麦」会话中，可以在麦麦 WebUI 或 Desktop 中继续。复用 dsh 自带的 ACP 实现、模型、凭据、插件及持久化会话。

普通 dsh CLI 无需安装本插件，麦麦内选择「dsh CLI」即可使用 `dsh --profile acp`。

## 安装

需要 dsh Desktop **0.2.1-rc.2 或兼容的 0.2.x 版本**。先在 Desktop 的菜单中安装其自带的 dsh 命令，用 `dsh --version` 确认命令指向 Desktop 的运行时。

```powershell
dsh plugin --profile desktop add https://github.com/SengokuCola/dsh-maibot-bridge/releases/download/v0.1.0/dsh-maibot-bridge-0.1.0.tgz
```

启动或重启 Desktop，然后在麦麦高级设置的「独立 Agent」中选择：

- Agent 后端：外接 ACP Agent。
- 连接方式：dsh Desktop。
- Desktop 桥接文件：通常留空，自动读取 `~/.dsh/maibot-desktop.json`。
- ACP 模型选项：留空使用 Desktop 自身的模型设置。

启用并保存后，在麦麦的「独立 Agent」页面下达任务。Desktop 中会出现工作目录对应的工作区及「麦麦」会话。普通聊天通过 `agent_talk` 双向传递文字与图片，麦麦的电脑工具也可按需挂载。

CLI 与 Desktop 各自保存会话身份，切换连接方式不跨 Host 接管写入中的会话。

## 连接与退出

插件只监听 `127.0.0.1` 的随机端口，每次启动生成随机认证令牌，将连接信息保存在用户目录下；麦麦读取文件后认证，令牌不会进入模型上下文。不要分享这个桥接文件。

麦麦关闭时只关闭它自己的 ACP 会话与连接，不退出 Desktop，不影响其他会话。退出 Desktop 会断开连接，麦麦报告错误并暂停，不会偷偷切换到 CLI 或重放任务。

插件不复制模型凭据，不修改 Desktop 核心代码，不对公网提供接口。

## 开发

```powershell
node --test test/*.test.js
npm pack
```

通过 Desktop 自带命令将生成的 `.tgz` 安装到测试 profile。插件代码在独立 Git 仓库中维护。
