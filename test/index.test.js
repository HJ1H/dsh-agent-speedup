// 插件行为单测：用假的 ctx 驱动 apply()，覆盖缓存/失效/闸门/副作用放行/推测。
// 运行：node --test plugins/dsh-tool-scheduler/test/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, Config, name, inject, keyOf, normPath, pathsFromResult } from "../lib/index.js";

/** 断言一次调用走的是真实 dispatch：next 返回 {seq} 对象，
 *  缓存回放会返回同一个对象引用（不调用 next，seq 不递增）。 */
const dispatchSeqOf = (v) => (v && typeof v === "object" ? v.seq : undefined);

function makeCtx() {
  const handlers = new Map();
  let seq = 0;
  const ctx = {
    tools: {
      execute: async () => ({ isError: false, content: [{ type: "text", text: "spec-result" }] }),
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    effect(fn) {
      const disposer = fn();
      ctx.__disposers = [...(ctx.__disposers ?? []), disposer];
    },
    logger: { debug() {} },
    /** 触发某事件的第一个监听器；返回 { result, nextCalls } ——
     *  nextCalls 增量即「真实 dispatch 次数」，缓存命中时增量为 0。 */
    async fire(event, ...args) {
      const fns = handlers.get(event) ?? [];
      if (!fns.length) throw new Error(`no handler for ${event}`);
      const before = seq;
      const next = async () => {
        seq += 1;
        return { seq, via: "dispatch" };
      };
      for (const fn of fns) {
        const result = await fn(...args, next);
        return { result, nextCalls: seq - before };
      }
    },
    has(event) {
      return (handlers.get(event) ?? []).length > 0;
    },
  };
  return ctx;
}

/** 断言一次调用走的是真实 dispatch（返回值形如 DISPATCH#n） */
const isDispatch = (v) => typeof v === "string" && v.startsWith("DISPATCH#");

/** 解析并填充 Config 默认值，模拟 loader 行为 */
const cfgOf = (patch = {}) => Config.parse(patch);

describe("纯函数", () => {
  test("keyOf 对路径做分隔符规范化（相同文件的两种写法同键）", () => {
    const a = keyOf("read", { file_path: "bench\\fixture\\a.js" });
    const b = keyOf("read", { file_path: "bench/fixture/a.js" });
    assert.equal(a, b);
  });

  test("keyOf 对绝对路径与相对路径归一（强模型 absolutize 不影响命中）", () => {
    const rel = "bench/fixture/a.js";
    const abs = join(process.cwd(), rel);
    assert.equal(keyOf("read", { file_path: rel }), keyOf("read", { file_path: abs }));
  });

  test("keyOf 参数键序无关", () => {
    assert.equal(keyOf("read", { a: "1", b: "2" }), keyOf("read", { b: "2", a: "1" }));
  });

  test("normPath 保留非路径字符串", () => {
    assert.equal(normPath("abc"), "abc");
  });

  test("pathsFromResult 抽取文件并过滤后缀、目录与非前缀项", () => {
    const got = pathsFromResult("a.js\nb/c.ts\ndir/\nn.txt", "bench/");
    assert.deepEqual(got, []);
    const got2 = pathsFromResult("bench/a.js\nbench/b/c.ts\nnode_modules/x.js\nbench/readme.md", "bench/");
    assert.deepEqual(got2.sort(), ["bench/a.js", "bench/b/c.ts", "bench/readme.md"].sort());
  });
});

describe("插件契约", () => {
  test("导出 name/inject/Config 且注入 tools", () => {
    assert.equal(name, "agent-speedup");
    assert.deepEqual(inject, ["tools"]);
    assert.equal(cfgOf({}).cache, true);
    assert.equal(cfgOf({}).speculate, true); // 随包 patch 策略：默认开启
  });

  test("Config 拒绝非法 prefetchN", () => {
    assert.throws(() => Config.parse({ prefetchN: 0 }));
    assert.throws(() => Config.parse({ prefetchN: 999 }));
  });

  test("注册了缓存、推测、shell 并发与写意图失效监听器", () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({}));
    assert.ok(ctx.has("tools/execute"));
    assert.ok(ctx.has("tools/post-execute"));
    assert.ok(ctx.has("tools/pre-execute")); // shell 并发判定的介入点
    assert.ok(ctx.has("fs/write-intent"));
    assert.ok(ctx.has("fs/edit-intent"));
    // 不应监听 fs/observed——否则每次 read 都会删掉刚写的缓存
    assert.ok(!ctx.has("fs/observed"));
  });
});

