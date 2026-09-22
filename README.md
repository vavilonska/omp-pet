# OMP Pet / OMP 桌宠

[中文](#中文) · [English](#english)

## 中文

独立运行的 Windows 桌宠与 Oh My Pi 扩展。用 `/pet` 显示宠物，以任务气泡呈现当前工作、后台任务和完成提醒；每个 OMP 会话使用独立运行进程。

### 安装与使用

1. 从 [Releases](https://github.com/vavilonska/omp-pet/releases) 下载 Windows x64 ZIP 并完整解压。
2. 运行 `install.cmd`，任务结束后重启 OMP，再执行 `/pet`。
3. 自行准备有权使用的 v2 宠物包，执行 `/pet import "C:\path\to\pet-package"`。包内包含 `pet.json` 和 8×11 精灵图，格式见 [宠物包说明](docs/PET_PACKAGE.md)。

需要 Windows x64、Oh My Pi 和 Microsoft Edge WebView2 Runtime。安装包已包含扩展和桌宠运行程序，使用时不需要 Bun 或 Rust。**不附带角色素材**；未导入宠物时显示占位内容。命名配置可运行 `install.ps1 -Profile work`；卸载运行 `uninstall.cmd`，不删除已导入宠物数据。

### 功能和边界

- `/pet list`、`/pet select`、`/pet use <id>`、`/pet next`、`/pet prev` 切换宠物；`hide`、`show`、`stop` 控制本会话宠物。
- 任务气泡保留工作标题；后台任务可展开；完成提醒保留至点击或下一轮。点击完成提醒会尝试返回原 OMP 窗口，但 Windows 不一定允许抢占焦点。
- 支持拖动、悬停、16 向注视、逐帧动画和减少动态效果设置。`/pet play <state>` 预览动画，`/pet doctor` 检查运行状态。
- 默认数据目录 `%USERPROFILE%\.omp\omp-pet`，可用 `OMP_PET_DATA_DIR` 覆盖。本机通信使用随机端口和 Token，仅监听 `127.0.0.1`。
- 只接收 OMP 事件，不读取 Codex 会话，也不自动导入第三方角色。空白窗口区域允许鼠标穿透。

### 开发

需要 Bun 1.3+、当前稳定版 Rust 和 [Tauri 2 Windows 开发依赖](https://v2.tauri.app/start/prerequisites/)。

```powershell
git clone https://github.com/vavilonska/omp-pet.git
cd omp-pet
bun install --frozen-lockfile
bun run check
bun run package:windows
```

发布验证包含前端／原生构建、63 项 Bun 测试、28 项 Rust 测试、隔离的无界面运行检查、安装／卸载和文件哈希检查。本次未重新进行人工桌面交互验收。协议和动画说明见 [docs](docs)。

代码采用 [MIT](LICENSE)；字体和其他依赖保留其原许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。宠物素材的许可单独处理。本项目与 OpenAI、Oh My Pi 官方无隶属关系。

## English

A standalone Windows desktop-pet runtime and Oh My Pi extension. Use `/pet` to show a pet with active-task bubbles, background jobs and completion reminders. Each OMP session has its own runtime process.

### Install and use

1. Download and fully extract the Windows x64 ZIP from [Releases](https://github.com/vavilonska/omp-pet/releases).
2. Run `install.cmd`, restart OMP after the current task finishes, then run `/pet`.
3. Supply a v2 pet package you have permission to use and run `/pet import "C:\path\to\pet-package"`. A package contains `pet.json` and an 8×11 spritesheet; see the [package format](docs/PET_PACKAGE.md).

Requires Windows x64, Oh My Pi and Microsoft Edge WebView2 Runtime. The archive includes the extension and native runtime; users do not need Bun or Rust. **No character artwork is bundled**; a placeholder appears until a pet is imported. For a named profile, use `install.ps1 -Profile work`. Run `uninstall.cmd` to remove the adapter without deleting imported pets.

### Features and limits

- Switch pets with `/pet list`, `/pet select`, `/pet use <id>`, `/pet next` or `/pet prev`; `hide`, `show` and `stop` control this session's pet.
- Activity bubbles preserve task titles; background jobs expand into a list. Completion reminders persist until clicked or the next turn. Clicking attempts to focus the originating OMP window, subject to Windows focus restrictions.
- Dragging, hover reactions, 16-direction gaze, per-frame animation and reduced motion. Use `/pet play <state>` to preview animation and `/pet doctor` for diagnostics.
- Data defaults to `%USERPROFILE%\.omp\omp-pet`; override with `OMP_PET_DATA_DIR`. Local communication binds only to `127.0.0.1`, using a random port and token.
- Accepts OMP events only; does not read Codex sessions or automatically import third-party characters. Empty window regions pass mouse input through.

### Development

Requires Bun 1.3+, current stable Rust and [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/). Use the clone, install, check and packaging commands in the Chinese section above.

Release validation covered frontend/native builds, 63 Bun tests, 28 Rust tests, an isolated headless runtime check, install/uninstall and file hashes. Manual desktop interaction was not revalidated for this release. See [docs](docs) for protocol and animation details.

Code is [MIT](LICENSE). Fonts and dependencies retain their original licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). Pet artwork has separate terms. This is an independent project, not an official OpenAI or Oh My Pi product.
