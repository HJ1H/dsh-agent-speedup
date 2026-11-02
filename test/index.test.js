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
    const ctx = makeCtx();
    apply(ctx, cfgOf({}));
    const exec = { name: "read", arguments: { file_path: "x.js" } };
    assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1);
    assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0, "第二次应命中缓存");
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
      await ctx.fire("fs/write-intent", { targetKey: file });
      assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1, "写意图后应失效");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache=false 时完全不缓存", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({ cache: false }));
    const exec = { name: "read", arguments: { file_path: "y.js" } };
    await ctx.fire("tools/execute", exec);
    assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 1);
  });

  test("自定义 readonlyTools 白名单生效", async () => {
    const ctx = makeCtx();
    apply(ctx, cfgOf({ readonlyTools: ["slow_read"] }));
    const exec = { name: "slow_read", arguments: { file_path: "z.js" } };
    await ctx.fire("tools/execute", exec);
    assert.equal((await ctx.fire("tools/execute", exec)).nextCalls, 0);
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
