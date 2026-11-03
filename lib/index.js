// dsh-agent-speedup — DeepSeek Harness 工具执行效率套件
//
// 三个独立能力，各自标注适用域与实测收益（数据见 docs/BENCHMARK.md）：
//
//   1. cache        只读工具结果缓存（重复调用直接命中）
//                   适用域：同一只读调用重复发生。实测：重复读场景 wall -46%（付费 DeepSeek 栈）。
//                   本地毫秒级工具负载无感（工具仅占 wall 0.1–9.4%）。
//
//   2. prefetch     glob 族结果 → 后台预读同族文件（结果进同一缓存）
//                   适用域：glob 之后紧接多个 read 的序列。实测：4/4 预取命中。
//
//   3. shellConcurrency  只读 shell 命令标记为并发安全，进入 dsh 原生并行批
//                   适用域：同一 assistant 消息里有多条只读命令。实测：Phase 0 基线显示
//                   5 个 pwsh 调用被串行执行（19.4s，实际都是毫秒级命令）；启用后 4 条
//                   只读命令在 8ms 内完成并发判定并同批执行。
//
// 安全边界（对所有能力一致）：
//   - 副作用工具（bash/pwsh/write/edit）永不缓存、永不预取
//   - shell 并发判定保守优先：命令逐段命中只读白名单且不含写入模式才放行
//   - 错误结果不进缓存；缓存条目带 stat 指纹，命中前校验
//
// 定位声明：推测性工具执行由 PASTE（arXiv 2603.18897）、TomasuLLM（arXiv 2609.38201）
// 先行提出；本包是该思路在 DeepSeek Harness 上的工程化实现，不主张新机制。
import { appendFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { classifyCommand } from "./util/classify-command.js";

/** Cordis 插件标识 */
const name = "agent-speedup";
/** 依赖的宿主服务 */
const inject = ["tools"];

/** 配置 schema（Web UI 设置页与 loader 校验共用） */
const Config = z.object({
  /** 只读工具结果缓存开关 */
  cache: z.boolean().default(true),
  /** 额外纳入缓存白名单的工具名 */
  readonlyTools: z.array(z.string()).default([]),
  /** 命中前校验文件 stat，文件变化即失效 */
  validateStat: z.boolean().default(true),

  /** 推测预取开关 */
  speculate: z.boolean().default(true),
  /** 触发推测的工具名（glob 族） */
  speculateOn: z.array(z.string()).default(["glob"]),
  /** 单次推测最多预取的文件数 */
  prefetchN: z.number().int().min(1).max(64).default(3),
  /** 仅预取以此前缀开头的路径（防 node_modules 漫灌）；空 = 不限 */
  speculateRootPrefix: z.string().default(""),

  /** 只读 shell 命令进入 dsh 原生并行批（默认关：判定错误会有并发副作用风险） */
  shellConcurrency: z.boolean().default(false),
  /** 参与并发判定的 shell 工具名 */
  shellTools: z.array(z.string()).default(["bash", "pwsh"]),

  /** 调试：调度事件写入此文件（默认关闭，不写用户目录） */
  debugLogFile: z.string().optional(),

  /** 缓存条目上限（LRU 淘汰，防止长会话内存无界增长） */
  maxEntries: z.number().int().min(1).max(100000).default(512),
});

const DEFAULT_READONLY = ["read", "glob", "grep", "read_image"];
/** glob 族 → 同族读取工具 */
const SPECULATE_READ_OF = { glob: "read", slow_glob: "slow_read" };

/** 仅做分隔符统一（不解析为绝对路径）：用于展示与前缀过滤。 */
function normPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

/**
 * 把模型/工具给出的路径候选写法统一成一个分隔符形态。
 * Windows 上 `\` 与 `/` 等价；POSIX 上 `\` 是文件名里的普通字符，
 * 但 agent 产生混合分隔符（Windows 风格路径在 Linux 容器里）时必须仍能归一，
 * 否则 `bench\fixture\a.js` 在 POSIX 上会被 resolve 成一个不存在的文件名。
 * 判定依据是「含反斜杠且不含正斜杠」，避免把真正带 `\` 的 POSIX 文件名误改。
 */
function unifySeparators(raw) {
  if (process.platform === "win32" || raw.includes("/")) return raw.replaceAll("\\", "/");
  return raw.includes("\\") ? raw.replaceAll("\\", "/") : raw;
}

/** 解析为稳定的绝对路径键。
 *  - 基准目录必须是 agent 的真实 session 工作目录，不是进程 cwd：dsh 允许 agent
 *    `cd` 到子目录，而进程 cwd 不变，用错基准会让不同文件共享同一键。
 *  - realpath 归一（Windows 盘符大小写、符号链接）；失败（路径不存在）退回 resolve。 */
function absPath(value, base) {
  const raw = unifySeparators(String(value ?? ""));
  if (!raw) return raw;
  try {
    const abs = resolvePath(base, raw);
    try {
      return realpathSync.native(abs);
    } catch {
      return abs;
    }
  } catch {
    return raw;
  }
}

/** 稳定键：工具名 + 规范化参数（键序固定）。
 *  只有明确的路径类参数才做路径归一——grep 的 pattern 是正则语义，
 *  对它做 resolve/realpath 会把 `a\db` 与 `a/db` 归一成同一键（假命中）。 */
function keyOf(tool, args, base = process.cwd()) {
  const normalized = {};
  for (const k of Object.keys(args ?? {}).sort()) {
    const v = args[k];
    normalized[k] = typeof v === "string" && PATH_ARGS.has(k) ? absPath(v, base) : v;
  }
  return `${tool}|${JSON.stringify(normalized)}`;
}

/** 已知承载文件路径的参数名；白名单外的字符串一律原样入键 */
const PATH_ARGS = new Set(["file_path", "path", "dir", "directory", "cwd", "file", "target"]);

/** 预取投递的 callId 前缀。tools/execute 处理器据此识别"这是我自己发起的"，
 *  避免其查 inflight 时命中自己登记的 Promise 而形成自等待死锁。 */
const SPEC_CALL_PREFIX = "spec-";

/** 文件 stat 指纹；失败返回 undefined（无法校验） */
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return `${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/** 从工具结果文本抽取候选文件路径 */
function pathsFromResult(result, filter) {
  let text = "";
  if (typeof result === "string") text = result;
  else if (Array.isArray(result?.content)) text = result.content.map((b) => b?.text ?? "").join("\n");
  else if (typeof result?.text === "string") text = result.text;
  else if (Array.isArray(result?.files)) text = result.files.join("\n");
  else {
    try { text = JSON.stringify(result); } catch { return []; }
  }
  return text
    .split(/\r?\n/)
    .map((s) => normPath(String(s).replace(/^["[]+|["\]]+$/g, "").trim()))
    .filter((s) => /\.(js|ts|mjs|cjs|json|md|txt|py|go|rs|java|yml|yaml|toml)$/i.test(s) && !s.endsWith("/"))
    .filter((s) => !filter || s.startsWith(filter));
}

export function apply(ctx, config) {
  const cfg = {
    ...config,
    readonlyTools: new Set([...DEFAULT_READONLY, ...(config.readonlyTools ?? [])]),
    speculateOn: new Set(config.speculateOn ?? ["glob"]),
  };

  /** key -> { result, spec, execMs, path?, fingerprint? } */
  const cache = new Map();
  /** 在途的真实 dispatch：同键并发调用共享这一次执行（dsh 会把只读工具并行批发出） */
  const inflight = new Map();
  const prefetching = new Set();
  const stats = { hit: 0, hitSpeculative: 0, coalesced: 0, stale: 0, miss: 0, speculativeLaunched: 0, speculativeFailed: 0 };
  let logReady = false;

  const log = (entry) => {
    if (!cfg.debugLogFile) return;
    try {
      if (!logReady) { mkdirSync(dirname(cfg.debugLogFile), { recursive: true }); logReady = true; }
      appendFileSync(cfg.debugLogFile, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
    } catch { /* 观测失败不影响调度 */ }
  };

  /** 命中校验：带路径指纹且开启 validateStat 时必须一致 */
  const lookup = (key) => {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (cfg.validateStat && entry.path !== undefined && entry.fingerprint !== undefined) {
      if (statFingerprint(entry.path) !== entry.fingerprint) {
        cache.delete(key);
        stats.stale++;
        log({ kind: "cache-stale", key });
        return undefined;
      }
    }
    return entry;
  };

  /** LRU：命中或写入时把条目移到 Map 尾部（Map 迭代顺序 = 插入顺序）。 */
  const touch = (key, entry) => {
    cache.delete(key);
    cache.set(key, entry);
  };
  /** 超出上限时从最旧的一端淘汰。 */
  const enforceCap = () => {
    while (cache.size > cfg.maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
      stats.evicted = (stats.evicted ?? 0) + 1;
    }
  };

  /** 当前调用的目录基准：agent 的 session 工作目录（dsh 的 fs 工具同样以它解析相对路径）。
   *  workingDirectory 服务在本 profile 未挂载时回退进程 cwd——两者在默认 headless/web 部署里相同。 */
  const baseOf = (exec) => {
    try {
      const wd = typeof ctx.get === "function" ? ctx.get("workingDirectory", false) : undefined;
      const session = exec?.agent?.session;
      if (wd && session) return wd.get(session);
    } catch { /* 服务形态不匹配则回退 */ }
    return process.cwd();
  };

  // ================= 能力 1：缓存 =================
  ctx.on("tools/execute", async (exec, next) => {
    if (!cfg.cache || !cfg.readonlyTools.has(exec?.name)) return next();
    // 预取自己发起的 dispatch 会重新进入本处理器。此时它还登记在 inflight 里，
    // 若继续往下走就会查表命中自己 → await 自己 → 永不结算、整批读挂死
    // （实测 zen 与 sensenova 两组 T5 on 臂都卡在这里）。
    // 直接放行真实 dispatch：落缓存由 prefetch() 的 then 负责，职责不重叠。
    if (String(exec?.callId ?? "").startsWith(SPEC_CALL_PREFIX)) return next();
    const base = baseOf(exec);
    const key = keyOf(exec.name, exec.arguments, base);
    const t0 = Date.now();
    const hit = lookup(key);
    if (hit !== undefined) {
      touch(key, hit);
      stats.hit++;
      if (hit.spec) stats.hitSpeculative++;
      log({ kind: "cache-hit", tool: exec.name, key, speculative: hit.spec, avoidedMs: hit.execMs ?? null });
      return hit.result;
    }
    // 读前指纹：与读后比对，覆盖"读取窗口内被写入"的交叠情况（R1b TOCTOU 收紧）。
    const filePath = exec.arguments?.file_path;
    const trackedPath = typeof filePath === "string" ? absPath(filePath, base) : undefined;
    const preFp = trackedPath === undefined ? null : statFingerprint(trackedPath);

    // 在途合并：dsh 会把同一批只读调用并行发出，此时前一个同键调用还没写缓存。
    // 复用它的 Promise，避免同一个文件被读两次（重复读最常见的形态就是并行批）。
    const pending = inflight.get(key);
    if (pending !== undefined) {
      stats.coalesced++;
      log({ kind: "cache-coalesced", tool: exec.name, key });
      return pending;
    }

    const work = (async () => {
      const result = await next();
      if (result?.isError) return result;
      // 唯一判定「哪一个在途调用负责落缓存」：拿到锁的那个负责写
      return result;
    })();
    inflight.set(key, work);
    let result;
    try {
      result = await work;
    } finally {
      inflight.delete(key);
    }
    if (result?.isError) { stats.miss++; return result; }
    const execMs = Date.now() - t0;
    // 带路径的条目必须拿到 stat 指纹才可缓存：指纹取不到说明该路径不可达，
    // 缓存它有跨目录内容污染风险。
    // glob/grep 等无 file_path 的条目标记 volatile，由写意图与 shell 调用触发整体失效。
    let fp = null;
    if (trackedPath !== undefined) {
      fp = statFingerprint(trackedPath);
      if (fp === undefined) { stats.miss++; return result; }
      // 读窗口内文件发生了变化 → 返回的内容可能不是写入后的版本，不入缓存。
      if (preFp !== undefined && preFp !== null && preFp !== fp) {
        stats.unstable = (stats.unstable ?? 0) + 1;
        log({ kind: "cache-skip-unstable", path: trackedPath, pre: preFp, post: fp });
        stats.miss++;
        return result;
      }
    }
    touch(key, {
      result,
      spec: prefetching.has(key),
      execMs,
      volatile: trackedPath === undefined, // glob/grep 等无指纹条目：写意图/shell 调用后整体失效
      ...(trackedPath !== undefined ? { path: trackedPath } : {}),
      ...(fp !== null ? { fingerprint: fp } : {}),
    });
    enforceCap();
    stats.miss++;
    log({ kind: "cache-miss", tool: exec.name, key, speculative: prefetching.has(key), execMs });
    return result;
  });

  // ================= 能力 2：推测预取 =================
  /** 在途预取的控制器：卸载时统一 abort，防止 teardown 后仍写缓存/日志 */
  const inflightControllers = new Set();
  const prefetch = (paths, tool, base, origin) => {
    const targets = [];
    for (const p of paths) {
      if (targets.length >= cfg.prefetchN) break;
      const abs = absPath(p, base);
      const key = keyOf(tool, { file_path: p }, base);
      if (cache.has(key) || prefetching.has(key)) continue;
      prefetching.add(key);
      targets.push({ path: p, abs, key, startedAt: 0 });
    }
    for (const t of targets) {
      stats.speculativeLaunched++;
      log({ kind: "spec-start", tool, path: t.path });
      const controller = new AbortController();
      inflightControllers.add(controller);
      t.startedAt = Date.now();
      const settle = (fn) => { prefetching.delete(t.key); inflightControllers.delete(controller); fn(); };
      try {
        // 把预取的 promise 登记进 inflight：真实调用在预取完成前到达时，
        // tools/execute 会命中该条目并等待同一个执行，而不是再跑一次。
        // 实测：zen T5 有一轮模型在 glob 后 1.93 s 就发 read，预取（2 s）差 70 ms
        // 没完成，四个读全部重跑；登记后这种"赛跑输掉"会变成"等 70ms 拿结果"。
        let p;
        /** 预取的 inflight 条目只对"预取还在跑"这段窗口有效，无论成败都必须摘除。 */
        const releaseInflight = () => { if (p !== undefined && inflight.get(t.key) === p) inflight.delete(t.key); };
        p = ctx.tools
          .execute({
            name: tool,
            arguments: { file_path: t.path },
            callId: `${SPEC_CALL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            // 透传 agent：dsh 的 fs 工具用它解析 session 工作目录与沙箱策略。
            // 不透传会让预取在 agent 已 cd 的会话里读到与真实调用不同的文件。
            ...(origin?.agent ? { agent: origin.agent } : {}),
            ...(origin?.rootCallId ? { rootCallId: origin.rootCallId } : {}),
            signal: controller.signal,
          })
          .then((result) => settle(() => {
            releaseInflight();
            if (controller.signal.aborted) return undefined;
            if (result?.isError) { stats.speculativeFailed++; log({ kind: "spec-fail", path: t.path, reason: "error-result" }); return result; }
            // 真实调用已经写了缓存 → 以它为准
            if (cache.has(t.key)) { log({ kind: "spec-done", path: t.path, stored: false, note: "real-call-won" }); return result; }
            const fp = statFingerprint(t.abs);
            if (fp !== undefined) {
              touch(t.key, { result, spec: true, execMs: Date.now() - t.startedAt, path: t.abs, fingerprint: fp });
              enforceCap();
              log({ kind: "spec-done", path: t.path, stored: true, execMs: Date.now() - t.startedAt });
            } else {
              stats.speculativeFailed++;
              log({ kind: "spec-fail", path: t.path, reason: "no-fingerprint" });
            }
            return result;
          }))
          .catch((e) => settle(() => {
            releaseInflight();
            stats.speculativeFailed++;
            log({ kind: "spec-fail", path: t.path, error: String(e).slice(0, 160) });
            throw e;
          }));
        inflight.set(t.key, p);
      } catch (e) {
        settle(() => { stats.speculativeFailed++; log({ kind: "spec-fail", path: t.path, error: String(e).slice(0, 160) }); });
      }
    }
  };

  ctx.on("tools/post-execute", async (exec, result, next) => {
    // shell 调用后清空 volatile 条目：bash/pwsh 可能写了文件且不发 fs 事件，
    // glob/grep 的无指纹条目此时已不可信（R1a Issue 1 的 shell 侧兜底）
    if (cfg.shellTools.includes(exec?.name)) dropVolatile("shell-call");
    if (cfg.speculate && cfg.speculateOn.has(exec?.name) && result != null) {
      const paths = pathsFromResult(result, cfg.speculateRootPrefix);
      if (paths.length) prefetch(paths, SPECULATE_READ_OF[exec.name] ?? "read", baseOf(exec), exec);
    }
    return next();
  });

  // ================= 能力 2.5：写意图即时失效 =================
  // ⚠ 契约：fs/write-intent 与 fs/edit-intent 是 waterfall（不是 emit），监听器签名
  //   (target, exec, next)，返回值就是写入意图。必须 return next()，否则：
  //   - 默认顺序下（fs-observation-policy 先注册且不调 next）本监听器永远不执行；
  //   - 顺序翻转时返回 undefined 会禁用宿主 fs-observation-policy 的 CAS 写入保护。
  // 两条失效规则：
  //   a) 条目路径与写意图匹配 → 精确删除；
  //   b) volatile 条目（glob/grep 等无 file_path 指纹的）→ 任何写意图都清空——
  //      其正确性前提是"目录内容未变"，无法用单文件 stat 校验。
  // bash/pwsh 的写入不发事件，由 stat 校验 + shell 调用后清空 volatile 兜底。
  // （fs/observed 故意不监听：它与 stat 指纹完全冗余，且随每次读取触发。）
  const dropVolatile = (reason) => {
    let dropped = 0;
    for (const [k, entry] of cache) {
      if (entry.volatile) { cache.delete(k); dropped++; }
    }
    if (dropped) log({ kind: "cache-volatile-drop", reason, dropped });
  };
  const invalidateByTarget = (target) => {
    // targetKey 是 fs 后端给的不透明稳定键（本地后端 = realpath），displayPath 是展示路径。
    // 两者都尝试：本地后端下 targetKey 与条目 path 同为 realpath，可直接相等。
    const candidates = [target?.targetKey, target?.displayPath]
      .filter((v) => typeof v === "string" && v.length > 0)
      .map((v) => absPath(String(v), process.cwd()));
    if (candidates.length) {
      for (const [k, entry] of cache) {
        if (entry.path !== undefined && candidates.includes(absPath(entry.path, process.cwd()))) {
          cache.delete(k);
          log({ kind: "cache-invalidated", key: k });
        }
      }
    }
    dropVolatile("write-intent");
  };
  ctx.on("fs/write-intent", (target, exec, next) => { invalidateByTarget(target); return next(); });
  ctx.on("fs/edit-intent", (target, exec, next) => { invalidateByTarget(target); return next(); });

  // ================= 能力 3：只读 shell 并发 =================
  const shellPatched = new Set();
  const patchShellConcurrency = () => {
    if (!cfg.shellConcurrency) return;
    for (const toolName of cfg.shellTools) {
      if (shellPatched.has(toolName)) continue;
      const tool = ctx.tools?.get?.(toolName);
      if (!tool) continue;
      if (typeof tool.isConcurrencySafe === "function") {
        shellPatched.add(toolName);
        log({ kind: "shell-concurrency-skip", tool: toolName, reason: "already-declared" });
        continue;
      }
      try {
        tool.isConcurrencySafe = (args) => classifyCommand(args?.command).readonly;
        shellPatched.add(toolName);
        log({ kind: "shell-concurrency-patched", tool: toolName });
      } catch (e) {
        shellPatched.add(toolName);
        log({ kind: "shell-concurrency-failed", tool: toolName, error: String(e).slice(0, 160) });
      }
    }
  };
  // 瀑布契约：(exec, next)，必须返回 next() 否则截断链条
  ctx.on("tools/pre-execute", (exec, next) => {
    patchShellConcurrency();
    // 判定日志：每次 shell 调用都记录分类结果
    if (cfg.shellConcurrency && cfg.shellTools.includes(exec?.name)) {
      const verdict = classifyCommand(exec.arguments?.command);
      log({ kind: "shell-concurrency-judge", tool: exec.name, readonly: verdict.readonly, reason: verdict.reason });
    }
    return next();
  });

  // ================= 生命周期 =================
  const bootTimers = [100, 500, 1500].map((ms) => setTimeout(patchShellConcurrency, ms));
  ctx.effect(() => () => {
    for (const t of bootTimers) clearTimeout(t);
    for (const c of inflightControllers) c.abort(new Error("plugin unloaded"));
    inflightControllers.clear();
    cache.clear();
    prefetching.clear();
    inflight.clear();
  }, "agent-speedup teardown");

  log({ kind: "plugin-boot", cfg: { cache: cfg.cache, speculate: cfg.speculate, prefetchN: cfg.prefetchN, shellConcurrency: cfg.shellConcurrency } });
}

export { Config, inject, name };
// 纯函数导出，供单测使用
export { keyOf, normPath, pathsFromResult };
