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
| **Cache** | Same read-only call repeated | wall **−13.5%** on the release-candidate run; **−46%** in the earlier calibration on the same task shape |
| **Prefetch** | Files the model will ask for right after a `glob` | 12/12 prefetch stored, 11 subsequent hits, 28 s of execution avoided across 6 runs |
| **Shell concurrency** | Multiple readonly shell commands serialized | 5 pwsh calls in 19.4 s → concurrent judgment in 8 ms |

And two things it deliberately does not fix: on local millisecond-scale tools the plugin is
invisible (tools were 0.1–9.4% of wall in our runs), and DeepSeek Harness already parallel-batches
concurrency-safe tools — 6 reads completed within 21 ms in our baseline, with no plugin installed.

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

### Prefetch

When a `glob` result comes back, the plugin pre-executes the same-family read tool for the first N
paths, in the background. Those results land in the same cache, so when the model actually asks,
nothing runs. Prefetch calls go through the ordinary pipeline, so guard denials and errors are
handled identically.

### Shell concurrency

dsh's `bash` and `pwsh` tools declare no `isConcurrencySafe`, so every shell call runs exclusively —
even five readonly `Get-ChildItem` calls take turns (measured: 19.4 s for what should be one
parallel window). This capability attaches a conservative classifier that marks a command
concurrency-safe only when every segment matches a readonly whitelist and no write pattern appears.

**This is off by default.** A classifier mistake means two shell commands with side effects run at
the same time. Enable it only if you accept that risk:

```yaml
- id: agent-speedup
  config:
    cache: true            # repeat everything below — replace semantics!
    speculate: true
    prefetchN: 3
    speculateOn: [glob]
    shellConcurrency: true
    shellTools: [bash, pwsh]
```

The classifier is deliberately strict: `npm test`, `cargo build`, `python script.py` are all treated
as side-effecting (they may write), and unknown commands are rejected rather than guessed.

## Configuration

All keys with zod defaults; a patch override replaces the whole object.

| Key | Default | |
|---|---|---|
| `cache` | `true` | Read-only result cache |
| `readonlyTools` | `[]` | Extra tool names to cache |
| `validateStat` | `true` | Stat fingerprint check on every hit |
| `speculate` | `true` | Speculative prefetch |
| `speculateOn` | `["glob"]` | Tools whose results trigger prefetch |
| `prefetchN` | `3` | Max files per prefetch (1–64) |
| `speculateRootPrefix` | `""` | Only prefetch under this prefix |
| `shellConcurrency` | `false` | Readonly shell commands join dsh's parallel batch |
| `shellTools` | `["bash","pwsh"]` | Shell tools to patch |
| `debugLogFile` | unset | Write scheduling events here |

## 中文

给 DeepSeek Harness 用的工具执行效率套件，三个能力各自对应一类可实测的问题：

- **缓存**：只读工具重复调用直接命中（重复读场景实测免掉 28 秒真实执行 / 6 轮）
- **预取**：`glob` 之后预读文件，模型开口时结果已在（实测 12/12 预取全部完成并命中）
- **只读 shell 并发**：dsh 原生会把 shell 命令串行（实测 5 条毫秒级命令跑了 19.4 秒），
  本插件给只读命令打上并发标记，让它们进入 dsh 原生并行批（默认关闭，需显式开启）

前提要清楚：模型延迟占关键路径的 87%，工具占 22%。本地毫秒级工具上这个插件无感；
收益集中在"慢工具 + 重复调用"场景。数字、方法和反面结果在
[docs/BENCHMARK.md](docs/BENCHMARK.md)。

**配置覆盖是整体替换不是合并**——覆盖一个字段时请把要的字段全部写上。

## License

MIT
