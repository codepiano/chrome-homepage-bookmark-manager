# 版本化生命周期

此目录是项目自有的构建与运行适配器，不依赖全局 Skill 安装。

- `config.json` 声明本项目的构建命令、产物、正式数据路径与原有进程控制脚本。
- `scripts/release-version.sh` 只读返回代码、产物和真实运行版本；旧进程无来源记录时返回 null。
- `scripts/release-prepare.sh` 在独立目录准备固定版本，不停止服务或连接正式数据。
- `scripts/release-activate.sh` 验证指定产物后启动，必须先停止旧实例。
- 命令行更新使用 `scripts/release-restart.sh`；普通启动、停止和状态分别使用同前缀的脚本。

控制面板通过 manifest 中的新入口调用以上流程。原有 scripts/start.sh 等入口保留兼容，
直接运行旧入口的进程不会被误报成已经应用新版。父项目不联动独立子服务。

产物及进程身份记录默认存放于当前用户的 Library/Application Support/project-tooling/releases，
按项目目录隔离；PROJECT_RELEASE_STORE 可指定独立的验证存储。准备期间不连接在线数据，
切换时才链接 config.json 明确列出的原有数据/配置。原始目录和用户数据不搬迁、不覆盖。

构建失败保留旧服务；停止失败阻止切换；切换后核验实际进程身份和运行版本。
新脚本的提交、推送和在线切换是独立步骤，提交脚本不会自动重启正在运行的服务。
