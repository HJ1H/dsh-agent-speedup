// 只读命令分类器：判断一条 shell 命令是否有副作用
// 保守优先：拿不准时返回 false（当作有副作用，串行执行）
//
// 设计（0.2.2 起）：从「前缀白名单」升级为「子命令 + 参数级白名单」。
// 前缀白名单的致命缺陷是粒度太粗：`git branch`（列举，只读）与
// `git branch newbranch`（创建，写入）共享同一前缀；`git remote`（列举）与
// `git remote add`（改配置）同理。因此对带子命令的工具改为：
//   1. 解析出动词（第 1 个非选项参数）
//   2. 动词必须在只读动词表内
//   3. 参数中不得出现该工具已知的写文件/改状态选项
// 其余工具仍走简单前缀白名单 + 全局写模式。

/** 纯只读管道筛选器：只接受可枚举的安全参数（含脚本块的 cmdlet 一律不放行） */
const PIPE_FILTERS = new Set(["sort", "uniq", "tr", "cut", "rev", "nl", "column"]);

/** 简单前缀白名单：命令本身（不含子动词语义）即只读 */
const READONLY_PREFIXES = [
  // POSIX 读取
  "ls", "cat", "head", "tail", "stat", "wc", "pwd", "echo", "which", "whereis",
  "file", "du", "df", "tree", "realpath", "basename", "dirname", "date", "uname",
  "grep", "rg", "ag", "ack", "locate", "printenv", "id", "whoami", "hostname",
  // 版本查询
  "node --version", "node -v", "python --version", "go version", "cargo --version",
  "docker ps", "docker images", "docker inspect",
  // PowerShell 读取（Where/Sort/Group/Measure 带 ScriptBlock 时可执行任意命令，
  // 由 SCRIPTBLOCK_SAFE_CMDLETS 里逐参数校验；这里只列绝对安全的）
  "get-childitem", "get-location", "get-content", "get-item", "get-itemproperty",
  "select-string", "test-path", "resolve-path", "get-command",
  "write-output", "write-host", "get-process", "get-service", "get-date", "get-help",
  // 纯只读输出整形
  "format-table", "format-list", "convertto-json", "convertfrom-json", "out-string",
];

/**
 * 允许出现、但必须逐参数校验的筛选类 cmdlet。
 * 它们接受 `-Property @{...}` 之类的计算属性块，或 `{ ... }` 脚本块，
 * 块内可以执行任意命令；因此只有在参数里不含 `{` 时才放行。
 * 例：`Select-Object -First 3`、`Select-Object Name` 安全；
 *     `Select-Object @{n='x';e={Remove-Item y}}` 不是。
 */
const SCRIPTBLOCK_SAFE_CMDLETS = new Set([
  "select-object", "where-object", "sort-object", "group-object", "measure-object",
  "foreach-object", "select-string",
]);

