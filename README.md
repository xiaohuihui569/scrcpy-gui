# scrcpy GUI

一个深色主题的 scrcpy 图形启动器。GUI 只负责管理参数、管理进程、发送即时按键；
镜像画面仍然由原生 scrcpy 窗口显示，因此延迟和画质与 scrcpy 完全一致。

## 启动方式

**双击 `启动 scrcpy GUI.bat`** —— 日常使用就这一步，不用命令行。

依赖已经装好，直接双击即可。

如果日后需要重装依赖，在本文件夹打开命令行执行一次：

```
npm install --registry=https://registry.npmmirror.com
```

> 必须用镜像源：官方 npm 源的证书已过期，会报 `CERT_HAS_EXPIRED`。

开发调试模式（自动打开 DevTools）：

```
npm run dev
```

## 界面说明

- **左栏 · 设备**：每 3 秒自动刷新。显示型号、Android 版本、电量、连接状态。
  顶部输入框可连接 TCP/IP 网络设备。
- **右栏 · 参数**：分「画质 / 窗口 / 音视频 / 电源与连接 / 录制」五组，可折叠。
  勾选「同时保存为新设备默认」可让后续新设备继承这套参数。
- **底部 · 快捷操作**：全部即时生效（通过 ADB 直接发送）。
- **底部 · 运行日志**：实时显示 scrcpy 输出，ERROR 行标红。

## 快捷键

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

### 需要重启（改动参数后点「重启镜像」）

分辨率、码率、帧率、编码、置顶、全屏、录制、输入模式等——scrcpy 4.0 只能在启动时
决定这些，所以改完会在参数区顶部提示「参数已修改，重启镜像后生效」。

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

**多设备**
每台设备的参数独立保存（按序列号）。两台同时插上时可以并行开多个镜像窗口。

**换手机后配置丢失**
勾选「同时保存为新设备默认」即可；否则新序列号会回退到默认值。

## 打包成 exe

```
npm run dist
```

一次打包同时产出两种形式，都在 `dist/`：

| 产物 | 说明 |
|------|------|
| `scrcpy-GUI-Setup-<版本>.exe` | 安装包。双击安装，可选安装目录，安装完有桌面和开始菜单快捷方式，可从“设置 → 应用”卸载 |
| `scrcpy-GUI.exe` | 绿色版。单个文件，放哪都能双击跑，不安装 |

两种都是**免安装依赖**的完整包：Electron 运行时、scrcpy 的 exe / dll / server 都随包分发，
接收方**不需要装 Node、不需要单独装 scrcpy**，双击即用。单个产物约 87 MB。

只想单独打包一种：

```
npm run dist:installer    # 只出安装包
npm run dist:portable    # 只出绿色版
```

> 首次打包需联网：electron-builder 要下载 NSIS / winCodeSign 工具链（约 100 MB），
> 缓存在 `%LOCALAPPDATA%\electron-builder\Cache`，之后就可以离线重复打包。

## 分享给别人的注意事项

**操作系统会弹“已保护你的电脑”**
因为没有代码签名（没有代码签名证书就无法绕过），Windows 会弹出蓝屏提示。解决方式：
点“更多信息” → “仍要运行”，然后打开即可。

**只支持 Windows 10 / 11 x64**
Electron 32 已不再支持 Windows 7 / 8，老系统上无法运行。

**绿色版的代价**
- 每次启动都要把约 87 MB 解压到临时目录，所以**首次启动明显较慢**（几秒到十几秒）；安装版没有这个问题。
- scrcpy / adb 是从临时目录运行的。
- 如果直接强杀进程退出（不点退出菜单退出），临时目录可能残留到系统自动清理。
在意残留的用户请用安装版。

**用户配置保存在系统目录**
`%APPDATA%\scrcpy GUI\` 下的 `profiles.json`（参数）、`names.json`（设备名称）、
`prefs.json`（教程提示偏好）。卸载安装版不会删除这些文件，重装后仍然保留。

## 目录结构

```
electron/
  main.js       应用入口、窗口、IPC、设备轮询
  preload.js    contextBridge 白名单 API
  adb.js        adb 调用封装（含错误信息中文化）
  scrcpy.js     每设备一个 Session，进程生命周期与日志解析
  profile.js    参数默认值、buildArgs、原子持久化
renderer/
  index.html    界面结构
  style.css     深色主题
  app.js        界面逻辑与参数面板定义
```

scrcpy 的原始二进制文件全部保留在项目根目录，未做任何改动。