describe("缓存语义", () => {
  test("同一只读工具第二次调用不再真实 dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sched-"));
    const file = join(dir, "x.js");
    try {
      writeFileSync(file, "content");
      const ctx = makeCtx();
      apply(ctx, cfgOf({}));
      const exec = { name: "read", arguments: { file_path: file } };
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1);
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0, "第二次应命中缓存");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("副作用工具（write/bash/pwsh/edit）永不缓存", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({}));
    for (const tool of ["write", "bash", "pwsh", "edit"]) {
      const exec = { name: tool, arguments: { path: "x.js" } };
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1, tool);
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1, `${tool} 不应被缓存`);
    }
  });

  test("isError 结果不进缓存（守卫拒绝后重试仍走真实 dispatch）", async () => {
    const ctx = makeCtx();
    const handlers = [];
    const rawOn = ctx.on;
    ctx.on = (ev, fn) => { if (ev === "tools/execute") handlers.push(fn); else rawOn.call(ctx, ev, fn); };
    apply(ctx, cfgOf({}));
    const exec = { name: "read", arguments: { file_path: "err.js" } };
    await handlers[0](exec, async () => ({ isError: true, content: [{ type: "text", text: "denied" }] }));
    let called = false;
    await handlers[0](exec, async () => { called = true; return { content: [] }; });
    assert.equal(called, true, "error 结果不应进缓存");
  });

  test("文件被改动后（stat 变化）缓存失效", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sched-"));
    const file = join(dir, "a.js");
    try {
      writeFileSync(file, "v1");
      const ctx = makeCtx();
      apply(ctx, cfgOf({ validateStat: true }));
      const exec = { name: "read", arguments: { file_path: file } };
      await ctx.fire("tools/execute", exec);
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0, "首次后应命中");

      writeFileSync(file, "v2-longer-content");
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1, "文件变化后应失效");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写意图事件立即失效对应缓存", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sched-"));
    const file = join(dir, "b.js");
    try {
      writeFileSync(file, "v1");
      const ctx = makeCtx();
      apply(ctx, cfgOf({ validateStat: false }));
      const exec = { name: "read", arguments: { file_path: file } };
      await ctx.fire("tools/execute", exec);
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0);
      // fs/write-intent 是 waterfall：监听器签名 (target, exec, next)
      await ctx.fire("fs/write-intent", { targetKey: file }, {});
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1, "写意图后应失效");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无 file_path 的 volatile 条目（glob/grep）在写意图后失效（R1a Issue 1 回归）", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({ validateStat: false }));
    const globExec = { name: "glob", arguments: { pattern: "**/*.ts" } };
    await ctx.fire("tools/execute", globExec);
    assert.equal((await ctx.fire("tools/execute", globExec)).nextCalls, 0, "无写入时应命中");
    // 任何写意图 → volatile 条目整体清空（glob 结果的正确性依赖目录内容未变，无法单文件校验）
    await ctx.fire("fs/write-intent", { targetKey: "somewhere/new.ts" }, {});
    assert.equal((await ctx.fire("tools/execute", globExec)).nextCalls, 1, "写意图后 glob 条目应失效");
  });

  test("shell 调用后 volatile 条目失效（bash/pwsh 写入不发 fs 事件的兜底）", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({}));
    const globExec = { name: "glob", arguments: { pattern: "**/*.ts" } };
    await ctx.fire("tools/execute", globExec);
    assert.equal((await ctx.fire("tools/execute", globExec)).nextCalls, 0);
    // shell 调用（可能写了文件且不发事件）→ glob 条目不可信
    await ctx.fire("tools/post-execute", { name: "pwsh" }, { content: [] });
    assert.equal((await ctx.fire("tools/execute", globExec)).nextCalls, 1, "shell 调用后 glob 条目应失效");
  });

  test("grep 的 pattern 参数不做路径归一（R1a Issue 2 回归：正则语义不被路径化破坏）", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({}));
    const a = { name: "grep", arguments: { pattern: "a\\db", path: "src" } };
    const b = { name: "grep", arguments: { pattern: "a/db", path: "src" } };
    await ctx.fire("tools/execute", a);
    // b 的 pattern 与 a 语义不同（正则 a\db ≠ a/db），必须各自 miss 而非假命中
    assert.equal((await ctx.fire("tools/execute", b)).nextCalls, 1, "不同正则不应共享缓存键");
    // path 参数仍归一：同文件不同分隔符命中
    const c = { name: "grep", arguments: { pattern: "a\\db", path: "src" } };
    assert.equal((await ctx.fire("tools/execute", c)).nextCalls, 0);
  });

  test("cache=false 时完全不缓存", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({ cache: false }));
    const exec = { name: "read", arguments: { file_path: "y.js" } };
    await ctx.fire("tools/execute", exec);
    assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1);
  });

  test("自定义 readonlyTools 白名单生效", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sched-"));
    const file = join(dir, "z.dat");
    try {
      writeFileSync(file, "data");
      const ctx = makeCtx();
      apply(ctx, cfgOf({ readonlyTools: ["slow_read"] }));
      const exec = { name: "slow_read", arguments: { file_path: file } };
      await ctx.fire("tools/execute", exec);
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缓存按 agent 的 session 工作目录解析相对路径（cwd 边界回归）", async () => {
    // 模拟 dsh：agent 已 cd 到 dirA，而进程 cwd 不同。
    // 同一个相对名 "a.js" 在 dirA 与 dirB 下是两个不同文件，绝不能共享缓存键。
    const dirA = mkdtempSync(join(tmpdir(), "dsh-cwd-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "dsh-cwd-b-"));
    try {
      writeFileSync(join(dirA, "a.js"), "from-A");
      writeFileSync(join(dirB, "a.js"), "from-B-different");
      const ctx = makeCtx();
      const cwdOf = new Map();
      ctx.get = (svc) => (svc === "workingDirectory"
        ? { get: (session) => cwdOf.get(session) ?? process.cwd() }
        : undefined);
      apply(ctx, cfgOf({}));

      const agentA = { session: { id: "sess-A" } };
      const agentB = { session: { id: "sess-B" } };
      cwdOf.set(agentA.session, dirA);
      cwdOf.set(agentB.session, dirB);

      const callA = await ctx.fire("tools/execute", { name: "read", arguments: { file_path: "a.js" }, agent: agentA });
      assert.equal(callA.nextCalls, 1, "首个调用应 dispatch");
      const callA2 = await ctx.fire("tools/execute", { name: "read", arguments: { file_path: "a.js" }, agent: agentA });
      assert.equal(callA2.nextCalls, 0, "同 session 同文件应命中");

      const callB = await ctx.fire("tools/execute", { name: "read", arguments: { file_path: "a.js" }, agent: agentB });
      assert.equal(callB.nextCalls, 1, "不同 session 工作目录下的同名文件必须 miss");
      assert.notEqual(callB.result, callA.result, "不得返回另一目录的内容");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("LRU 上限：条目数不超过 maxEntries，且命中会把条目提为最近使用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lru-"));
    try {
      const files = ["a.js", "b.js", "c.js"];
      for (const f of files) writeFileSync(join(dir, f), f);
      const ctx = makeCtx();
      apply(ctx, cfgOf({ maxEntries: 2, validateStat: false }));
      const execOf = (f) => ({ name: "read", arguments: { file_path: join(dir, f) } });

      await ctx.fire("tools/execute", execOf("a.js"));
      await ctx.fire("tools/execute", execOf("b.js"));
      // 访问 a → a 成为最近使用，b 成为最旧
      assert.equal((await ctx.fire("tools/execute", execOf("a.js"))).nextCalls, 0);
      // 插入 c 触发淘汰：挤出最旧的 b，保留 a
      await ctx.fire("tools/execute", execOf("c.js"));
      assert.equal((await ctx.fire("tools/execute", execOf("a.js"))).nextCalls, 0, "a 被命中提升后不应被淘汰");
      assert.equal((await ctx.fire("tools/execute", execOf("b.js"))).nextCalls, 1, "b 应已被淘汰");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("读取窗口内文件变化时不缓存结果（TOCTOU 回归）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-toctou-"));
    const file = join(dir, "t.js");
    try {
      writeFileSync(file, "v1");
      const ctx = makeCtx();
      const execHandlers = [];
      const rawOn = ctx.on;
      ctx.on = (ev, fn) => { if (ev === "tools/execute") execHandlers.push(fn); else rawOn.call(ctx, ev, fn); };
      apply(ctx, cfgOf({ validateStat: true }));
      const h = execHandlers[0];
      const exec = { name: "read", arguments: { file_path: file } };
      let calls = 0;
      // 第一次 dispatch 期间发生写入（模拟并发行写）：返回值是写入前的内容
      await h(exec, async () => { calls++; writeFileSync(file, "v2-mutated"); return { content: [{ type: "text", text: "v1" }] }; });
      // 若该不稳定结果被缓存，第二次就不会 dispatch —— 断言它必须重新 dispatch
      await h(exec, async () => { calls++; return { content: [{ type: "text", text: "v2-mutated" }] }; });
      assert.equal(calls, 2, "读窗口内变化的结果不应被缓存");
      // 第二次读取窗口内无变化 → 这次应当入缓存
      await h(exec, async () => { calls++; return { content: [{ type: "text", text: "stable" }] }; });
      assert.equal(calls, 2, "稳定读取应命中缓存");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("同一批并发重复读只真实执行一次（在途合并，E2E 发现）", async () => {
    // dsh 把同一批只读调用并行发出：三次 read 同时进入 execute，
    // 此时缓存还没有任何条目（第一个还没执行完）。若不做在途合并，
    // 三个都会真实 dispatch——这正是实测 T2 出现 3 次 miss 的原因。
    const dir = mkdtempSync(join(tmpdir(), "dsh-inflight-"));
    const file = join(dir, "same.js");
    try {
      writeFileSync(file, "content");
      const ctx = makeCtx();
      const execHandlers = [];
      const rawOn = ctx.on;
      ctx.on = (ev, fn) => { if (ev === "tools/execute") execHandlers.push(fn); else rawOn.call(ctx, ev, fn); };
      apply(ctx, cfgOf({}));
      const h = execHandlers[0];
      const exec = { name: "read", arguments: { file_path: file } };

      let dispatches = 0;
      const slowNext = async () => {
        dispatches++;
        await new Promise((r) => setTimeout(r, 15));
        return { content: [{ type: "text", text: "content" }] };
      };
      // 三个并发调用（不 await 中间结果）
      const [a, b, c] = await Promise.all([h(exec, slowNext), h(exec, slowNext), h(exec, slowNext)]);
      assert.equal(dispatches, 1, `并发重复读应只 dispatch 一次，实际 ${dispatches}`);
      assert.deepEqual(a, b, "并发调用应拿到同一份结果");
      assert.deepEqual(b, c);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("推测预取", () => {
  test("speculate=false 时不预取", async () => {
    const ctx = makeCtx();
    let launched = 0;
    ctx.tools.execute = async () => { launched++; return { content: [] }; };
    apply(ctx, cfgOf({ speculate: false }));
    await ctx.fire("tools/post-execute", { name: "glob" }, { files: ["bench/a.js"] });
    assert.equal(launched, 0);
  });

  test("speculate=true 时对 glob 结果发起同族预取", async () => {
    const ctx = makeCtx();
    const launchedTools = [];
    ctx.tools.execute = async ({ name }) => { launchedTools.push(name); return { content: [{ type: "text", text: "x" }] }; };
    apply(ctx, cfgOf({ speculate: true, prefetchN: 2 }));
    await ctx.fire("tools/post-execute", { name: "glob" }, { files: ["bench/a.js", "bench/b.js", "bench/c.js"] });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(launchedTools.length <= 2, `prefetchN 上限未生效: ${launchedTools.length}`);
    assert.ok(launchedTools.every((t) => t === "read"));
  });

  test("speculateRootPrefix 阻止范围外预取", async () => {
    const ctx = makeCtx();
    const launched = [];
    ctx.tools.execute = async ({ arguments: a }) => { launched.push(a.file_path); return { content: [] }; };
    apply(ctx, cfgOf({ speculate: true, speculateRootPrefix: "bench/fixture/" }));
    await ctx.fire("tools/post-execute", { name: "glob" }, { files: ["node_modules/x.js", "bench/fixture/ok.js"] });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(launched, ["bench/fixture/ok.js"]);
  });
});