/** 带子命令的工具：动词白名单 + 写选项黑名单 */
const SUBCOMMAND_RULES = {
  git: {
    // 只读动词（含其中的只读二级动词）
    readonly: new Set([
      "log", "status", "diff", "show", "blame", "describe", "rev-parse",
      "ls-files", "ls-tree", "ls-remote", "merge-base", "shortlog",
      "whatchanged", "grep", "cat-file", "name-rev", "count-objects",
    ]),
    // 部分动词只有特定形态只读，需要二级判断
    conditional: {
      branch: (args) => onlyReadonlyBranch(args),
      tag: (args) => onlyReadonlyTag(args),
      remote: (args) => onlyReadonlyRemote(args),
    },
    // 任何动词都不允许出现的写选项（会写文件或改状态）
    forbiddenArgs: [
      /^(?:--output|--out|--no-index)(?:=.*)?$/,  // 写文件 / 双路径 diff
      /^--exec(?:=.*)?$/,
      /^-o$/,                                     // 待确认：某些子命令的 -o 是输出文件
    ],
  },
  find: {
    readonly: new Set([]), // find 无动词，靠参数判断
    anyArgs: true,
    forbiddenArgs: [
      /^-(?:fprint|fprint0|fprintf|fls|delete|exec|execdir|ok|okdir)(?:$|=.*)?/,
    ],
  },
  fd: {
    readonly: new Set([]),
    anyArgs: true,
    forbiddenArgs: [
      /^(?:-x|--exec|-X|--exec-batch|-l|--list-file)(?:$|=.*)?/,
    ],
  },
  docker: {
    readonly: new Set(["ps", "images", "inspect", "logs", "version", "info", "stats", "top"]),
    forbiddenArgs: [],
  },
  kubectl: {
    readonly: new Set(["get", "describe", "logs", "version", "api-resources", "explain"]),
    forbiddenArgs: [],
  },
  npm: {
    readonly: new Set(["ls", "list", "view", "info", "outdated", "root", "prefix", "explain"]),
    forbiddenArgs: [],
  },
  pnpm: {
    readonly: new Set(["ls", "list", "view"]),
    forbiddenArgs: [],
  },
  yarn: {
    readonly: new Set(["list", "info"]),
    forbiddenArgs: [],
  },
};

/** git branch 只读形态：无参数、或仅含列举类选项 */
function onlyReadonlyBranch(args) {
  const LIST_FLAGS = new Set(["-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty"]);
  for (const a of args) {
    if (a.startsWith("-")) {
      const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!LIST_FLAGS.has(flag)) return { ok: false, reason: `git branch 选项可能写入: ${a}` };
      continue;
    }
    // 非选项参数 = 分支名 → 创建/重命名分支
    return { ok: false, reason: `git branch 带位置参数会创建/改名分支: ${a}` };
  }
  return { ok: true };
}

/** git tag 只读形态：仅列举 */
function onlyReadonlyTag(args) {
  const LIST_FLAGS = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--format", "--column", "--no-column", "-i", "--ignore-case", "-v", "--verify"]);
  let sawList = false;
  for (const a of args) {
    if (a.startsWith("-")) {
      const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!LIST_FLAGS.has(flag)) return { ok: false, reason: `git tag 选项可能写入: ${a}` };
      if (flag === "-l" || flag === "--list") sawList = true;
      continue;
    }
    // 位置参数：只有配合 -l 才是模式匹配，否则是创建 tag
    if (!sawList) return { ok: false, reason: `git tag 位置参数会创建 tag: ${a}` };
  }
  return { ok: true };
}

/** git remote 只读形态：无参数或仅列举 / show / get-url */
function onlyReadonlyRemote(args) {
  const LIST_FLAGS = new Set(["-v", "--verbose"]);
  let readVerb = false;
  for (const a of args) {
    if (a.startsWith("-")) {
      const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!LIST_FLAGS.has(flag)) return { ok: false, reason: `git remote 选项: ${a}` };
      continue;
    }
    // 动词：show / get-url 只读，其后的位置参数（如 remote 名）无关紧要
    if (!readVerb && (a === "show" || a === "get-url")) { readVerb = true; continue; }
    if (readVerb) continue; // show/get-url 的远程名参数
    // add/remove/set-url/prune/update/rename 等都会改配置
    return { ok: false, reason: `git remote 子命令会改配置: ${a}` };
  }
  return { ok: true };
}

