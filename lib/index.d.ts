import type { z } from "zod";

/** Cordis 插件标识 */
export declare const name: "agent-speedup";
/** 依赖的宿主服务 */
export declare const inject: readonly ["tools"];

/** 插件配置 schema */
export declare const Config: z.ZodObject<{
  cache: z.ZodDefault<z.ZodBoolean>;
  readonlyTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
  validateStat: z.ZodDefault<z.ZodBoolean>;
  maxEntries: z.ZodDefault<z.ZodNumber>;
  speculate: z.ZodDefault<z.ZodBoolean>;
  speculateOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
  prefetchN: z.ZodDefault<z.ZodNumber>;
  speculateRootPrefix: z.ZodDefault<z.ZodString>;
  shellConcurrency: z.ZodDefault<z.ZodBoolean>;
  shellTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
  debugLogFile: z.ZodOptional<z.ZodString>;
}>;

export type SchedulerConfig = z.infer<typeof Config>;

/** Cordis 插件入口 */
export declare function apply(ctx: unknown, config: SchedulerConfig): void;

/** 纯函数（导出以便单测） */
export declare function normPath(value: unknown): string;
export declare function keyOf(
  tool: string,
  args: Record<string, unknown> | undefined,
  base?: string,
): string;
export declare function pathsFromResult(result: unknown, filter?: string): string[];
