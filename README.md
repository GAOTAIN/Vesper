# Vesper 1.0.0

[下载 Windows x64 免安装 EXE](https://github.com/GAOTAIN/Vesper/releases/latest) · [GitHub 源码仓库](https://github.com/GAOTAIN/Vesper)

Windows 桌面聊天客户端。默认使用完全离线的本地规则和模板，也能连接用户自己的 OpenAI 兼容模型接口。界面、头像、Markdown 和代码高亮均为本地资源，不使用 CDN。

## 直接运行

双击 `dist\Vesper-1.0.0-portable.exe`。这是 Windows x64 免安装单文件，目标电脑无需 Node.js。便携程序启动时会将 Electron 运行文件解压到系统临时目录；首次打开可能稍慢，关闭后由启动器清理。持久数据保存在当前 Windows 账户的用户数据目录，不保存在 EXE 旁边。

首次运行可能被 Windows Defender 或 SmartScreen 提示拦截，这是未签名程序可能出现的提示。确认文件来自你信任的本项目构建后，选择「更多信息 → 仍要运行」。本项目没有购买或嵌入代码签名证书。

## 开发运行

安装 Node.js 24 LTS（至少 22.12）及附带的 npm：<https://nodejs.org/>。在 PowerShell 中运行：

```powershell
cd E:\模拟AI
npm.cmd install
npm.cmd start
```

PowerShell 执行策略限制 `npm.ps1` 时使用 `npm.cmd`，无需修改全局执行策略。首次安装和首次下载 Electron、打包工具需要网络；日后运行模拟模式无需网络。安装过程可能显示上游依赖弃用警告，应以最终退出码判断成功与否。

## 使用

- 左侧「新建对话」或 `Ctrl+N` 创建会话；悬停会话可重命名或删除。顶部可清空当前对话，删除与清空都有二次确认。
- `Enter` 发送，`Shift+Enter` 换行，输入法正在选字时不会发送。输入框最多 32000 字，自适应高度。
- 回复生成时点击「停止」立即取消。当前只允许一个回复任务，可切换会话查看其他记录。
- 向上滚动阅读历史时，流式回复不会强制把视图拉回底部；点击「回到最新消息」恢复跟随。
- 代码块有语言标签和复制按钮；支持表格、列表、引用和行内代码。消息中的链接点击后复制地址，可自行在浏览器打开；图片仅显示文字说明，避免远程图片产生隐式网络请求。
- 设置中可选跟随系统、浅色和深色主题，折叠侧栏状态也会保存。

## 模式与连接

**模拟模式（默认）：** 本地识别问候、代码、翻译、闲聊、计划和比较等意图，组合模板，普通文字回复随机 2–5 句。开始前思考 300–800ms，每个字符延迟 15–45ms。能引用上一条用户消息的关键词，代码与表格意图包含 Markdown 演示。翻译仅有少量短语词库，不具备真实模型推理能力。每条模拟回复都标注「（模拟模式 · 未连接真实模型）」。

**在线模式：** 打开设置，选择在线模式，填写接口地址、密钥和准确的模型名，点击「测试连接」，保存后立即用于下一条消息。正在生成的回复继续使用发送时的模式，各条回复上方保留来源标记。

| 预设 | Base URL | 默认模型名 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 本机 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

预设只负责填表，实际可用模型、服务地址、参数与账户权限以提供方为准。Ollama 需先自行安装、启动并下载对应模型，可留空密钥；如之前保存过云端密钥，勾选「移除已保存的密钥」后保存。不同提供方请使用各自的密钥。程序将向 `{Base URL}/chat/completions` POST，地址请勿再包含 `/chat/completions`。智谱地址使用它自己的 `/api/paas/v4` 路径，不要机械追加 `/v1`。

在线请求为 `stream: true` 的 Chat Completions，含系统提示词、当前会话历史和 Temperature（0–1.5，默认 0.7）。测试连接发送极短消息，最多 8 个输出 token，可能按提供方规则计费。兼容 SSE 的 `data:` 行、跨包中文、CRLF、空行和 `[DONE]`。总请求超时为 60 秒；接口仅支持非流式或 Responses API 时不能使用。部分模型不支持 Temperature 或 `max_tokens` 时会返回提供方的可读错误，应换用兼容模型。

远程接口仅允许 HTTPS；HTTP 仅供 `localhost`、`127.0.0.1`、`[::1]` 的本地服务使用。程序拒绝跨站重定向，防止密钥随重定向发往另一地址。

## 数据与密钥

数据目录：`app.getPath('userData')`，标准 Windows 用户下为 `%APPDATA%\Vesper\`：

- `conversations.json`：会话、消息、标题和当前选中的会话。
- `settings.json`：模式、地址、模型、主题、侧栏、提示词、Temperature，以及 safeStorage 加密后的密钥。
- `window.json`：正常窗口的宽高、位置以及最大化状态。

**密钥只保存在本机，不上传到任何第三方存储。** 在线请求必须将密钥用于你配置的接口认证，并发送当前会话历史；由你选择的接口提供方处理这些请求。模拟模式不发起任何网络请求。程序没有遥测、广告或后台更新请求。

API Key 由 Electron `safeStorage` 使用 Windows 当前用户的系统保护加密后落盘。加密不可用时拒绝明文保存；默认仅显示最后四位，用户主动点击「显示」才解密展示。关闭设置后清空页面中的密钥输入值。把加密文件复制到其他 Windows 用户或电脑通常无法解密，需重新填写。会话正文是普通 UTF-8 JSON，备份时请自行保护隐私。

文件使用临时文件加原子替换写入。读取损坏 JSON 时尝试保留 `.damaged-时间戳` 备份并提示。异常退出时未结束的回复标为中断。重开后若上次窗口位置已不在可用显示器上，会恢复到可见位置。

## 重新打包（三行）

```powershell
cd E:\模拟AI
npm.cmd install
npm.cmd run dist
```

产物：`E:\模拟AI\dist\Vesper-1.0.0-portable.exe`。`dist\win-unpacked` 是构建中间目录，分享时只需发送 portable EXE。打包配置为 `appId: com.vesper.app`、`productName: Vesper`、Windows x64 `portable`，图标为 `build/icon.ico`。

`npm run icons` 从手写 `assets/icon.svg` 用 sharp 生成 256×256 的 `build/icon.png` 和含 16/32/48/64/128/256 像素 PNG 的 `build/icon.ico`。`npm install` 的 postinstall 使用 esbuild 把本地 markdown-it、highlight.js 合并成 `renderer/vendor.js`，没有引入前端框架。运行时没有 native npm 模块，所以禁用了多余的 native rebuild。

构建脚本使用 `path.resolve`、参数数组和相对配置路径，支持根目录含中文；没有写死 `E:\模拟AI` 的构建绝对路径。Electron 与 builder 下载缓存位于 `.cache`。若本机压缩工具、杀毒软件或企业策略仍对中文路径报错，可把**整个项目源代码**复制到 `E:\VesperBuild`，在该处运行以上安装、打包命令，再将生成的 EXE 复制回 `E:\模拟AI\dist\`，不要仅移动 `node_modules`。一般不需要此回退。

如果 Electron 下载失败，检查能否访问 npm registry 和 GitHub Releases，按网络策略配置代理后重试 `node node_modules/electron/install.js`。无需禁用 Windows 安全防护或关闭 Electron 沙箱。

## 自检

```powershell
npm.cmd test
```

自动检查使用 `work\test-profile-时间戳` 独立数据目录和本机 HTTP 测试服务，不修改日常用户数据，不使用真实 API Key。覆盖断网模拟、逐字输出、上下文、IPC、安全边界、代码高亮和复制、SSE 分包、表格、停止、连接测试、中文错误、加速时钟的超时逻辑、加密、会话操作、最小窗口和关闭重建持久化。`work\test-results.json` 保存结果。

本机兼容服务测试不能替代真实云端接口验收；没有用户自己的真实密钥时，不会声称已验证 OpenAI 等云端模型。实际本次交付结果见 `验收报告.txt`。

本次使用 Node.js 24.19.0、npm 11.17.0、Electron 43.8.0、electron-builder 26.15.3。7 项核心检查和 10 项完整窗口检查均已通过，另有主题静态审计和 WCAG 对比度检查。完整窗口检查另行打包为临时自检程序，在普通桌面会话运行，以避开 Codex 外层沙箱对嵌套 Electron 进程的限制；该自检程序不属于交付应用。

本次 Vesper 版本直接以本目录为项目根构建 portable EXE，并核对生产包、自检包与源码的运行资源一致性。普通 Windows PowerShell 使用上面的三行命令即可。重新打包前请先关闭正在运行的Vesper，避免 Windows 锁定旧 EXE。

如果开发启动出现 `Sandboxed processes cannot read ...`，在项目根目录的普通 PowerShell 执行下面命令，给下载的 Electron 运行库增加读取/执行权限后重试；无需关闭 Electron 沙箱：

```powershell
icacls ".\node_modules\electron\dist" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /Q
```

也可运行 `npm.cmd run test:core` 单独检查模拟模板、SSE、取消、超时、中文错误和 ICO 格式。真实云端接口尚未测试，需在设置中填写你自己的凭据后测试连接。

## 文件说明

```text
package.json / package-lock.json   依赖、锁定版本与打包配置
main.js                           窗口、IPC、JSON、加密、模拟引擎与在线请求
preload.js                        最小业务 API
renderer/index.html               全中文页面与设置抽屉
renderer/styles.css               黑蓝 / 白蓝双主题与集中颜色变量
renderer/app.js                   会话交互、Markdown、滚动与流展示
renderer/vendor.js                npm 本地依赖生成的浏览器资源
assets/icon.svg                   手写图标源
build/icon.png / build/icon.ico    16–256 像素 ICO 与 256×256 PNG
scripts/generate-icon.cjs          图标生成
scripts/prepare.cjs                本地依赖合并
scripts/run.cjs                    构建与自检入口
scripts/smoke.cjs                  本机端到端自检
dist/                             单 EXE 与打包中间文件
```

依赖按各自开源许可证分发；生成的 vendor 保留许可证声明，Electron 随包附带其运行库许可证。


## Vesper 品牌与双主题升级

界面、窗口标题、应用名、IPC 命名、appId 和 portable 产物均已更新为 Vesper。图标为左右对称开口弧与中心实心点，使用同一 SVG，通过 currentColor 在两个主题下着色。新品牌的数据目录为 `%APPDATA%\Vesper`；原有数据目录没有删除或改写。

所有应用色值与代码语法色都集中在 renderer/styles.css 顶部变量中。两份本地 GitHub 高亮主题预载后由 data-theme 同步选择，切换时不请求资源。为满足白字对比度，实心按钮及在线徽章使用独立的实心蓝变量；深色链接等仍使用指定主蓝。代码 Token 采用 GitHub 原色，其余界面使用黑、白、灰、蓝。

静态审计：`node scripts/theme-audit.cjs`。详细改动、颜色变量表与本次验收结果见 `配色验收报告.md`。
