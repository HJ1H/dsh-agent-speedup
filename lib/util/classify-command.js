// 只读命令分类器：判断一条 shell 命令是否有副作用
// 保守优先：拿不准时返回 false（当作有副作用，串行执行）

/** 明确只读的命令/子命令（前缀匹配） */
const READONLY_PREFIXES = [
  // POSIX
  "ls", "cat", "head", "tail", "stat", "wc", "pwd", "echo", "which", "whereis",
  "file", "du", "df", "tree", "realpath", "basename", "dirname", "date", "uname",
  "grep", "rg", "ag", "ack", "find", "fd", "locate",
  "git log", "git status", "git diff", "git show", "git branch", "git remote",
  "git ls-files", "git rev-parse", "git describe", "git blame", "git tag -l",
  "npm ls", "npm list", "npm view", "npm info", "npm outdated",
  "node --version", "node -v", "python --version", "go version", "cargo --version",
  "docker ps", "docker images", "docker inspect", "kubectl get", "kubectl describe",
  // PowerShell
  "get-childitem", "get-location", "get-content", "get-item", "get-itemproperty",
  "select-string", "measure-object", "test-path", "resolve-path", "get-command",
  "write-output", "write-host", "get-process", "get-service", "get-date",
  // 纯只读的管道筛选器（PowerShell 惯用）
  "select-object", "where-object", "sort-object", "group-object", "format-table",
  "format-list", "convertto-json", "convertfrom-json", "out-string", "foreach-object",
];

/** 出现即判定为有副作用的模式（优先级最高） */
const WRITE_PATTERNS = [
  /\s>\s*\S/,            // 输出重定向
  /\s>>\s*\S/,           // 追加重定向
  /\b(rm|rmdir|del|erase|mv|move|cp|copy|install|uninstall)\b/i,
  /\b(mkdir|md|touch|new-item|set-content|add-content|out-file)\b/i,
  /\b(sed\s+-i|tee|truncate|chmod|chown|chgrp)\b/i,
  /\b(npm (install|i|uninstall|update|ci)|pnpm (add|install|remove)|yarn (add|install)|pip install|cargo install|go install)\b/i,
  /\b(git (commit|push|pull|merge|rebase|reset|checkout|switch|stash|clean|add|clone|init))\b/i,
  /\b(docker (run|build|rm|rmi|stop|kill|pull|push)|kubectl (apply|delete|create|patch|scale))\b/i,
  /\b(api|curl|wget|invoke-webrequest|invoke-restmethod)\b/i,
  /\b(remove-item|start-process|stop-process|kill|taskkill|shutdown|reboot)\b/i,
  /\b(eval|exec|source\s+\S|\.\s+\S+\.(sh|ps1))\b/i,
];

/** 命令分隔符：任一段有副作用即整体有副作用 */
const SEGMENT_SPLIT = /\s*(?:;|&&|\|\||\||\n)\s*/;

/**
 * @param {string} command 完整命令行
 * @returns {{readonly: boolean, reason: string}}
 */
export function classifyCommand(command) {
  const raw = String(command ?? "").trim();
  if (!raw) return { readonly: false, reason: "empty" };
  // 有副作用特征 → 立即判 false
  for (const p of WRITE_PATTERNS) {
    if (p.test(raw)) return { readonly: false, reason: `write-pattern ${p.source.slice(0, 30)}` };
  }
  // 拆分后每一段都必须是只读命令
  const segs = raw.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return { readonly: false, reason: "no-segment" };
  for (const seg of segs) {
    const lower = seg.toLowerCase();
    // 忽略变量赋值前缀 FOO=bar cmd
    const cmdPart = lower.replace(/^[a-z_][a-z0-9_]*=\S*\s+/g, "");
    const ok = READONLY_PREFIXES.some((p) => cmdPart === p || cmdPart.startsWith(p + " ") || cmdPart.startsWith(p + "|"));
    if (!ok) return { readonly: false, reason: `not-whitelisted: ${seg.slice(0, 40)}` };
  }
  return { readonly: true, reason: "all-segments-readonly" };
}
