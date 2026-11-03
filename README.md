# dsh-agent-speedup

Tool-execution efficiency suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
read-only result caching, speculative prefetch, and concurrent readonly shell commands — each with a
measured, bounded scope.

[![npm](https://img.shields.io/npm/v/dsh-agent-speedup)](https://www.npmjs.com/package/dsh-agent-speedup)
[![CI](https://img.shields.io/github/actions/workflow/status/HJ1H/dsh-agent-speedup/ci.yml)](https://github.com/HJ1H/dsh-agent-speedup/actions)
[![license](https://img.shields.io/npm/l/dsh-agent-speedup)](LICENSE)

## The honest premise

In our measurements across 6 real agent sessions (2,517 tool calls, 1,311 minutes), model latency
(TTFT + thinking + generation) takes **87.2%** of the critical path, tool execution **22.1%**. This
plugin works inside that 22% — nothing here reduces the number of model round trips, which is where
the other 78% lives.

Within that 22%, three different problems exist, and each capability targets one:

| Capability | Problem it solves | Measured |
|---|---|---|
| **Cache** | Same read-only call repeated | repeated read **2023 ms → 7 ms** (serial runs) |
| **In-flight merge** | The same call repeated inside one parallel batch | 3 simultaneous reads span **2027 ms total**, not 6 s |
| **Prefetch** | Files the model will ask for right after a `glob` | tool time **10.08 s → 2.07 s (−79.4%)**; per-read median **2016 ms → 11 ms** |
| **Shell concurrency** | Multiple readonly shell commands serialized | window **13.81 s → 4.65 s (−66.3%)**, 4/4 commands in one batch |

Caching and scheduling are measured separately, on purpose. The concurrency figure above comes from a
run with `cache: false, speculate: false` — nothing but scheduling is changed. Full method, paired
confidence intervals and the metric caveats: [docs/BENCHMARK.md](docs/BENCHMARK.md).

And two things it deliberately does not fix: on local millisecond-scale tools the plugin is
invisible (tools were 0.1–9.4% of wall in our runs), and DeepSeek Harness already parallel-batches
concurrency-safe tools — in our baseline 7 tool calls (6 reads + 1 shell) were dispatched within
19 ms with no plugin installed, and 5 adjacent tool results landed within 100 ms of each other.

**Different layer from HarnessMM.** [HarnessMM](https://arxiv.org/abs/2610.32813) also targets
DeepSeek Harness, but it removes *model reasoning calls* by replaying guarded decisions; this plugin
removes *tool executions* and never touches reasoning. They compose — a decision graph still names
tool calls, and a cache hit makes those calls cheaper. See
[docs/BENCHMARK.md](docs/BENCHMARK.md#harnessmm-arxiv-261032813--closest-neighbour-different-layer)
for the accounting caveat if both are installed.

Full method, sample sizes, and the findings that argue against this plugin:
[docs/BENCHMARK.md](docs/BENCHMARK.md).

## Install

```bash
dsh plugin --profile web add dsh-agent-speedup
```

Node 22+, dsh 0.2.x, `pnpm` on PATH (Windows: pnpm 10 — pnpm 12 fails its store lock on some setups).

The bundled `cordis.patch.yml` activates caching and prefetch immediately. Shell concurrency is
**off by default** — see the safety note below.

### Overriding config: replace, don't merge

A dsh patch entry with the same `id` **replaces the whole config object** — it does not merge. If
you override one key, you must repeat every key you care about (the zod defaults fill in the rest,
but your intent may differ from the defaults). The bundled defaults are in
[cordis.patch.yml](cordis.patch.yml).

## The three capabilities

### Cache

Read-only tools (`read`, `glob`, `grep`, `read_image`, extendable) are cached by tool name plus
normalized arguments. On a hit the plugin returns the stored result without calling `next()` — the
real dispatch never happens.

Entries carry a stat fingerprint (`size` + `mtimeMs`) checked on every hit, so a file changed by
any means invalidates — including `bash`/`pwsh` writes, which emit no filesystem events.
`fs/write-intent` and `fs/edit-intent` add immediate invalidation for the editor path.

Relative paths resolve against the **agent's session working directory**, the same base dsh's own
`read` uses, so an agent that `cd`s elsewhere cannot collide with a same-named file elsewhere.
The cache is an LRU bounded by `maxEntries` (default 512), and a result whose file changed *during*
the read is not stored.

**In-flight coalescing.** dsh dispatches a turn's read-only calls in one parallel batch. A batch
containing the same call twice would miss the cache both times, because neither has finished. Calls
that arrive while an identical call is still running share that execution instead of repeating it —
this covers the parallel case the cache alone cannot.

Tool names are matched literally. `read`, `glob`, `grep` and `read_image` are built in; any custom
or MCP tool you want cached must be listed in `readonlyTools` (and in `speculateOn` if its results
should trigger prefetch). Unknown names are never assumed safe.

### Prefetch

When a `glob` result comes back, the plugin pre-executes the same-family read tool for the first N
paths, in the background. Those results land in the same cache, so when the model actually asks,
nothing runs. Prefetch calls go through the ordinary pipeline — same agent context, same working
directory, same guards — so denials and errors are handled identically.

### Shell concurrency

dsh's `bash` and `pwsh` tools declare no `isConcurrencySafe`, so every shell call runs exclusively —
four readonly `Get-*` calls that should share one parallel window instead took 7.1 s
(measured: per-call gaps of 2.2–2.5 s). With this capability enabled, the same four calls completed
in 317 ms. The capability attaches a conservative classifier that marks a command
concurrency-safe only when every segment matches a readonly whitelist and no write pattern appears.

**This is off by default.** A classifier mistake means two shell commands with side effects run at
the same time. Enable it only if you accept that risk:

```yaml
- id: agent-speedup
  config:
    cache: true            # repeat everything below — replace semantics!
    readonlyTools: []
    validateStat: true
    maxEntries: 512
    speculate: true
    prefetchN: 3
    speculateOn: [glob]
    speculateRootPrefix: ""
    shellConcurrency: true
    shellTools: [bash, pwsh]
```

The classifier is deliberately strict: `npm test`, `cargo build`, `python script.py` are all treated
as side-effecting (they may write), and unknown commands are rejected rather than guessed.
Subcommands are handled per verb, not per program name — `git branch` (list) is readonly while
`git branch new` (create) is not; `git remote` lists but `git remote add` rewrites config; `find`
allows `-print` but not `-fprint`/`-exec`/`-delete`; `file -C`, `tree -o`, `date -s` are rejected.

Four classes are rejected outright because their effect is only known at run time: command
substitution (`$(...)`, backticks), `${VAR}` expansion, escaped shell metacharacters, and
`NAME=value cmd` prefixes (`GIT_EXTERNAL_DIFF`, `LD_PRELOAD`, `NODE_OPTIONS` all let a "readonly"
command run arbitrary code). PowerShell script blocks (`{ ... }`, which `Where-Object` /
`ForEach-Object` execute) are also rejected. A bare `&` splits the command line like `;` — an
attacker cannot hide a writer behind a background job.

An adversarial review of this classifier is part of the release process; the escapes it found in
0.2.2 are each covered by a regression test (see `test/classify-command.test.js`, `R2` suites).

## Configuration

All keys with zod defaults; a patch override replaces the whole object.

| Key | Default | |
|---|---|---|
| `cache` | `true` | Read-only result cache |
| `readonlyTools` | `[]` | Extra tool names to cache |
| `validateStat` | `true` | Stat fingerprint check on every hit |
| `maxEntries` | `512` | LRU cap on cached results (1–100000) |
| `speculate` | `true` | Speculative prefetch |
| `speculateOn` | `["glob"]` | Tools whose results trigger prefetch |
| `prefetchN` | `3` | Max files per prefetch (1–64) |
| `speculateRootPrefix` | `""` | Only prefetch under this prefix |
| `shellConcurrency` | `false` | Readonly shell commands join dsh's parallel batch |
| `shellTools` | `["bash","pwsh"]` | Shell tools to patch |
| `debugLogFile` | unset | Write scheduling events here |

## Safety

Read-only tools only. `bash`, `pwsh`, `write` and `edit` are passed through untouched and are never
cached or prefetched. Error results, including guard denials, are not remembered. Cache and
in-flight prefetches are cleared when the plugin unloads (in-flight prefetch aborts included).

One known boundary, found in independent review:

- **Cache hits short-circuit the waterfall.** A hit returns without calling `next()`, which also
  skips `tools/execute` listeners registered by plugins loaded after this one. If you run other
  execute-stage plugins, load them before this one.

The working-directory boundary from 0.2.1 is **fixed** in 0.2.2: keys and stat checks now use
`workingDirectory` (the agent's session directory), with a process-`cwd` fallback only when that
service is not mounted. If the fingerprint cannot be taken at all, the entry is simply not cached.

## 中文

给 DeepSeek Harness 用的工具执行效率套件，三个能力各自对应一类可实测的问题：

- **缓存**：只读工具重复调用直接命中（5 次配对实测：串行场景第三次读 2023ms → 7ms）
- **在途合并**：同一个并行批里重复的调用只执行一次（3 个并发读总跨度 2027ms，而非 6 秒）
- **预取**：`glob` 之后预读文件，模型开口时结果已在（工具总耗时 10.08s → 2.07s，−79.5%；
  单次读取中位 2016ms → 11ms，−99.5%）
- **只读 shell 并发**：dsh 原生会把 shell 命令串行（4 条只读命令串行 13.81 秒，
  开启后工具窗口 4.65 秒，−66.3%，且 4/4 进入同一并行批）。默认关闭，需显式开启。
  这条数据来自 `cache: false, speculate: false` 的隔离运行——只有调度，不含缓存。
- **判定粒度**：按子命令和参数判定，不按程序名放行——`git branch`（列举）只读、
  `git branch new`（创建）不是；`find -print` 放行、`-fprint/-exec/-delete` 拒绝。
  命令替换、`${VAR}`、转义元字符、`NAME=value cmd` 赋值前缀、PowerShell 脚本块
  一律拒绝（它们的实际行为要到运行时才知道）

前提要清楚：模型延迟占关键路径的 87%，工具占 22%。本地毫秒级工具上这个插件无感；
收益集中在"慢工具 + 重复调用"场景。数字、方法和反面结果在
[docs/BENCHMARK.md](docs/BENCHMARK.md)。

**配置覆盖是整体替换不是合并**——覆盖一个字段时请把要的字段全部写上。

## License

MIT
