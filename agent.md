# GTodo 开发指南

本文件供参与本仓库开发的 agent 和维护者使用。以当前用户要求和实际代码为准；功能、存储或发布方式变化时同步更新本文、`README.md` 与 `help.md`。`README.md` 用于项目介绍和功能展示，详细操作与实现说明放在 `help.md`。

## 项目概况

- GTodo 是参考 Microsoft To Do 操作方式的 Windows 桌面待办应用，包含任务、桌面便签、Markdown 备注、番茄钟和 Outlook 日历同步。
- 技术栈：Electron、React、TypeScript、Vite、esbuild、Zod；具体依赖版本以 `package.json` 和 `package-lock.json` 为准。
- 当前应用版本为 `0.1.1`。运行时通过 `app.getVersion()` 获取版本，不另设界面版本来源。
- 开发环境：Windows x64，Node.js 22.12+ 或 24 LTS，PowerShell。使用 `npm.cmd` / `npx.cmd`，无需修改系统执行策略。
- 默认用中文交流，界面文案保持简短。先检查工作区状态，保留已有修改，避免顺手重构无关功能。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/main.tsx`、`src/App.tsx` | 窗口入口、主界面、清单与任务交互 |
| `src/components/` | 任务详情、右键菜单、设置、分隔条、文档编辑器 |
| `src/notes/` | 便签窗口、便签管理、编辑草稿与自动保存 |
| `src/pomodoro/` | 番茄钟界面和状态订阅 |
| `src/shared/model.ts` | Zod 数据模型、命令及主进程与渲染进程接口 |
| `src/shared/engine.ts` | 任务命令、字段修改时钟、合并、删除与重复任务 |
| `src/shared/note-links.ts` | 任务备注与便签关联、解除关联和同步规则 |
| `src/shared/documents.ts`、`layout.ts` | 文档与图片约定、分栏尺寸规则 |
| `electron/main.ts`、`preload.ts` | 生命周期、IPC、应用协议、托盘、提醒与退出保存 |
| `electron/storage.ts`、`folder-storage.ts` | 本机缓存、原子写入、数据文件夹切换与合并 |
| `electron/document-files.ts` | 正文文件、图片、外部编辑回读与冲突保留 |
| `electron/linked-note-commands.ts` | 关联记录删除前的跨窗口保存协调 |
| `electron/note-windows.ts`、`pomodoro-window.ts` | 独立窗口、恢复、置顶、收起与加载重试 |
| `electron/preferences.ts`、`pomodoro.ts` | 本机设置与番茄钟状态 |
| `electron/outlook-*.ts`、`outlook-bridge.ps1` | 经典 Outlook 本地接口与单向同步 |
| `src/styles.css`、`responsive.css`、`theme.css` | 扁平样式、响应式布局与主题 |
| `scripts/`、`tests/` | 开发构建脚本、自动化与原生集成测试 |
| `README.md`、`help.md`、`docs/images/` | 项目首页、完整使用帮助与真实功能截图；截图使用独立演示数据 |

表中省略目录前缀的文件与同一单元格的首个文件位于同一目录。

## 必须保持的产品约定

### 界面与窗口

- 使用简洁、扁平的白色、浅灰与蓝色强调样式，避免装饰性渐变、阴影和多余说明。
- 设置入口只放主窗口顶部标题栏；番茄钟常驻入口只放左侧清单栏。任务详情仍可通过“专注此任务”打开番茄钟。
- 主界面的两条纵向分隔线可拖动，宽度在本机保存；保留双击重置和键盘调整。
- 支持 60%～200% 缩放，根据缩放后的可用宽高切换分栏、抽屉和窄屏布局。调整尺寸、缩放和切换布局不能丢失草稿。
- 任务行右键菜单支持完成 / 取消完成、加入 / 移出我的一天、重要星标、打开详情、专注和删除；根据任务状态切换文案，已完成任务隐藏专注。各清单与搜索结果均适用；移出我的一天不能删除任务。保留删除撤销、上下键 / Home / End / Esc 导航、焦点恢复，以及缩放和小窗口下的可达性。
- 便签名称在标题栏下方、正文上方编辑，不放回原生拖动区域。颜色、格式、预览、图片和代码等选项折叠到标题栏“…”菜单。
- 便签支持 12 种浅色配色，色板分两行显示。新增颜色时同步更新 `noteColors`、中文名称和便签样式，保留旧颜色 ID，并检查最小窗口下的显示和保存。
- 便签和番茄钟是独立可移动、缩放、置顶的窗口；便签的 × 表示收起，不是删除。
- 番茄钟由主进程计时，收起窗口后继续，退出应用或休眠时暂停；专注结束不自动完成任务。
- 设置页保留作者邮箱：`xlnum73@outlook.com`。

### 任务备注与关联便签

- 新建任务和重复任务生成的下一次任务默认 `noteLink: null`；旧便签不自动关联。
- 只有用户点击“创建关联便签”并“确认创建”后才能建立关联。已有关系只打开原便签，重复调用不能生成多张。
- 关联双方共享正文、纯文本/Markdown 格式和图片映射；任务标题、日期、步骤与便签名称、颜色各自独立。
- 关联双方使用任务目录中的同一个正文文件和 `assets`，不能退回到复制正文或维护两份独立文件。
- 删除任一方前先保存两边草稿；保存失败则取消删除，保留编辑内容。
- 删除便签：解除关联，保留任务备注。删除任务：解除关联，为保留的便签生成独立正文文件和图片。
- 撤销删除后双方保持独立，不自动恢复关联；重新关联必须显式创建。保留生命周期时钟，防止旧同步数据或再次删除误恢复关系。
- 双方都删除后从当前列表移除；仍沿用删除标记、撤销和备份机制，不将删除描述为安全擦除。

### 本地文件与外部服务

- 网盘同步由用户安装的网盘客户端处理。GTodo 只选择、读写本地数据文件夹，不恢复 OneDrive/WebDAV 登录、OAuth 或密码管理。
- 正文默认纯文本 `.txt`，显式启用 Markdown 后使用 `.md`；图片使用文档旁的 `assets` 和相对路径。
- 支持 UTF-8 外部编辑后自动回读，先确认文件稳定，保留同时修改产生的冲突副本；后台刷新不能覆盖未保存的输入。
- Markdown 预览不执行原始 HTML 或脚本；保留本地路径、图片类型与大小校验。
- 日历是 GTodo 到经典 Outlook 的单向同步，默认关闭。当前接口不能直接接入 Windows 任务栏日期弹窗或仅安装的新版 Outlook。
- 只更新有 GTodo 归属标记且任务 ID 已知的日程；保留其他日历、普通日程和未知任务日程。停止同步或更换目标时不清理旧日历。

## 数据与兼容性

- 本机用户数据目录通常为 `%APPDATA%\GTodo`：`workspace.json` 及备份保存缓存和设备身份，`preferences.json` 保存本机设置，`pomodoro.json` 保存计时与统计，`document-state.json` 保存外部编辑基线，`media` 缓存图片。
- 所选共享目录使用 `device-<设备 ID>.json` 保存各设备快照；不能改为所有设备覆盖同一个 JSON。窗口位置、缩放、番茄钟状态和日历目标不随此目录共享。
- 正文路径为 `documents/tasks/task-<ID>/note.txt|md` 或 `documents/notes/note-<ID>/note.txt|md`。关联便签复用任务路径；标题变化不改变路径。
- JSON 同时保存属性、正文缓存、图片映射和修改时钟，用于恢复与合并。不要把正文文件当作唯一数据源，也不要把外部删除文件当作删除任务。
- 当前 `schemaVersion` 为 `1`。增加字段时提供旧数据默认值和必要的时钟默认值；格式变化必须兼容已有数据与备份，不能靠清空数据完成迁移。
- 保持字段级修改时钟和确定性合并。删除标记用于阻止离线旧副本复活记录，不随意清理。
- 文件写入保持串行、原子替换和备份。共享目录不可用时仍保存本机修改；损坏或未下载完整的文件不能覆盖有效缓存。
- 保存期间的新输入应继续留在草稿中；收起、退出和关联删除前等待保存。保存失败时保持内容可编辑、可重试。
- 切换数据目录时合并并保留原目录文件。不要复制整个用户数据目录到另一台电脑，以免复制设备身份。
- 保留路径穿越及符号链接/目录联接检查、IPC 来源与便签所属窗口校验、`contextIsolation` 和现有沙箱限制。

## 常用命令

在仓库根目录运行：

| 命令 | 用途 |
| --- | --- |
| `npm.cmd ci` | 按锁文件安装依赖 |
| `npm.cmd run dev` | 启动 Vite 和 Electron 开发环境 |
| `npx.cmd tsc --noEmit` | 类型检查 |
| `npm.cmd run build` | 类型检查、前端构建、主进程与 preload 构建 |
| `npm.cmd start` | 启动已构建的应用；先执行 build |
| `npm.cmd test` | 执行 `tests/*.test.ts` |
| `npm.cmd run test:notes` | 独立 Electron 窗口测试；先构建 |
| `npm.cmd run test:outlook` | 经典 Outlook 本地 PST 集成测试；先构建 |
| `npm.cmd run bench:startup -- . 500 3` | 独立合成数据启动基准；500 张便签、3 次运行；先构建 |
| `npm.cmd run pack` | 构建 Windows 未封装目录 |
| `npm.cmd run dist` | 构建 Windows x64 ZIP 和单文件便携 EXE |

如果安装时未执行 Electron 下载脚本，运行 `node node_modules/electron/install.js`。修改依赖时同步锁文件，不手工修改生成的 bundle。

## 验证方式

- 按改动选择检查。纯文档修改检查内容、路径和差异即可；版本修改检查版本一致性与发布产物，不新增仅复述实现的测试。
- 修改共享模型、合并、存储或关联规则时，运行相关测试与构建；跨模块行为变化再运行完整 `npm.cmd test`。
- 关联功能重点检查 `tests/note-links.test.ts`、`tests/linked-note-commands.test.ts`、`tests/documents.test.ts` 和 `tests/ui.test.ts`：双方编辑、外部回读、删除任一方、保存失败、撤销和离线合并。
- 改动窗口生命周期、置顶或加载协议时，构建后运行 `npm.cmd run test:notes`；它在 `.qa` 独立目录测试真实窗口和加载失败恢复。
- 手动验证使用未打包 Electron：将当前进程的 `GTODO_DATA_DIR` 设为 `.qa` 下的唯一绝对路径，`GTODO_QA=1`，清除该进程的 `ELECTRON_RUN_AS_NODE`，再运行 `npm.cmd start`。测试后恢复原环境变量。
- `GTODO_DATA_DIR` 仅在未打包模式生效；不能靠它隔离便携 EXE。不要使用个人任务目录执行删除或故障注入测试。
- `test:outlook` 需要已配置的经典 Outlook，会临时挂载 `.qa` 下的独立 PST 并在结束时解除挂载。不要改成使用个人日历做增删测试。
- UI 修改检查主窗口宽窄布局、缩放、便签小窗口和编辑保存。只关闭本次测试启动的进程；优先正常退出并等待保存。
- `.qa`、`dist`、`dist-electron`、`release`、`node_modules` 和日志是本地产物，不加入源代码提交。

## 已知实现注意点

- 各窗口使用 `webContents.setZoomMode('isolated')`。更换缩放实现后须验证实际布局尺寸，不能只检查显示的百分比。
- 无边框标题栏的按钮和编辑区保持 `-webkit-app-region: no-drag`，空白拖动区使用 `drag`。
- 当前便签和番茄钟置顶使用 `setAlwaysOnTop(true, 'pop-up-menu')`，取消使用 `normal`；改动时验证窗口仍可见、可收起和再次打开。
- 保留便签加载的有界重试和失败窗口清理。`gtodo://app/index.html?note=...` 加载失败不能删除已保存的便签或阻止整个应用启动。
- 当前 electron-builder 配置 `portable.unpackDirName: true` 用于独立临时解压目录，防止重复启动清理另一实例资源。升级依赖时核对实际行为。
- 单文件便携 EXE 每次都会解压运行环境；优先提供完整解压一次的 ZIP 版，不以固定共享临时目录换取速度。
- 主窗口先读本机缓存，文件夹首次合并在窗口创建后运行；编辑仍进入 FolderStorage 串行队列。日历启用、手动同步及后台同步要等待首次读取；退出等待启动窗口恢复完成后再统一保存草稿。
- Markdown 预览与代码高亮按需导入。发布包排除 `node_modules` 和主进程 source map：依赖已由 Vite/esbuild 打包；以后新增外部运行时依赖时须同步调整打包规则并验证 ASAR，不能盲目排除。
- `bench:startup` 可接收构建目录或 ASAR 路径、便签数量、运行次数，使用隔离的 `.qa` 数据；首次状态返回不是完整冷启动，便携解压需单独测量。诊断日志记录 `startup-local-ready` / `startup-folder-ready`，不记录正文。
- Outlook PowerShell 桥接构建输出保留 UTF-8 BOM，兼容 Windows PowerShell 5.1 的中文处理。新日历使用标准描述字段标记归属，同时兼容旧标记。

## 版本与交付

1. 更新 `package.json` 的 `version`、`package-lock.json` 根版本及 `packages[""].version`；同步 README 与 help 的版本和下载路径，以及使用当前版本的测试夹具。
2. 按改动完成检查；需要交付 EXE 时执行 `npm.cmd run dist`，不能只给旧安装包改名。
3. 发布路径为 `release/GTodo-v<版本>-Windows-x64.zip` 与 `.exe`，未封装入口为 `release/win-unpacked/GTodo.exe`。ZIP 必须完整解压后运行，不能单独移动其中的 EXE。
4. 核对打包后 `app.asar` 内的版本及构建文件，并检查 Windows `FileVersion` / `ProductVersion`；Outlook 桥接同时存在于 ASAR 和外部 resources 中，两处均需保持一致。
5. 应用使用单实例锁。旧进程仍运行时打开新 EXE，可能只是激活旧进程；先正常退出旧版，再核对实际进程路径与运行版本。
6. 若用户看到的行为与当前源码不符，先核对启动路径及包内容，避免修改其他目录里的旧副本。交付时链接本次实际构建的文件，说明验证结果和仍存在的限制。
