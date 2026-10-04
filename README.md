# scrcpy GUI

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)]()
[![Electron](https://img.shields.io/badge/Electron-32-47848F)](https://electronjs.org)
[![scrcpy](https://img.shields.io/badge/scrcpy-4.0-4CAF50)](https://github.com/Genymobile/scrcpy)

一个深色主题的 [scrcpy](https://github.com/Genymobile/scrcpy) 图形启动器。

GUI 只负责**管参数、管进程、发即时按键**；镜像画面仍然由原生 scrcpy 窗口显示，
因此延迟和画质与 scrcpy 完全一致——没有任何二次转码或画面内嵌。

```
┌─────────────┬──────────────────────────────────┐
│  设备列表    │  设备名 · 有线/无线 · Android 版本 │
│  (3秒刷新)   ├──────────────────────────────────┤
│             │  参数面板（画质/窗口/音视频/…）    │
│  ● 有线      │                                  │
│  ● 无线      ├──────────────────────────────────┤
│             │  启动 · 停止 · 重启               │
│  ＋网络调试  │  ← ⌂ ▤ 🔊 🔉 ⏻ 📸 ⛶            │
└─────────────┴──────────────────────────────────┘
```

## 功能

- **设备列表**：每 3 秒自动刷新，显示型号、Android 版本、电量、连接方式。
- **网络调试**：自动读取手机 wlan0 的 IP，一键开启无线调试，无需手打地址。
- **多设备并行**：每台设备配置独立，可同时开多个原生 scrcpy 窗口。
- **快捷操作**：返回 / 主页 / 应用 / 音量 / 电源 / 截图 / 沉浸模式，全部即时生效。
- **参数面板**：40+ 项 scrcpy 参数，分 5 组可折叠。
- **设备改名**：双击设备卡片可自定义名称，按型号绑定，换网络不丢名。
- **运行日志**：实时显示 scrcpy 输出，ERROR 行标红。
- **使用教程**：首次启动自动引导，右上角 `❓` 随时重看。

## 快速开始

### 直接运行（开发）

仓库已包含 scrcpy 4.0 的完整二进制，只需装一次依赖：

```
npm install --registry=https://registry.npmmirror.com
npm start
```

> **为什么必须用镜像源**：官方 npm 源的证书已过期，会报 `CERT_HAS_EXPIRED`。
> 装完之后也可以直接双击 `启动 scrcpy GUI.bat` 启动。

开发调试模式（自动打开 DevTools）：

```
npm run dev
```

### 下载打包好的版本

Releases 页面提供开箱即用的安装包和绿色版 exe，**不需要装 Node、不需要单独装
scrcpy**，双击即用。

## 界面说明

- **左栏 · 设备**：设备卡片式列表，带彩色连接方式标签（【蓝】有线　【绿】无线）。
  顶部是网络调试区：IP 自动获取 + 端口 + 连接按钮。
- **右栏 · 参数**：分「画质 / 窗口 / 音视频 / 电源与连接 / 录制」五组，可折叠。
- **底部 · 快捷操作**：8 个图标按钮，hover 显示对应的 keyevent 说明。
- **底部 · 运行日志**：可展开抽屉，实时滚动 scrcpy stderr。

## 无线调试

1. 手机和电脑连同一个 Wi-Fi，用 USB 连着手机。
2. GUI 会自动读取手机的 wlan0 IP 并填入侧栏（点 `↻` 可强制重取）。
3. 点「开启网络调试」——手机会弹「允许 USB 调试」，确认一下。
4. 拔掉 USB 线，设备仍在线并可正常启动镜像。

端口默认 5555，可在端口框修改。

## 设备改名

双击设备卡片 → 输入名字 → 回车。名字**按手机型号绑定**，所以：

- 手机换 Wi-Fi、IP 从 `.37` 变成 `.38`，名字不会丢。
- USB 和无线切换，名字也不丢。
- 启动镜像时原生窗口标题会自动用这个名字（除非你手动填了窗口标题）。

清空输入框保存即可恢复显示型号。

## 快捷操作

### 即时生效（点一下手机就有反应）

| 按钮 | 实际动作 |
|------|---------|
| 返回 | `KEYCODE_BACK` (4) |
| 主页 | `KEYCODE_HOME` (3) |
| 应用 | `KEYCODE_APP_SWITCH` (187) |
| 音量+ / 音量− | `KEYCODE_VOLUME_UP` (24) / `VOLUME_DOWN` (25) |
| 电源 | `KEYCODE_POWER` (26) |
| 截图 | `adb exec-out screencap -p`，保存到 `图片\scrcpy-gui` |
| 沉浸 | 切换 `policy_control immersive.full` |

> scrcpy 4.0 没有控制 socket，所以这些按钮走 adb 直发 keyevent，而不是 scrcpy 的
> 控制通道。这是唯一的「点了立刻有反应」的实现方式。

### 需要重启（改动参数后点「重启镜像」）

分辨率、码率、帧率、编码、置顶、全屏、录制、输入模式等——scrcpy 4.0 只能在启动时
决定这些，所以改完会在参数区顶部提示「参数已修改，重启镜像后生效」，**不会自动重启**
（避免打断正在进行的操作）。

### GUI 键盘快捷键

| 键 | 动作 |
|----|------|
| `Ctrl+R` | 重启镜像 |
| `Delete` | 停止镜像 |
| `Ctrl+,` | 打开设置 |
| `F5` | 刷新设备列表 |

## 常见问题

**设备列表显示「未授权」**
在手机上确认「允许 USB 调试」弹窗，并勾选「一直允许」。

**顶部红色错误条提示 ADB 权限问题**
检查 `%USERPROFILE%\.android` 目录是否可写。ADB 需要在这里存放密钥。

**获取不到 Wi-Fi IP**
确认手机已连 Wi-Fi。GUI 只读 wlan0，不处理热点或 USB 网络共享。

**无线连接失败**
- 手机与电脑必须在同一 Wi-Fi 局域网（企业 Wi-Fi 的 AP 隔离会导致失败）。
- 点 `↻` 重新获取 IP——手机换网络后旧 IP 会失效。
- 端口被占用时改用其他端口。

**换手机后配置丢失**
勾选「同时保存为新设备默认」即可；否则新序列号会回退到默认值。

## 打包成 exe

```
npm run dist
```

一次打包同时产出两种形式，都在 `dist/`：

| 产物 | 说明 |
|------|------|
| `scrcpy-GUI-Setup-<版本>.exe` | 安装包。双击安装，可选安装目录，安装完有桌面和开始菜单快捷方式 |
| `scrcpy-GUI.exe` | 绿色版。单个文件，放哪都能双击跑，不安装 |

两种都是**免安装依赖**的完整包：Electron 运行时、scrcpy 的 exe / dll / server 都随包
分发，接收方**不需要装 Node、不需要单独装 scrcpy**，双击即用。单个产物约 87 MB。

只想单独打包一种：

```
npm run dist:installer    # 只出安装包
npm run dist:portable    # 只出绿色版
```

> 首次打包需联网：electron-builder 要下载 NSIS / winCodeSign 工具链（约 100 MB），
> 缓存在 `%LOCALAPPDATA%\electron-builder\Cache`，之后就可以离线重复打包。
>
> 打包需要 `build/icon.ico`（已提交）。NSIS 不接受 PNG 图标，如果你在 Linux/macOS
> 上重新生成，注意输出 `.ico` 而不是 `.png`。

## 分享给别人的注意事项

**操作系统会弹「已保护你的电脑」**
因为没有代码签名，Windows 会弹出蓝色提示。解决方式：点「更多信息」→「仍要运行」。

**只支持 Windows 10 / 11 x64**
Electron 32 已不再支持 Windows 7 / 8，老系统上无法运行。

**绿色版的代价**
- 每次启动都要把约 87 MB 解压到临时目录，所以**首次启动明显较慢**（几秒到十几秒）。
- scrcpy / adb 是从临时目录运行的。
- 如果直接强杀进程退出，临时目录可能残留到系统自动清理。

在意残留或在意启动速度的用户请用安装版。

**用户配置保存在系统目录**
`%APPDATA%\scrcpy GUI\` 下的 `profiles.json`（参数）、`names.json`（设备名称）、
`prefs.json`（教程提示偏好）。卸载安装版不会删除这些文件，重装后仍然保留。

## 配置存储位置

所有用户数据都在 `%APPDATA%\scrcpy GUI\`：

| 文件 | 内容 |
|------|------|
| `profiles.json` | 每台设备的 scrcpy 参数 + 全局默认 |
| `names.json` | 设备自定义名称（按型号绑定） |
| `prefs.json` | 教程提示等偏好开关 |

写入采用「防抖 + 临时文件 rename」原子写，不会写坏文件。

## 目录结构

```
electron/
  main.js       应用入口、窗口、IPC、设备轮询
  preload.js    contextBridge 白名单 API
  adb.js        adb 调用封装（含错误信息中文化、wlan0 IP 探测）
  scrcpy.js     每设备一个 Session，进程生命周期与日志解析
  profile.js    参数默认值、buildArgs、原子持久化
renderer/
  index.html    界面结构
  style.css     深色主题
  app.js        界面逻辑与参数面板定义
build/
  icon.ico      应用图标（NSIS 需要 .ico，PNG 不行）
```

scrcpy 的原始二进制文件（`scrcpy.exe` / `adb.exe` / `*.dll` / `scrcpy-server`）
保留在项目根目录，未做任何改动。它们来自 [scrcpy 官方发布](https://github.com/Genymobile/scrcpy/releases)，
遵循 Apache-2.0 协议。

## 技术栈

- **Electron 32** — 主进程管理 adb/scrcpy 子进程，渲染进程不碰 Node
- **无前端框架** — 原生 HTML / CSS / JS，IPC 走 `contextBridge` 白名单
- **scrcpy 4.0** — 镜像画面由原生窗口渲染，GUI 不做画面内嵌

## 许可

GUI 代码采用 Apache-2.0，与 scrcpy 保持一致。
