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
| **Cache** | Same read-only call repeated | wall **−13.5%** (T4) and **−10.5%** (T5), release build; an earlier calibration on the same task shape measured **−46%** |
| **Prefetch** | Files the model will ask for right after a `glob` | 12/12 prefetch calls completed, results served from cache on the model's next reads (ledger: 14 hits, 28.1 s of instrumented execution avoided across 6 runs) |
| **Shell concurrency** | Multiple readonly shell commands serialized | 4 pwsh calls: **7,103 ms serialized → 317 ms concurrent (22×)**, identical task and model |

And two things it deliberately does not fix: on local millisecond-scale tools the plugin is
invisible (tools were 0.1–9.4% of wall in our runs), and DeepSeek Harness already parallel-batches
concurrency-safe tools — in our baseline 7 tool calls (6 reads + 1 shell) were dispatched within
19 ms with no plugin installed, and 5 adjacent tool results landed within 100 ms of each other.

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

## Safety

Read-only tools only. `bash`, `pwsh`, `write` and `edit` are passed through untouched and are never
cached or prefetched. Error results, including guard denials, are not remembered. Cache and
in-flight prefetches are cleared when the plugin unloads (in-flight prefetch aborts included).

Two known boundaries, found in independent review:

- **Working-directory assumption.** Cache keys and stat checks resolve relative paths against the
  process working directory, while dsh's `read` resolves against the agent's working directory. In
  headless mode (one process per workspace) these coincide. If an agent `cd`s elsewhere, entries
  whose file cannot be stat'd are simply not cached (fail-safe), but same-named files across
  different agent working directories are not disambiguated.
- **Cache hits short-circuit the waterfall.** A hit returns without calling `next()`, which also
  skips `tools/execute` listeners registered by plugins loaded after this one. If you run other
  execute-stage plugins, load them before this one.

## 中文

给 DeepSeek Harness 用的工具执行效率套件，三个能力各自对应一类可实测的问题：

- **缓存**：只读工具重复调用直接命中（发布候选回归实测免掉 28 秒真实执行 / 6 轮）
- **预取**：`glob` 之后预读文件，模型开口时结果已在（实测 12/12 预取完成、结果全部从缓存供给）
- **只读 shell 并发**：dsh 原生会把 shell 命令串行（实测 4 条毫秒级命令串行 7.1 秒，
  开启后 317 毫秒完成，22 倍），本插件给只读命令打上并发标记，
  让它们进入 dsh 原生并行批（默认关闭，需显式开启）

前提要清楚：模型延迟占关键路径的 87%，工具占 22%。本地毫秒级工具上这个插件无感；
收益集中在"慢工具 + 重复调用"场景。数字、方法和反面结果在
[docs/BENCHMARK.md](docs/BENCHMARK.md)。

**配置覆盖是整体替换不是合并**——覆盖一个字段时请把要的字段全部写上。

## License

MIT
