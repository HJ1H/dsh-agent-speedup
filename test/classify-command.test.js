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
    "Get-ChildItem -Force | Select-Object Name",
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
  test("变量赋值前缀仍按命令判断", () => {
    assert.equal(classifyCommand("FOO=1 ls").readonly, true);
    assert.equal(classifyCommand("FOO=1 rm x").readonly, false);
  });
  test("管道到未知命令视为不安全", () => {
    assert.equal(classifyCommand("cat a | python -c 'print(1)'").readonly, false);
  });
});
