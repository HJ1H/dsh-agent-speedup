// 分类器测试：只读判定必须保守，任何误判为只读的命令都可能造成数据损坏
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../lib/util/classify-command.js";

describe("必须判定为只读", () => {
  const readonly = [
    "ls",
    "ls -la",
    "cat foo.txt",
    "grep -rn TODO src/",
    "rg pattern",
    "find . -name '*.js'",
    "head -20 file.txt",
    "wc -l file.txt",
    "pwd",
    "echo hello",
    "git log --oneline",
    "git status",
    "git diff HEAD~1",
    "git branch -a",
    "npm ls",
    "docker ps",
    "Get-ChildItem",
    "Get-Content foo.txt",
    "Get-Location",
    "Select-String -Pattern foo",
    "ls && pwd",
    "cat a.txt | grep foo",
    "git log | head -5",
  ];
  for (const c of readonly) {
    test(c, () => assert.equal(classifyCommand(c).readonly, true, classifyCommand(c).reason));
  }
});

describe("必须判定为有副作用", () => {
  const write = [
    "rm -rf /",
    "mv a b",
    "cp a b",
    "echo hi > out.txt",
    "cat foo >> log.txt",
    "sed -i 's/a/b/' f.txt",
    "npm install",
    "npm ci",
    "pip install requests",
    "git commit -m 'x'",
    "git push",
    "git checkout main",
    "git add .",
    "docker build -t x .",
    "kubectl apply -f x.yaml",
    "mkdir newdir",
    "touch f.txt",
    "chmod +x run.sh",
    "curl https://example.com",
    "wget https://example.com/f",
    "Set-Content -Path a -Value b",
    "New-Item -Name x",
    "Remove-Item x",
    "Start-Process calc",
    "taskkill /F /PID 123",
    "ls && rm -rf build",
    "cat foo.txt > bar.txt",
    "unknowncommand --flag",
    "python script.py",
    "node build.js",
    "make",
    "cargo build",
    "npm test",
  ];
  for (const c of write) {
    test(c, () => assert.equal(classifyCommand(c).readonly, false, `误判为只读: ${c}`));
  }
});

describe("边界", () => {
  test("空命令", () => assert.equal(classifyCommand("").readonly, false));
  test("null", () => assert.equal(classifyCommand(null).readonly, false));
  test("环境变量赋值前缀一律拒绝（GIT_EXTERNAL_DIFF 等是代码执行向量）", () => {
    assert.equal(classifyCommand("FOO=1 ls").readonly, false, "赋值前缀不可静态证明无害");
    assert.equal(classifyCommand("FOO=1 rm x").readonly, false);
    assert.equal(classifyCommand("GIT_EXTERNAL_DIFF=./pwn git diff").readonly, false);
    assert.equal(classifyCommand("LD_PRELOAD=/tmp/x.so ls").readonly, false);
  });
  test("管道到未知命令视为不安全", () => {
    assert.equal(classifyCommand("cat a | python -c 'print(1)'").readonly, false);
  });
});

// R2 攻击者视角审查：前缀白名单粒度太粗导致的一类真实逃逸。
// 这些命令都能写文件或改仓库状态，却曾与只读形态共享同一前缀。
describe("R2 子命令逃逸（必须判有副作用）", () => {
  const writes = [
    // git branch：列举只读，带位置参数/-d/-m 会创建、删除、改名分支
    "git branch newbranch",
    "git branch -D main",
    "git branch -m old new",
    "git branch --set-upstream-to=origin/main feat",
    // git remote：列举只读，add/remove/set-url 改 .git/config
    "git remote add origin https://x",
    "git remote remove origin",
    "git remote set-url origin https://y",
    "git remote prune origin",
    // git tag：仅 -l 只读，位置参数会创建 tag
    "git tag v1.0.0",
    "git tag -a v1 -m x",
    // git 通用写选项
    "git log --output=evil.txt",
    "git show --output=evil.txt HEAD",
    "git diff --output=evil.txt",
    "git diff --no-index /dev/null out.txt",
    // find 的写动作选项
    "find . -name x -fprint out.txt",
    "find . -name x -fprintf out.txt %p",
    "find . -name x -fls out.txt",
    "find . -name x -ok rm {} \\;",
    // fd 的执行选项
    "fd -x rm {}",
    "fd --exec rm",
    // PowerShell 输出变量仍会写入会话/脚本作用域
    "Get-Content x -OutVariable y",
    // 无空格重定向（曾因正则要求前导空格而漏判）
    "echo hi>out.txt",
    "cat a>>log.txt",
    "ls>out.txt",
    // 命令替换 / 变量展开 / 转义元字符（执行期才展开，静态无法证明只读）
    "ls ${CMD}",
    "cat a\\;rm\\ x",
    "echo $(whoami)",
    "echo `whoami`",
    // ---- R2 独立攻击者审查新增 ----
    // 单个 & 是后台执行，后续命令曾被粘进同一段
    "ls & bash pwn.sh",
    "ls & git branch -D ampvictim",
    // 环境变量赋值前缀 = 代码执行向量
    "GIT_EXTERNAL_DIFF=./pwn.sh git diff",
    "LD_PRELOAD=/tmp/x.so ls",
    // PowerShell 脚本块里可执行任意命令（含别名）
    "Get-ChildItem | Where-Object { ni pwn.txt }",
    "Get-ChildItem | Where-Object { [Environment]::SetEnvironmentVariable('PWN','1','User') }",
    "Get-ChildItem | ForEach-Object { rm $_ }",
    // 看起来只读但带写选项
    "file -C -m magicfile",
    "tree -o out.txt",
    "date -s '2020-01-01'",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "rg --pre ./pwn foo",
  ];
  for (const c of writes) {
    test(c, () => assert.equal(classifyCommand(c).readonly, false, `逃逸为只读: ${c}`));
  }
});

describe("R2 修复后只读形态仍然放行", () => {
  const reads = [
    "git branch",
    "git branch -a",
    "git branch --list",
    "git branch -vv",
    "git remote",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git tag",
    "git tag -l",
    "git log --oneline",
    "find . -name '*.js'",
    "find . -name '*.js' -print",
    "fd pattern src/",
    // 引号内的符号是数据，不是重定向
    'grep ">" f.txt',
    "grep '>' f.txt",
    "grep 'a\\|b' f.txt",
    // 筛选类 cmdlet 无脚本块时安全（曾因白名单缺失被误拒，导致并发判定失效）
    "Select-Object -First 3",
    "Get-Process | Select-Object -First 3",
    "Get-ChildItem | Select-Object Name",
    "Sort-Object Name",
    "Measure-Object",
    "Where-Object Name -eq x",
  ];
  for (const c of reads) {
    test(c, () => assert.equal(classifyCommand(c).readonly, true, `误拒只读: ${c} (${classifyCommand(c).reason})`));
  }
});
