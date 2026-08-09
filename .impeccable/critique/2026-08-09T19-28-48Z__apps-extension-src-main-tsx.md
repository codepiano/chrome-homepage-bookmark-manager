---
target: 所有交互页面（主页、标签、卡片、对话框、设置与离线状态）
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-08-09T19-28-48Z
slug: apps-extension-src-main-tsx
---
Method: dual-agent (A: /root/design_assessment · B: /root/evidence_assessment)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | 保存、点击记录与排序成功均无明确确认。 |
| 2 | Match System / Real World | 3 | “快速访问 / 本机书签库 / Local Speed Dial”命名并置。 |
| 3 | User Control and Freedom | 3 | 无撤销；整卡点击会立刻离开当前新标签页。 |
| 4 | Consistency and Standards | 2 | 链接删除用原生 confirm，标签删除用定制确认。 |
| 5 | Error Prevention | 2 | 整卡打开与编辑/拖拽控件并置，容易误触。 |
| 6 | Recognition Rather Than Recall | 3 | 标签双击编辑不易发现；“显示新增按钮”不生效。 |
| 7 | Flexibility and Efficiency | 3 | 有排序和键盘拖拽；无搜索、快捷键与批量整理。 |
| 8 | Aesthetic and Minimalist Design | 2 | 卡片长期暴露编辑、拖拽、指标和元数据，噪声压过链接。 |
| 9 | Error Recovery | 3 | 离线快照、重试和检查连接明确；字段级恢复指导不足。 |
| 10 | Help and Documentation | 2 | 无首次引导；连接/令牌与标签编辑缺少可发现的任务帮助。 |
| **Total** | | **26/40** | **Acceptable — significant improvements needed** |

## Design Specificity Verdict

这是一个具备“本机工具 / Speed Dial”基调的界面：蓝灰背景、文字优先卡片、离线快照和抓取状态都和产品约束一致。但主页没有充分服从“打开新标签页即可快速访问”的首要任务；它把长期管理能力持续铺在每一张卡片上，因此仍带有通用管理后台的密度，而不是为快速访问量身定制的节奏。

确定性扫描对 `apps/extension/src/main.tsx` 返回 `[]`（0 条），没有规则命中或误报。它没有发现反模式，但也没有涵盖任务流的层级、可发现性和状态一致性问题。

浏览器中临时启动 Vite 后，CDP 可变注入预检和 detector overlay 脚本均成功；控制台报告 “No anti-patterns found”。但普通 localhost 没有 `chrome.storage.local`，App 在 `api.ts` 初始化时崩溃，`#root` 与正文均为空，不能作为任何真实页面、对话框或离线状态的视觉通过证据。临时 Vite、detector live server 和审计标签已清理；子代理线程不支持 [Human] 可见化，故没有可靠的用户可见 overlay。

## Overall Impression

基础可信、状态诚实，也已具备实际管理能力。最大的机会不是继续加控件，而是让默认页恢复为“安静地打开”，把整理能力放进有意图才出现的层级。

## What's Working

1. 离线时明确展示最近成功同步的只读快照，而非假装为空库；这让本机优先承诺可信。
2. 删除标签会说明连带删除的链接数量，危险后果在确认前可见。
3. 卡片可通过描述、访问次数、最近访问、列表/网格与紧凑模式适配不同习惯，信息基础完整。

## Priority Issues

### [P0] 卡片把打开与管理放在同一视觉层

**Why it matters：** `SortableCard` 的整卡打开、右上“编辑”、右下“↕ 拖动”、指标与抓取徽标同时恒显。最高频的扫读和打开被低频管理控件稀释，还会增加误开或误拖风险。

**Fix：** 默认态只保留 favicon、名称及用户选择的少量辅助信息；编辑/拖动放在 hover、键盘 focus 或显式“整理”模式中。将打开明确为一个主链接语义，管理操作应先进入整理语境。

**Suggested command：** `$impeccable shape`

### [P1] 设置混合日常偏好和连接维护，且有失效选项

**Why it matters：** 布局、颜色、数值、字段、服务地址和令牌都在一个长对话框。`showAddButton` 目前不控制顶部“＋ 添加”或卡片添加入口，直接破坏信任。

**Fix：** 移除该选项或使它真实生效；将“外观与显示”与“本机服务连接”分成独立分区或二级面板，连接区增加验证/成功状态，数值选项给出默认恢复路径。

**Suggested command：** `$impeccable distill`

### [P1] 删除体验不一致，也没有恢复路径

**Why it matters：** 链接删除使用浏览器原生 `confirm`，标签删除使用自定义二次确认。前者不能呈现网址、所属标签或统一的错误状态，也无法撤销。

**Fix：** 统一为同一套页内危险确认；链接删除明确显示对象，操作完成后提供短暂撤销，至少提供一致的完成/失败反馈。

**Suggested command：** `$impeccable harden`

### [P2] 首次使用与标签管理入口不可发现

**Why it matters：** 空状态没有形成“创建标签 → 添加网址 → 直接打开”的行动链；标签编辑主要依赖双击。首次用户需要猜测能力位置。

**Fix：** 将空状态变成轻量三步激活；给当前标签提供可见的管理入口，双击仅作为加速方式；首次连接成功后给出最短使用提示。

**Suggested command：** `$impeccable onboard`

### [P2] 链接字段和自动抓取的来源关系不清楚

**Why it matters：** 新增与编辑页字段不同；“显示名、标题、简介、图标、自动抓取”需要用户自己理解优先关系。抓取失败也没有强调链接仍可正常使用。

**Fix：** 按“我的自定义”与“自动信息”分组；新增即显示抓取预期，失败时明确“仅自动信息缺失，不影响打开”。

**Suggested command：** `$impeccable clarify`

## Persona Red Flags

**Alex（高频用户）：** 卡片常驻编辑与拖拽降低扫读速度；缺少搜索、键盘直达、批量移动和稳定的整理模式。书签增长后，这会显著拖慢定位与整理。

**Jordan（首次用户）：** 不会自然发现标签双击编辑，也未得到“本机服务 / 地址 / 配对令牌”如何完成首次连接的任务路径。空状态只解释边界，没有引导成功。

**单一本机用户：** 服务故障是唯一关键失败点。“检查连接”只打开技术设置，尚不足以帮助用户验证、定位和恢复连接。

## Minor Observations

- `DialogFrame` 没有焦点陷阱、Esc 关闭或把焦点归还给触发者。
- 卡片是带键盘事件的 `article`，内部又嵌套两个按钮；对于键盘与辅助技术，不如明确的链接 + 操作菜单自然。
- 深色主题下连接错误仍使用浅红底，长错误文本突兀。
- 顶部“＋ 添加”和尾部“添加链接”重复，且前者在无标签时改为添加标签，语义会随状态变化。

## Questions to Consider

1. 若唯一衡量标准是“1 秒内打开想去的网站”，每张卡上哪些管理控件真的应默认可见？
2. 是否将“整理”设计为一个短暂、明确的模式，让浏览和管理各自更干净？
3. 服务地址和令牌更像一次性连接修复流程，而非常规外观设置；是否应该从设置主层拿出去？
