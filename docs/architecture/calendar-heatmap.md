# 日历热力图抽象

> 仪表盘热力图是单一组件，具有两种模式。两种模式共享相同的日期、星期、月份与数据处理逻辑，但时间范围的计算方式不同。二者绝不可混用。

## 两种模式

| 模式 | 时间范围 | 列数 | 年份填充 | 使用场景 |
|---|---|---|---|---|
| `rolling-52-weeks` | 当前周 + 之前 51 周 | 恰好 **52** 列 | 不适用——仅当前周的未来日期 | 近期活动（默认） |
| `calendar-year` | 指定年份的 1 月 1 日至 12 月 31 日 | 动态计算（52 / 53 / 54） | 年初/年末布局占位 | 历史年度回顾 |

## 共享部分

- **`HeatmapDay`**：每个单元格的结构。每个单元格都包含 `date`（YYYY-MM-DD，即业务主键）、`value`（数字或 `null`），以及 `weekIndex`、`weekdayIndex`，还有两个标记字段 `inRange` / `isFuture`，用于区分「此处没有业务数据」与「无活动」。

- **周一为一周之首**。周一 = 0，周日 = 6，内部转换为 `(Date.getDay() + 6) % 7`，因为 `Date.prototype.getDay()` 中周日 = 0。

- **显示时区（UTC+8）**。整个模块都在显示时区中运行；混用 UTC 与本地时间的计算会导致日期、星期与月份位置出现偏差。从 UTC 毫秒转换为 YYYY-MM-DD 字符串只有一处（`src/dashboard/heatmap.ts` 中的 `isoDayUtc8`）。

- **月份标签**。每个标签都锚定在**包含该月 1 日的周列**上，而不是锚定在周一落在该月的那一列。这样，当月份从周中开始时，「9月」仍能显示在正确的列上。标签属于日期语义：渲染器**绝不会**在左右边缘丢弃标签（例如锚定在最后一个滚动列上的 9 月）——布局问题由 CSS 解决。

- **共享的周列布局**。`.months` 行与 `.heatmap` 网格使用**相同的** CSS grid 周轨道（由调用方内联设置 `--week-count` 变量；两条规则都使用 `grid-template-columns:repeat(var(--week-count, 52), 1fr)`）。轨道采用 `1fr`，使热力图铺满整个内容宽度（单元格拉伸，高度保持 10px）；因此，标签内联的 `grid-column` 会精确地落在其对应的周列之上。`display:flex` 与 `justify-content:space-between` 会悄然忽略这种锚定关系，且受契约禁止。

- **单元格携带其位置信息**。每个渲染的单元格都带有 `data-week` / `data-weekday`，并且基于 `HeatmapDay` 本身显式地设置内联的 `grid-column` / `grid-row` 位置。布局从不依赖 DOM 顺序或 `grid-auto-flow`，因此 52 / 53 / 54 列的网格都使用同一个渲染器。CSS 中区分三种视觉状态：真实的零活动日（level-0 背景）、未来日期（`data-future="1"`，留空）以及范围外的填充（`data-inrange="0"`，几乎透明）。

- **按日期而非位置查找数据**。渲染器通过单元格的 `date` 键读取 `daily` Map。绝不能用视觉位置去查找业务数据。

## 用量指标语义

热力图的数据结构刻意混合了两种指标，因为它要回答两个不同的公共问题：

```ts
Map<string, { total: number, requests: number }>
```

- `total` is physical upstream Token consumption reported by upstreams（`total` 是上游报告的物理上游 Token 消耗量）。当上游报告了用量时，重试、协议/模型回退以及 hedge 工作仍计入 Token 消耗。
- `requests` is **successfully delivered requests**（`requests` 是**成功交付的请求数**）。内部的重试/回退/hedge dispatch 本身不会增加公共的「次请求」计数。
- 模型用量细分可以在工具提示（tooltip）中单独展示物理上游调用次数。该物理 attempt 维度不得替代热力图/公共请求数。
- 缺失的上游 Token 用量会被单独记录，绝不会为了让热力图看起来完整而进行估算。

`src/observability/token-usage-store/upstream-queries.ts` 中的读取器实现了这一拆分：Token 字段来自 `upstream_total_tokens`，而活动序列的请求数来自已交付的 `requests`。

## Token 数据新鲜度契约

热力图的业务数据来源按新鲜度有意拆分：