/** 出现即判定为有副作用的模式（跨所有命令） */
const WRITE_PATTERNS = [
  // 重定向：不要求前导空格（`echo hi>out.txt` 同样会写文件），但排除 `>&2`
  // 这类只把流接到另一个流的形态之外的写入。
  /(?:^|[^0-9&])>>?(?!&)\s*\S/,  // > file / >> file（含无空格写法）
  /\s\d>>?\s*\S/,                 // 2>err.log / 2>>err.log
  /\s>>?\|\s*\S/,                 // >| file（强制覆盖）
  /\b(rm|rmdir|del|erase|mv|move|cp|copy|install|uninstall)\b/i,
  /\b(mkdir|md|touch|new-item|set-content|add-content|out-file|export-csv|export-clixml)\b/i,
  /\b(sed\s+-i|tee|truncate|chmod|chown|chgrp|ln)\b/i,
  /\b(npm (install|i|uninstall|update|ci)|pnpm (add|install|remove)|yarn (add|install)|pip install|cargo install|go install)\b/i,
  /\b(git (commit|push|pull|merge|rebase|reset|checkout|switch|stash|clean|add|clone|init))\b/i,
  /\b(docker (run|build|rm|rmi|stop|kill|pull|push)|kubectl (apply|delete|create|patch|scale|edit|replace))\b/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod)\b/i,
  /\b(remove-item|start-process|stop-process|stop-service|restart-service|kill|taskkill|shutdown|reboot)\b/i,
  /\b(eval|exec|source\s+\S|\.\s+\S+\.(sh|ps1))\b/i,
  // PowerShell 写变量/别名/函数定义
  /\b(set-variable|new-variable|set-alias|new-alias|set-itemproperty|rename-item|copy-item|move-item)\b/i,
  // .NET 静态调用与表达式执行
  /::(WriteAllText|WriteAllBytes|AppendAllText|Create|Delete|Move|Copy)\(/i,
  /\b(Invoke-Expression|iex)\b/i,
];

/** 命令分隔符：任一段有副作用即整体有副作用 */
const SEGMENT_SPLIT = /\s*(?:;|&&|\|\||\||\n)\s*/;

