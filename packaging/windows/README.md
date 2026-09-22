# OMP Pet Adapter — Windows x64

## 中文

本包包含 OMP `/pet` 扩展、Windows x64 运行程序和 WebView2 加载器。需要已安装 OMP 和 Microsoft Edge WebView2 Runtime。不附带角色素材，安装时不会自动导入宠物。安装器复制前校验全部 payload 的 SHA-256。

完整解压后双击 `install.cmd`，或运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 命名配置 / named profile
.\install.ps1 -Profile work
```

任务结束后重启 OMP，执行 `/pet`。自行导入有权使用的 v2 宠物包：`/pet import "C:\path\to\pet-package"`。未导入时显示占位内容。运行 `uninstall.cmd` 或 `uninstall.ps1` 卸载；命名配置使用同一个 `-Profile`，已导入素材保留。

本项目独立于 OpenAI 和 Oh My Pi 官方。代码 MIT；第三方许可证见随包文件。版本化动画节奏见 `payload/docs/ANIMATION_TIMING.md`。

## English

This archive includes the OMP `/pet` extension, Windows x64 runtime and WebView2 loader. Requires an installed OMP and Microsoft Edge WebView2 Runtime. No character artwork is bundled or imported automatically. The installer checks every payload SHA-256 before copying.

Fully extract the archive and run `install.cmd`, or use the PowerShell commands above. For a named profile, pass `-Profile work`.

Restart OMP after the current task finishes and run `/pet`. Import a compatible v2 package you have permission to use: `/pet import "C:\path\to\pet-package"`. A placeholder appears before import. Run `uninstall.cmd` or `uninstall.ps1` to remove the adapter, using the same `-Profile` if applicable. Imported pet data is preserved.

Independent of OpenAI and Oh My Pi. Project code is MIT; see the bundled third-party licenses. Versioned animation cadence is documented in `payload/docs/ANIMATION_TIMING.md`.
