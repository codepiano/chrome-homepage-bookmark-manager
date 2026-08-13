# Local Speed Dial

一个本地优先的 Chrome 新标签页与书签工作台。

Local Speed Dial 用卡片组织常用网站，同时把浏览历史、自动归集、网页信息补全和批量写入 API 放进同一个本机知识库。数据保存在你自己的电脑上，不需要账号，也不依赖云端同步。

> 当前发布形态是“本机服务 + Chrome 解压扩展”。它不是单独安装扩展就能运行的纯前端插件。

## 适合谁

- 希望打开新标签页就能直接访问常用网站的人；
- 想按自己的分类和视觉习惯整理链接，又不想把数据交给第三方服务的人；
- 希望把 Chrome 历史记录沉淀到本机数据库，继续搜索和归档的人；
- 想通过脚本、AI Agent 或其他本地工具批量写入书签的人。

## 主要能力

- **新标签页主页**：用文件夹和卡片展示常用链接，点击卡片即可打开；
- **打开优先，整理按需**：日常浏览保持简洁，编辑、拖动排序和文件夹管理集中在“整理书签”模式；
- **快速搜索**：按 `⌘ K`（Windows/Linux 为 `Ctrl K`）搜索全部书签，支持键盘选择与打开；
- **自动归集**：给文件夹设置 `github.com`、`*.github.com` 一类域名规则，已有和新建链接都会自动归类；
- **浏览历史库**：把 Chrome 历史同步到本机 SQLite，支持搜索、日期分组、域名分组和无限加载；
- **网页信息补全**：自动获取标题、描述和站点图标；失败时仍可正常保存、打开和手动重试；
- **个性化外观**：支持浅色、深色和跟随系统，以及列数、卡片宽度、间距、字体、强调色等设置；
- **离线只读快照**：本机服务暂时不可用时，仍可查看最近一次成功同步的内容；
- **本机 API**：支持批量新增或更新链接，以及全库/单文件夹 JSON 导入导出。

## 工作方式

```text
Chrome 新标签页扩展
        │  Bearer Token，仅通过本机回环地址连接
        ▼
Fastify 本机服务 · 127.0.0.1:3721
        │
        ▼
SQLite · data/speed-dial.sqlite
```

扩展负责新标签页界面和 Chrome 历史事件，本机服务负责数据、搜索、规则、导入导出和网页信息抓取。SQLite 是数据源，扩展中的缓存只用于离线查看和失败重试。

## 安装

### 环境要求

- Chrome 或其他支持 Manifest V3 解压扩展的 Chromium 浏览器；
- Node.js 22 或更高版本；
- Corepack / pnpm；
- 使用仓库生命周期脚本时，需要 macOS、`tmux` 和 `lsof`。

### 1. 安装依赖并构建

```bash
git clone https://github.com/codepiano/chrome-homepage-bookmark-manager.git
cd chrome-homepage-bookmark-manager
corepack enable
./scripts/init.sh
pnpm build
```

### 2. 启动本机服务

```bash
./scripts/start.sh
./scripts/status.sh
```

首次启动会创建：

- 数据库：`data/speed-dial.sqlite`
- 配对令牌：`data/api-token`
- 服务日志：`.control-panel/api.log`

### 3. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`；
2. 开启右上角的“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择仓库中的 `apps/extension/dist`；
5. 打开一个新标签页。

### 4. 完成配对

在新标签页的连接设置中填写：

- API 地址：`http://127.0.0.1:3721`
- Token：复制 `data/api-token` 文件中的内容

保存并通过连接检查后，即可创建第一个文件夹和链接。

完整操作说明见 [使用手册](docs/USER_GUIDE.md)。

## 常用命令

```bash
./scripts/start.sh       # 启动服务
./scripts/status.sh      # 检查服务和健康状态
./scripts/restart.sh     # 重启服务
./scripts/stop.sh        # 停止服务
pnpm build               # 构建服务与扩展
pnpm test                # 运行测试
pnpm typecheck           # 类型检查
```

更新代码后，重新执行 `pnpm install && pnpm build`，重启服务，并在 `chrome://extensions/` 中点击扩展的“重新加载”。

## 批量写入示例

本机 API 可以让脚本或 AI 工具一次写入多条链接：

```bash
TOKEN="$(tr -d '\r\n' < data/api-token)"

curl -X POST http://127.0.0.1:3721/api/ai/links \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "onDuplicate": "skip",
    "links": [
      { "url": "https://github.com", "folderName": "开发工具" },
      { "url": "example.com", "title": "示例网站", "folderName": "稍后阅读" }
    ]
  }'
```

接口会明确返回 `created`、`updated`、`skipped` 和 `foldersCreated`。更多请求、导入导出格式及安全边界见 [API 使用说明](docs/API.md)。

## 数据与隐私

- 数据默认只保存在当前电脑，不提供账号、遥测或云同步；
- 服务只监听 `127.0.0.1`，除 `/health` 外的接口都需要本机 Token；
- 浏览历史权限用于把历史记录同步到本机数据库；
- 网页信息补全会从你的电脑访问目标网站，目标网站或你配置的代理可能看到这次请求；
- JSON 导出不会包含 Token、浏览历史、点击记录、元信息缓存或本机绝对路径。

详细说明见 [隐私说明](PRIVACY.md)。建议定期备份整个 `data/` 目录，或使用 JSON 导出生成便携备份。

## 开发

```bash
pnpm dev:server
pnpm dev:extension
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

项目结构：

```text
apps/extension   Chrome MV3 新标签页扩展（React + Vite）
apps/server      本机 API 与 SQLite 数据层（Fastify）
packages/contracts  前后端共享的数据契约
scripts          启动、停止、状态检查等本机脚本
docs             使用与 API 文档
```

## 当前边界

- 不提供账号系统或跨设备同步；
- 不会自动导入 Chrome 原生书签；
- 扩展接管的是 Chrome 新标签页，不会修改浏览器启动页或主页设置；
- 当前需要从源码构建并以“解压扩展”方式安装。

如果你准备提交问题，请附上复现步骤、浏览器版本，以及 `.control-panel/api.log` 中与问题相关且已去除敏感信息的日志片段。