/** 按分隔符切段，但跳过引号内的分隔符（`grep 'a\|b'` 是一个命令，不是管道）。 */
function splitSegments(raw) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    // 两字符分隔符优先
    if ((ch === "&" && raw[i + 1] === "&") || (ch === "|" && raw[i + 1] === "|")) {
      segs.push(cur); cur = ""; i += 1; continue;
    }
    // `>&` / `&>` 是重定向运算符，交给写模式检测，不当作分隔符
    if (ch === "&" && (raw[i + 1] === ">" || (i > 0 && raw[i - 1] === ">"))) {
      cur += ch; continue;
    }
    // 单个 `&` 是后台执行：后续命令与前面并行且不受其失败影响，必须切开分别判定
    if (ch === "&" || ch === ";" || ch === "|" || ch === "\n") {
      segs.push(cur); cur = ""; continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

/** 把一段命令拆成 token（保留引号内的空格），用于参数级判断 */
function tokenize(segment) {
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 把引号内内容替换为占位符，供写模式检测使用。
 * shell 不会把引号内的 `>` 当重定向，所以检测前必须先屏蔽；
 * 但引号内若是真的危险命令（如 `sh -c "rm x"`），命令名本身仍在引号外，
 * 且未知命令一律拒绝——屏蔽只影响"引号内数据"的误判。
 */
function maskQuoted(text) {
  let out = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) { quote = null; out += ch; }
      else out += "\u0000";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * @param {string} command 完整命令行
 * @returns {{readonly: boolean, reason: string}}
 */
export function classifyCommand(command) {
  const raw = String(command ?? "").trim();
  if (!raw) return { readonly: false, reason: "empty" };

  // 全局写模式优先：命中即拒绝。在「引号内容已屏蔽」的副本上检测，
  // 避免把 `grep ">" f` 这类数据里的符号当成重定向。
  const probe = maskQuoted(raw);
  for (const p of WRITE_PATTERNS) {
    if (p.test(probe)) return { readonly: false, reason: `write-pattern ${p.source.slice(0, 40)}` };
  }

  // 命令替换会在执行时运行任意命令：`$(...)` / 反引号 / 花括号变量展开 一律拒绝。
  // 它们在引号内同样生效，所以用原始文本检测。
  if (/\$\(|`/.test(raw)) return { readonly: false, reason: "command-substitution" };
  // `${VAR}` 作命令名或参数时可能展开成任意命令/路径，保守拒绝。
  if (/\$\{/.test(raw)) return { readonly: false, reason: "variable-expansion" };
  // 反斜杠转义可能掩盖分隔符/重定向（`a\;rm x`）。只在引号外检测：
  // 引号内的反斜杠多数是字面量（`grep 'a\|b'` 是合法正则）。
  if (/\\[;|&<>`$"'\\]/.test(probe)) return { readonly: false, reason: "escaped-metachar" };

  const segs = splitSegments(raw).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return { readonly: false, reason: "no-segment" };

  for (const seg of segs) {
    const verdict = classifySegment(seg);
    if (!verdict.readonly) return verdict;
  }
  return { readonly: true, reason: "all-segments-readonly" };
}

/** 单段命令判定 */
function classifySegment(seg) {
  const lower = seg.toLowerCase();
  // 变量赋值前缀是代码执行向量（GIT_EXTERNAL_DIFF / GIT_PAGER / LD_PRELOAD /
  // NODE_OPTIONS / BASH_ENV 都能让"只读命令"执行任意程序）。
  // 静态无法证明赋值无害 → 一律拒绝，不做剥离。
  if (/^[a-z_][a-z0-9_]*=/.test(lower)) return { readonly: false, reason: "env-assignment-prefix" };

  // 脚本块 `{ ... }` / `@{ ... }` 内含任意命令（PowerShell 的
  // Where-Object/Sort-Object/ForEach-Object 都会执行它），静态无法证明只读。
  // 注意：这段必须在白名单判断之前——`Select-Object @{n='x';e={...}}` 的
  // 危险部分全在花括号里，先 tokenize 再判会漏掉。
  if (/[@{]\s*[^}]*[}]/.test(seg) || /\{[^}]*\}/.test(seg)) {
    return { readonly: false, reason: "script-block" };
  }

  const tokens = tokenize(lower);
  if (!tokens.length) return { readonly: false, reason: "no-token" };
  const head = tokens[0];
  const rest = tokens.slice(1);

  // 纯只读管道筛选器：默认拒绝带未知参数的形式（sort -o / uniq in out 都会写文件）
  if (PIPE_FILTERS.has(head)) {
    if (head === "sort" && rest.some((a) => a === "-o" || a.startsWith("--output"))) {
      return { readonly: false, reason: "sort 写文件" };
    }
    if (head === "sort" && rest.some((a) => a.startsWith("--compress-program"))) {
      return { readonly: false, reason: "sort --compress-program 执行程序" };
    }
    if (head === "uniq") {
      const positional = rest.filter((a) => !a.startsWith("-"));
      if (positional.length >= 2) return { readonly: false, reason: "uniq 输出文件参数" };
    }
    return { readonly: true, reason: `${head} 管道筛选器` };
  }

  const rule = SUBCOMMAND_RULES[head];
  if (rule !== undefined) {
    // 带子命令的工具：分类别的动词白名单
    const verb = rest.find((t) => !t.startsWith("-"));
    if (verb === undefined) {
      // 无动词：只有 git 这类"裸调用"才有意义，且必须是列举
      if (head === "git") return { readonly: false, reason: "git 无子命令" };
      // find/fd 无动词是合法的（靠参数判断）
    }
    // 先查禁用参数（对任何动词都生效）
    for (const a of rest) {
      for (const pat of rule.forbiddenArgs ?? []) {
        if (pat.test(a)) return { readonly: false, reason: `${head} 写选项: ${a}` };
      }
    }
    if (rule.conditional && verb && rule.conditional[verb]) {
      const verdict = rule.conditional[verb](rest.filter((t) => t !== verb));
      if (!verdict.ok) return { readonly: false, reason: verdict.reason };
      return { readonly: true, reason: `${head} ${verb} 只读形态` };
    }
    if (rule.readonly !== undefined && rule.readonly.size > 0) {
      if (verb === undefined) return { readonly: false, reason: `${head} 缺少只读子命令` };
      if (!rule.readonly.has(verb)) return { readonly: false, reason: `${head} ${verb} 不在只读动词表` };
      return { readonly: true, reason: `${head} ${verb}` };
    }
    // anyArgs 规则（find/fd）：参数已过黑名单，动词视作查找模式
    return { readonly: true, reason: `${head} 参数已校验` };
  }

  // 筛选类 cmdlet：脚本块已在上面被拒绝，这里的参数是纯标识符/-First 等，安全。
  // 仍需挡住会写变量的 -OutVariable。
  if (SCRIPTBLOCK_SAFE_CMDLETS.has(head)) {
    const bad = rest.find((a) => /^-o(v|utvariable|utfile)?$/i.test(a) || /^-out(file|variable)?$/i.test(a));
    if (bad) return { readonly: false, reason: `${head} 写变量/文件: ${bad}` };
    return { readonly: true, reason: `${head} 筛选（无脚本块）` };
  }

  // 简单前缀白名单（用 tokens 拼回，避免被引号/空格变体绕过）
  const ok = READONLY_PREFIXES.some((p) => {
    const pHead = p.split(" ")[0];
    if (pHead !== head) return false;
    // 白名单项本身含参数（如 "git log"、"node -v"）：前缀也要匹配
    return tokens.join(" ").startsWith(p);
  });
  if (!ok) return { readonly: false, reason: `not-whitelisted: ${seg.slice(0, 40)}` };

  // 即使前缀匹配，也检查该命令已知的写选项
  const writeFlag = findWriteFlag(head, tokens.slice(1));
  if (writeFlag) return { readonly: false, reason: `${head} 写选项: ${writeFlag}` };
  return { readonly: true, reason: `${head} 只读` };
}

/** 前缀白名单命令的写选项黑名单（参数级） */
const PER_COMMAND_WRITE_FLAGS = {
  sort: new Set(["-o", "--output", "--compress-program"]),
  uniq: new Set(), // uniq 的第二个位置参数就是输出文件，由下方单独判定
  grep: new Set(["--exclude-from"]), // 其余只读
  rg: new Set(["--pre", "--hostname-bin"]), // --pre 执行任意程序
  // file -C 会编译 magic 文件并写 <name>.mgc
  file: new Set(["-c", "-compile", "--compile"]),
  // tree -o 输出到文件；--fromfile 读文件（不写但要读额外路径，保守拒绝）
  tree: new Set(["-o", "--output"]),
  // date -s / --set 修改系统时间
  date: new Set(["-s", "--set"]),
  // ls 无写选项，但 --quoting-style 等无副作用；保持空
  "get-content": new Set(["-outvariable", "-ov", "-outfile"]),
  "get-childitem": new Set(["-outvariable", "-ov"]),
  "get-item": new Set(["-outvariable", "-ov"]),
  "get-process": new Set(["-outvariable", "-ov"]),
  "get-service": new Set(["-outvariable", "-ov"]),
  "get-date": new Set(["-outvariable", "-ov"]),
  "select-string": new Set(["-outvariable", "-ov"]),
  "test-path": new Set(["-outvariable", "-ov"]),
  "get-command": new Set(["-outvariable", "-ov"]),
  "resolve-path": new Set(["-outvariable", "-ov"]),
};

function findWriteFlag(head, args) {
  const flags = PER_COMMAND_WRITE_FLAGS[head];
  if (!flags) return undefined;
  for (const a of args) {
    const bare = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (flags.has(bare.toLowerCase())) return a;
  }
  // uniq 的特殊形态：uniq INPUT OUTPUT
  if (head === "uniq") {
    const positional = args.filter((a) => !a.startsWith("-"));
    if (positional.length >= 2) return `位置参数输出文件 ${positional[1]}`;
  }
  return undefined;
}
