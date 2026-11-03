# Benchmark method and results

Measured 2026-11-01 / 02 on DeepSeek Harness 0.2.1-rc.5, Windows, `dsh headless` one process per task.
This document exists so the numbers in the main README have a stated method, a stated sample size,
and a stated set of conditions under which they do **not** hold.

## Cross-session survey (the reason the scope is stated this way)

Before building, we analyzed 6 real agent sessions — 42 transcripts, 1,311 minutes, 2,517 tool
calls, all subagent workloads on this machine:

- Model streaming time: **87.2%** of the union critical path; tool execution windows: **22.1%**.
- Bash is the dominant tool everywhere: 75.9–83.8% of calls per session.
- **The model already batches through the shell**: 39.6% of bash commands contain ≥2 operations,
  and 22–44% of commands carry shell loops. A tool-layer batch primitive largely duplicates what
  the model already does.
- Same-message multi-calls exist (25.7% of turns) but 87.7% of them run serialized — and their
  total span is only 26.8 min across all sessions, bounding the concurrency win at **1.9%**.
- WebFetch failed 14/14 in one session (proxy), which forced the agent to hand-roll `node fetch.mjs`
  and run 64 single-URL rounds — a batch-fetch tool would have helped there, but that is a
  network-egress problem, not a missing-tool problem.

Consequence for this plugin: the capabilities target **repeat calls, prefetchable reads, and
serial readonly shell commands** — not a general "make agents fast" claim. The model round trips
that dominate wall time are out of scope for any tool-layer plugin.

## Setup

Every cell is the same five-task fixture, run three times, wall time measured from process spawn to
the final event, median reported.

- **Fixture**: six deterministic files (four small JS modules, `package.json`, `README.md`).
- **Tasks T1–T3** use the real tools (`read`, `glob`) — these are the "fast local tool" case.
- **Tasks T4–T5** use a benchmark instrument (`slow_read`, `slow_glob`) with a fixed 2 s artificial
  delay per call, because on this stack the fast tools are too cheap to measure against the model.
  A guard disables the fast tools during those tasks so the instrument is actually exercised.
- **Attribution** comes from two sources: timings stamped on the `--json` event stream, and the
  plugin's own debug ledger (`debugLogFile`), which records `execMs` per miss and `avoidedMs` per hit.

## Where the time goes

| Workload | Tool share of wall time |
|---|---|
| Fast local tools (T1–T3) | 0.1% – 9.4% |
| Slow instrument, 2 s per call (T4–T5) | 10% – 19% |

Model latency dominates in every configuration we measured. On a free-tier gateway the first token
alone ranged 2–10 s and varied by ±5–20 s between otherwise identical runs. That variance is larger
than most of the effects being measured, which is why the sample size below matters.

## Results

Same task, plugin off versus on, three runs per cell, median wall time.

| Model / endpoint | Task | Off | On | Δ |
|---|---|---|---|---|
| deepseek-v4.1-flash @ opencode zen (paid) | T4: 3 reads, one repeated | 29.9 s | 16.0 s | **−46%** |
| deepseek-v4.1-flash @ opencode zen (paid) | T5: glob + 4 reads | 15.9 s | 14.0 s | −12% |
| sensenova-6.8-flash-lite (free tier) | T4: 3 reads, one repeated | 32.2 s | 25.4 s | −21% |
| sensenova-6.8-flash-lite (free tier) | T5: glob + 4 reads | 22.9 s | 22.8 s | −0.4% |

Mechanism-level confirmation, independent of wall time:

- T4: every run recorded exactly one `cache-hit` with `avoidedMs ≈ 2006` — the 2 s instrument delay
  was actually skipped, not merely overlapped.
- T5: prefetch launched 4 of 4 files and the model's subsequent four reads all hit
  (`speculative: true`), with zero prefetch failures.

Two follow-up regression runs, with the plugin versions they belong to (kept separate because the
numbers are not interchangeable):

- **0.1.x plugin** (−49.7% per-call tool time on T4, −79.4% on T5; wall −7.4% and −17.5%): measured
  before the suite rewrite. Wall deltas at this sample size were dominated by model-side variance.
- **0.2.0 release candidate** (this package): T4 wall −14.7%, T5 wall −10.5%, ledger showing
  14 cache hits and 28.1 s of instrumented execution avoided across 6 runs. Confirms the mechanism
  survived the rewrite; the wall deltas differ from 0.1.x within model-side variance.

## Two results that argue against the plugin

These were found during the work and are reported because they bound the claim.

**dsh already parallelises.** Concurrency-safe tools are dispatched in batches. In baseline runs the
model issued four `slow_read` calls at once and they completed in a single 2 s window. Prefetch
therefore saves the window it overlaps, not the sum of the read times. This is why T5 gains less
than T4 in every configuration.