- **今天以及之前的六个 UTC+8 自然日**，每次仪表盘读取时都会从 `token_usage_hourly` 重新构建。只要小时级数据仍被保留，它就是权威来源，因此过时的每日 cron 快照不会导致昨日的 Token 总量在午夜之后下降。
- **更早的日期**来自 `token_usage_daily`，即 52 周视图所使用的物化长期历史。
- **第七个之前的自然日不会用小时数据覆盖**。小时级数据的保留期是滚动的七天窗口，因此该日的凌晨数据可能已被清理；若使用它，可能会低估一个完整的历史日。
- 若每日表不可用或为空，读取器会回退到仍被保留的全部小时级历史。若在每日历史存在的情况下，小时级覆盖失败，仪表盘会降级为物化快照，而不会导致整个区块失败。

这一边界使近期窗口能够自我修复，同时在小时级数据保留期届满之后，仍能保持历史总量的稳定。

## 两种模式不共享的部分

| 关注点 | `rolling-52-weeks` | `calendar-year` |
|---|---|---|
| 范围起点 | `currentWeekStart - 51 weeks` | `YYYY-01-01` |
| 范围终点 | `currentWeekStart + 6 days` | `YYYY-12-31` |
| 年份填充单元格 | 不适用 | 有（上一年的 12 月 / 下一年的 1 月） |
| 未来日期单元格 | 有（当前周剩余部分） | 有（当前年剩余部分） |
| `inRange` 语义 | `iso >= rangeStartIso` | `iso >= rangeStart && iso <= rangeEnd` |
| `isFuture` 语义 | `iso > today` | `iso > today`（仅在 inRange 时有意义） |
| 列数 | 恰好 52 | 推导得出（取决于年份布局） |
| 月份标签 | 窗口内的每个月初 | 恰好 12 个（1..12） |

## 三种单元格状态——绝不可合并

两个布尔值相互独立：

| `inRange` | `isFuture` | 含义 | `value` |
|---|---|---|---|
| `true` | `false` | 活跃日 | 业务数值（或 `0`） |
| `true` | `true` | 位于范围内但在今天之后 | `null` |
| `false` | （不适用） | 布局填充 | `null` |

不要将这些状态全部渲染为 `value = 0`。零是真实的数值（当天无活动）。`null` 表示「按设计，我们对该日没有业务数据」——它使单元格保持视觉上的空白，且不会干扰最大值与等级的计算。

## API

```ts
buildCalendarHeatmap({
  mode: 'rolling-52-weeks' | 'calendar-year',
  today: number | Date,                  // UTC 毫秒或 Date 实例
  year?: number,                          // `calendar-year` 模式必填
  data?: Map<string, { total: number, requests: number }>,
  valueKey?: 'total' | 'requests',
}): {
  weeks: HeatmapDay[][],                  // [weekIndex][weekdayIndex]
  monthLabels: { year, month, weekIndex }[],
  rangeStart: 'YYYY-MM-DD',
  rangeEnd: 'YYYY-MM-DD',
  mode,
}
```

渲染器（`src/dashboard/heatmap-view.ts`）是 HTML 输出的唯一事实来源。它为每一天输出一个 `<i class="cell" ...>` 标签，带有 `data-week`、`data-weekday`、显式的内联 `grid-column` / `grid-row` 位置、`data-level`、`data-date`、`data-future`、`data-inrange`、`data-tooltip` 以及 `aria-label` 属性。仪表盘的工具提示层与 CSS 通过这些属性进行挂接，而无需触碰日期/星期的逻辑。月份标签输出为 `<span style="grid-column:N">M月</span>`——即共享 `.months` 周轨道内的真实网格位置。

## 测试

测试位于中央测试包中，其中热力图相关的测试已合并进 `action-worker:tests/packs/ai-gateway/dashboard-test.mjs`：

- 工具函数契约（原 `calendar-heatmap-test.mjs` 段落）：rolling-52-weeks、calendar-year（包括 54 列年份在内的精确列数）、月份标签锚定、月份边界、闰年、UTC+8 日界、范围内/范围外/未来/历史边界。
- HTML 输出契约（原 `calendar-heatmap-view-test.mjs` 段落）：单元格数量、等级量化、未来单元格的工具提示、显式的单元格位置、右边缘标签保留、属性集合。
- C01–C15 规范表（原 `calendar-heatmap-contract-test.mjs` 段落）：52 列、周一为首、YYYY-MM-DD 键、未来 ≠ 零、monthStart 锚定、无边缘丢失、calendar-year 的精确列数、填充/未来/历史语义、UTC+8 边界、渲染器与构建器的列一致性、共享的 `--week-count` CSS grid。

「364 个单元格 / 12 个月份标签」的适配器契约通过 `buildHeatmap` 的薄适配器保留，相关测试见 `action-worker:tests/packs/ai-gateway/usage-accounting-test.mjs`。
