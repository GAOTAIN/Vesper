# Vesper 1.1.1

[下载最新 Windows EXE](https://github.com/GAOTAIN/Vesper/releases/latest) · [GitHub 源码仓库](https://github.com/GAOTAIN/Vesper)

Windows 桌面聊天客户端。支持离线模拟、在线模型和基于 Ollama 的真实本地部署三种模式。点击「本地部署 → 本地安装 Ollama」可自动下载、校验并安装运行库，再选择模型下载使用。界面、头像、Markdown 和代码高亮均为本地资源，不使用 CDN。

## 直接运行

从 [v1.1.1 发布页](https://github.com/GAOTAIN/Vesper/releases/tag/v1.1.1) 下载并双击 `Vesper-1.1.1-portable.exe`；本地重新构建的文件位于 `dist`。这是 Windows x64 免安装单文件，目标电脑无需 Node.js。便携程序启动时会将 Electron 运行文件解压到系统临时目录；首次打开可能稍慢，关闭后由启动器清理。持久数据保存在当前 Windows 账户的用户数据目录，不保存在 EXE 旁边。

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

**模拟模式（默认）：** 本地识别项目需求、相关追问、问候、代码、翻译、闲聊和学习计划。吃货地图、记账、待办、笔记等场景会给出具体功能、数据字段和后续步骤，能在相关追问中保留平台选择，并识别“不做登录”“先不做地图”等约束；问候不会被硬套成上下文，新话题也不会搬用旧项目。开始前思考 300–800ms，每个字符延迟 15–45ms。代码与表格均可离线展示。本地规则不具备真实模型的开放问答能力，对未知问题会请求具体信息或说明能力边界；翻译仅支持少量常见短语。每条模拟回复都保留「（模拟模式 · 未连接真实模型）」标识。

**在线模式：** 打开设置，选择在线模式，填写接口地址、密钥和准确的模型名，点击「测试连接」，保存后立即用于下一条消息。正在生成的回复继续使用发送时的模式，各条回复上方保留来源标记。

| 预设 | Base URL | 默认模型名 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 本机 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

预设只负责填表，实际可用模型、服务地址、参数与账户权限以提供方为准。使用本机 Ollama 预设前需准备好运行库、服务和模型，也可通过本客户端「本地部署」面板安装；该预设可留空密钥；如之前保存过云端密钥，勾选「移除已保存的密钥」后保存。不同提供方请使用各自的密钥。程序将向 `{Base URL}/chat/completions` POST，地址请勿再包含 `/chat/completions`。智谱地址使用它自己的 `/api/paas/v4` 路径，不要机械追加 `/v1`。

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

产物：`E:\模拟AI\dist\Vesper-1.1.1-portable.exe`。`dist\win-unpacked` 是构建中间目录，分享时只需发送 portable EXE。打包配置为 `appId: com.vesper.app`、`productName: Vesper`、Windows x64 `portable`，图标为 `build/icon.ico`。

`npm run icons` 从手写 `assets/icon.svg` 用 sharp 生成 256×256 的 `build/icon.png` 和含 16/32/48/64/128/256 像素 PNG 的 `build/icon.ico`。`npm install` 的 postinstall 使用 esbuild 把本地 markdown-it、highlight.js 合并成 `renderer/vendor.js`，没有引入前端框架。运行时没有 native npm 模块，所以禁用了多余的 native rebuild。

构建脚本使用 `path.resolve`、参数数组和相对配置路径，支持根目录含中文；没有写死 `E:\模拟AI` 的构建绝对路径。Electron 与 builder 下载缓存位于 `.cache`。若本机压缩工具、杀毒软件或企业策略仍对中文路径报错，可把**整个项目源代码**复制到 `E:\VesperBuild`，在该处运行以上安装、打包命令，再将生成的 EXE 复制回 `E:\模拟AI\dist\`，不要仅移动 `node_modules`。一般不需要此回退。

如果 Electron 下载失败，检查能否访问 npm registry 和 GitHub Releases，按网络策略配置代理后重试 `node node_modules/electron/install.js`。无需禁用 Windows 安全防护或关闭 Electron 沙箱。

## 自检

```powershell
npm.cmd test
```

自动检查使用 `work\test-profile-时间戳` 独立数据目录和本机 HTTP 测试服务，不修改日常用户数据，不使用真实 API Key。覆盖断网模拟、逐字输出、上下文、IPC、安全边界、代码高亮和复制、SSE 分包、表格、停止、连接测试、中文错误、加速时钟的超时逻辑、加密、会话操作、最小窗口和关闭重建持久化。`work\test-results.json` 保存结果。

本机兼容服务测试不能替代真实云端接口验收；没有用户自己的真实密钥时，不会声称已验证 OpenAI 等云端模型。`验收报告.txt` 与 `配色验收报告.md` 保留 1.0.0 配色版本的历史结果，1.0.1 的模拟改进见本页后文。

本次使用 Node.js 24.19.0、npm 11.17.0、Electron 43.8.0、electron-builder 26.15.3。7 项核心检查、23 项模拟场景检查及 11 项完整窗口检查均已通过，另有主题静态审计和 WCAG 对比度检查。1.0.1 的完整窗口检查直接通过 npm.cmd test 在独立数据目录后台运行，测试入口不随生产应用打包。

本次 Vesper 版本直接以本目录为项目根构建 portable EXE，并核对生产包与源码的运行资源一致性。普通 Windows PowerShell 使用上面的三行命令即可。重新打包前请先关闭正在运行的 Vesper，避免 Windows 锁定旧 EXE。

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

静态审计：`node scripts/theme-audit.cjs`。配色版本的历史改动、颜色变量表与验收结果见 `配色验收报告.md`。


## 本地部署模式（Ollama）

本地模式在本机运行真实模型，不使用在线模式的 Base URL、API Key，也不会自动回退到云端或模拟回复。首次下载模型需要访问模型仓库；模型安装完成后可断网聊天。

### 启动与部署

1. 在 Vesper 顶部点击「本地部署」，再点击「本地安装 Ollama」。程序会下载官方 Windows 稳定版运行库、核对官方 SHA-256 和 Windows 数字签名、静默安装到当前 Windows 账户，然后自动连接本机服务。无需手动打开官网、运行安装器或输入命令；已有 Ollama 会直接复用。
2. 运行库安装完成后，面板显示「Ollama 已就绪」。后续可直接选择「启动或重新连接」；程序先请求本机 `/api/tags`，能连接就复用，连不上才静默启动 `ollama serve`。
3. 可先选择模型文件夹。更换目录会暂停下载、停止当前本地回复，并更新 Windows 用户级 `OLLAMA_MODELS`。Vesper 只重启自己启动的服务；外部服务需先退出托盘 Ollama，再点击「应用目录并重启」。界面分别展示当前与待生效目录，原文件不会自动迁移或删除。
4. 选择模型并点击「下载部署」。硬件低于推荐要求时，红色警告提供「取消」「强制继续」。下载可暂停，重开后显示「继续下载」。
5. 下载完成后点击「用于聊天」，关闭面板即可发送。当前模型会显示在输入框附近；已安装模型右键可「查看配置需求」。

如果本机没有 Ollama，Vesper EXE 仍能启动，模拟／在线模式正常，但真实本地推理必须先安装运行库与模型。模型和运行库独立于 Vesper EXE，不能把单个客户端文件当作已包含全部模型的离线安装包。

### 一键安装的进度与故障处理

- 安装流程显示检查、下载百分比与容量、校验、安装、连接六个阶段。安装器没有可靠的百分比接口，因此安装阶段使用不定进度，不伪造数值。
- 首次安装需要访问 GitHub 上的 Ollama 官方发布仓库，运行库下载大小以最新发布为准（本次核验 v0.40.6 约 1.58 GB）。运行库安装至少需要 4 GB，下载缓存需要额外空间；模型空间另计。元数据限流、断网、磁盘不足、校验失败和安装器错误均显示中文原因并允许重试。
- 下载或校验阶段可以取消；当前运行库临时下载不会断点续传，重新安装会重新下载。模型权重的断点续传行为不受影响。安装阶段不能取消；关闭窗口会等待官方安装器完成后再退出，不强杀安装器。
- 缓存位于 `userData/runtime-cache`，不包含 API Key。校验前不执行下载内容；SHA-256 或数字签名不通过时拒绝安装。签名校验使用 Windows 自带 PowerShell 安全模块，不关闭系统安全功能。
- 运行库采用 Ollama 官方当前账户安装方式，由其安装器注册卸载入口等系统信息，可在 Windows「已安装的应用」中卸载 Ollama。模型文件夹选项只设置模型位置，不改变运行库的默认安装位置。
- 安装后仅连接并刷新列表，不擅自下载模型。请在下方选择模型并「下载部署」，完成后才能进行真实本地聊天。

### 服务、隐私与资源限制

- 本地请求固定直连 `http://127.0.0.1:11434`，全部在主进程中使用原生 HTTP 发出，不使用系统 HTTP 代理、不跟随重定向。渲染进程没有网络或命令执行权限。
- Vesper 管理的服务设置 `OLLAMA_NO_CLOUD=1`、`OLLAMA_NUM_PARALLEL=1`、`OLLAMA_MAX_LOADED_MODELS=1`。复用外部服务时，发送前通过 `/api/show` 检查本地权重，拒绝带远程模型信息或无法确认的模型。
- 聊天使用 `/api/chat` 的 NDJSON 流，显式传入 `num_ctx: 4096`、`num_predict: 1024`，最多携带最近 10 轮完整历史与当前输入；还按字节预算裁掉旧历史。单条输入最多 6000 UTF-8 字节，系统提示最多 3000 字节；这些长度限制不是精确分词，最终上下文窗口仍由 Ollama 控制。
- 停止按钮中断 HTTP 连接，包括服务启动、硬件检测等待阶段。模型空闲保留约两分钟，停止不等于立即卸载权重；资源不足时会给出中文错误。
- 显存依次使用 `systeminformation.graphics()`、PATH 中的 `nvidia-smi`、固定路径 `C:\\Windows\\System32\\nvidia-smi.exe`。均失败时显存记 0，并以 `num_gpu: 0` 请求 CPU 回退。
- 内存优先使用 `systeminformation.mem()`，失败回退到系统接口。硬件检测带超时、并发合并和 30 秒缓存。容量使用 GiB；模型下载的 `sizeGb` 使用十进制 GB。推荐配置按 GiB 比较，内存允许 4% 的系统保留余量，显存允许 1% 的容量报告余量并按最大单卡保守评估。
- 推荐配置仅为项目估算，不代表驱动兼容或保证无内存不足。外部 Ollama 同时服务其他应用时，本客户端无法限制它们的并发与资源占用。

### 下载状态与文件

`userData/local-deployment.json` 保存目录、所选模型、`downloading_models` 数组，以及按存储目录区分的下载记录。状态在推送可见整数进度前原子落盘，最高进度使用 `Math.max` 保持不倒退；安装成功并核对列表前最高为 99%。实际缓存复用由 Ollama 决定，若缓存被其他程序删除，继续下载可能需要重新获取数据。

卸载成功后立即删除相应下载记录和进度，刷新安装列表；共享权重的回收交给 Ollama，程序不递归删除用户模型目录。意外退出后，未完成下载会显示「继续下载」，不会自动开始大文件下载。

| 模块 | 职责 |
| --- | --- |
| `assets/models.json` | Qwen 2.5 3B／7B／14B、Llama 3 8B 的目录与估算配置 |
| `main/local/catalog.cjs` | 目录校验、本地标签限制、推荐配置比对 |
| `main/local/hardware.cjs` | 三层显存检测、内存回退、缓存和超时 |
| `main/local/ollama-client.cjs` | 回环 HTTP、NDJSON、超时与中断 |
| `main/local/ollama-installer.cjs` | 官方运行库下载、双重校验、静默安装、取消与状态推送 |
| `main/local/ollama-service.cjs` | 探活、静默启动、进程归属、目录和重启 |
| `main/local/model-manager.cjs` | 下载确认、进度、恢复、卸载和选择模型 |
| `main/local/local-chat.cjs` | 有界上下文、本地权重校验、流式聊天 |
| `main/local/local-store.cjs` | 本地 JSON 配置与原子更新 |
| `main/local/ipc.cjs` | 状态快照、业务 IPC 与进度推送 |
| `renderer/local-panel.js` | 模型商店、右键菜单、硬件警告与管理交互 |

### 检查命令

```powershell
npm.cmd run test:installer
npm.cmd run test:installer-window
npm.cmd run test:local
npm.cmd run test:local-integration
npm.cmd run test:local-window
node scripts/theme-audit.cjs
```

测试覆盖真实 Electron 窗口和本机 HTTP 测试服务。进程启动／重启与 Windows 用户环境变量更新采用受控替身验证，不会更改开发机注册表；模型下载与推理测试使用模拟 Ollama 协议，未下载真实权重。真实运行库／模型推理的实测情况以本次交付验收报告为准，不能将协议自检当作真实模型质量或 GPU 推理验证。

报告与截图写入 `work/local-unit-results.json`、`work/local-integration-results.json`、`work/local-window-results.json`、`work/local-panel-light.png`、`work/local-panel-dark.png` 和 `work/local-models-dark.png`。测试使用独立数据目录，不改日常聊天记录。

## 1.0.1 模拟对话改进

修复项目需求被通用模板敷衍、无条件引用上一句问候、代码关键词抢占解释或学习意图的问题。相关追问可承接项目、平台和约束，重复提问优先推进到下一步；未覆盖的问题不会被伪装成已经解答。

运行 `npm.cmd run test:simulation` 检查 23 项模拟场景，`npm.cmd test` 包含吃货地图、网页版追问及业务代码的完整渲染链路。升级后请先关闭已运行的旧版本，再启动新的 EXE；新引擎只影响新回复，不修改历史记录。

## 1.1.1 一键安装运行库

在「本地部署」中点击「本地安装 Ollama」即可完成运行库下载、校验、静默安装和自动连接。详细实测范围见 `一键安装验收报告.md`；可选真实网络检查为 `npm.cmd run test:installer-network`，只取安装包约 1 MiB，不执行安装器。