**Stronger models rewrite paths.** With `deepseek-v4.1-flash`, two of three runs issued absolute
paths where the prefetcher had used relative ones. Without key normalization the cache would never
have hit. With normalization it does, but this episode is a reminder that a deterministic prefetcher
has to agree with the model's argument formatting, and models differ.

## Limits

- n=3 per cell. Only the T4 improvement is consistent; the rest are within noise.
- One process per task, so the cache never survives between runs. Cross-run persistence is not
  implemented and not measured.
- The prefetcher is a rule (`glob` result → first N same-family reads), not a learned predictor. Its
  4/4 hit rate reflects the task shape. For reference, PASTE — which mines patterns from traces —
  reports 27.8% top-1 prediction accuracy and relies on multiple candidates.
- Side-effecting tools are out of scope entirely: no dry-run rewriting, no overlay commit, no
  speculative `bash`.

## 0.2.2 end-to-end verification (real dsh, not synthetic)

Both runs below are real `dsh headless` turns against the bundled fixture, with the plugin mounted
through a patch file and its debug ledger captured.

**T2 — repeated read.** 3 model reads of 2 files, serial execution: ledger recorded 2 `cache-miss`
and 1 `cache-hit` (`avoidedMs: 3`). An earlier run of the same task had the model issue all three
reads in one parallel batch and produced 3 misses — see the next point.

**T5 — slow tools (2 s instrument).** `slow_glob` launched 3 prefetches; the model's following
three `slow_read` calls all hit (`speculative: true`, `avoidedMs ≈ 2013` each), and a fourth read of
a non-prefetched file cost the full 2 s. Ledger: `{cache-miss: 5, spec-start: 3, spec-done: 3,
cache-hit: 3}` — about 6 s of instrumented execution avoided in one turn.

### What the E2E run changed

The first T2 run showed the plugin doing nothing, and the reason was not a bug in the cache: dsh
dispatches a turn's read-only calls **in one parallel batch**, so the second and third reads queried
the cache before the first had finished and all three went to disk. Caching alone cannot serve a
batch of simultaneous duplicates.

0.2.2 adds **in-flight coalescing**: concurrent calls with the same key share one dispatch
(`cache-coalesced` in the ledger). Serial repeats hit the cache; parallel repeats of the same call
collapse into one execution. Both shapes have regression tests.

### Custom tool names need configuration

T5 initially produced no events at all because it uses `slow_read`/`slow_glob` while the defaults
name only `read`/`glob`/`grep`/`read_image`. Custom and MCP tool names must be added to
`readonlyTools` and `speculateOn` explicitly. This is by design — silently treating an unknown tool
as read-only would be unsafe — but it is the first thing to check if the ledger stays empty.

## Prior art

[PASTE](https://arxiv.org/abs/2603.18897) ·
[TomasuLLM](https://arxiv.org/abs/2609.38201) ·
[SPAgent](https://arxiv.org/abs/2511.20048) ·
[LLMCompiler](https://arxiv.org/abs/2312.04511) ·
[HarnessMM](https://arxiv.org/abs/2610.32813)

### HarnessMM (arXiv 2610.32813) — closest neighbour, different layer

HarnessMM targets **DeepSeek Harness v0.2.0-rc.1**, the same harness this plugin is built for, so the
comparison deserves to be explicit.

It removes *model reasoning calls*. An authored Executable Decision Graph stores an action with literal
arguments and a public guard; when a tool receipt satisfies the guard, the decision executes through
the native tool interface and the redundant reasoning callback is skipped, certified by a record that
binds graph hash, decision id, exact args, tool receipt and the omitted callback id.

This plugin removes *tool executions*. It caches repeat read-only results, merges identical in-flight
calls, prefetches files a `glob` just named, and lets readonly shell commands join dsh's parallel
batch. Model reasoning is never touched — a cache hit replaces the tool call, not the thought that
requested it.

The two compose, and the ordering matters: HarnessMM's decision graphs still name tool calls, and a
cached result makes such a call cheaper but does not remove it. Conversely, this plugin cannot save a
single model call. On the paper's own accounting, DeepSeek Harness spends 96.28k tokens/task against
53.98k for MBPP — token cost is dominated by reasoning, not tool execution, which is why their
savings (up to 87.9%) are far larger than anything measurable here.

**One real overlap.** The paper's `Certified Callback Substitution` needs to know that a tool call
completed with a specific receipt. Our prefetch produces results whose consumption is invisible to
the model, and our cache hit bypasses the tool entirely. If both were installed, a HarnessMM guard
reading "the previous compile succeeded" would still work (we never touch shell state), but a guard
depending on a *read* receipt could observe a cache-served result whose execution never happened.
This is not exploitable in the sense of wrong results — the cached bytes are the correct bytes — but
it changes what a substitution certificate can claim about physical execution.

**What we deliberately do not claim.** HarnessMM measures complete-episode cost including authorship,
selector, fallback and recovery. Our ledger measures avoided instrumented execution time and cache
hit counts; we do not price our own overhead the same way, so the two efficiency figures are not
comparable and this document does not compare them.
