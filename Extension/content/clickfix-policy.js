// Shared ClickFix policy.
//
// This file deliberately supports both environments in which it runs:
// - as a classic content script, where it exposes an immutable isolated-world
//   global; and
// - as a CommonJS dependency of the bundled MV3 service worker.
//
// Keep this module free of DOM and Chrome APIs so the content mediator can
// share its inspection limit while the service worker performs the
// authoritative classification.
(function attachClickfixPolicy(root, factory) {
  const policy = Object.freeze(factory());
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = policy;
  }
  if (root !== null && typeof root === "object") {
    Object.defineProperty(root, "YodelClickfixPolicy", {
      value: policy,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
})(typeof globalThis === "object" ? globalThis : null, function createClickfixPolicy() {
  const MAX_COPY_TEXT_LENGTH = 65_536;

  // Single source of truth for protected command names (issue #79). Command-
  // position matching, canonical-tool evidence, and proxy argument checks
  // all derive from this set; there is intentionally no parallel regex to
  // drift out of sync. Executable coverage beyond this list comes from the
  // shape rules below, not from growing this into a LOLBin catalogue.
  const PROTECTED_COMMAND_NAMES = new Set([
    // Windows shells, script hosts, and administrative tools
    "powershell", "powershell_ise", "pwsh", "cmd", "mshta", "wscript",
    "cscript", "wmic", "rundll32", "regsvr32", "certutil", "bitsadmin",
    "msiexec", "schtasks",
    // command-executing proxies and launchers
    "forfiles", "runas", "conhost", "pcalua", "wt", "wsl",
    // download tools
    "curl", "wget",
    // POSIX shells and scriptable interpreters
    "bash", "sh", "zsh", "ksh", "dash", "fish", "osascript",
    "python", "python2", "python3", "py", "perl", "ruby", "node", "php",
    // PowerShell execution/download cmdlets and their aliases
    "iex", "invoke-expression", "iwr", "invoke-webrequest", "irm",
    "invoke-restmethod", "start-bitstransfer", "start-process",
    "invoke-command", "start-job", "saps", "icm", "sajb",
    // explicit string/file evaluators
    "eval", "source", ".",
  ]);
  const POWERSHELL_COMMAND_NAMES = new Set(["powershell", "pwsh", "powershell_ise"]);
  // Commands whose argument itself is executable/fetched content. Warning
  // still requires an argument-shaped residue so prose remains quiet.
  const DIRECT_EXECUTION_COMMAND_NAMES = new Set([
    "iex", "invoke-expression", "iwr", "invoke-webrequest", "irm",
    "invoke-restmethod", "start-bitstransfer", "start-process",
    "invoke-command", "start-job", "saps", "icm", "sajb", "eval", "source", ".",
  ]);
  const PROXY_COMMAND_NAMES = new Set(["forfiles", "runas", "conhost", "wt", "wsl", "pcalua"]);
  const WT_SUBCOMMAND_NAMES = new Set(["new-tab", "nt", "split-pane", "sp"]);
  const PROXY_OPTIONS_WITH_VALUES = {
    wsl: new Set(["-d", "--distribution", "-u", "--user", "--cd"]),
    wt: new Set(["-d", "--startingdirectory", "-p", "--profile", "-w", "--window"]),
    conhost: new Set(["--width", "--height", "--signal", "--server"]),
  };
  const POSIX_SHELL_COMMAND_NAMES = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish"]);
  const INTERPRETER_COMMAND_NAMES = new Set([
    "python", "python2", "python3", "py", "perl", "ruby", "node", "php", "osascript",
  ]);
  const PIPE_INPUT_COMMAND_NAMES = new Set([
    ...POWERSHELL_COMMAND_NAMES, ...POSIX_SHELL_COMMAND_NAMES,
    ...INTERPRETER_COMMAND_NAMES, "cmd", "iex", "invoke-expression",
  ]);
  const COMMAND_WRAPPERS = new Set([
    "sudo", "doas", "env", "nohup", "command", "exec",
    "time", "nice", "!", "then", "do", "else",
  ]);
  const MAX_WRAPPER_DEPTH = 8;
  const MAX_WRAPPER_OPTIONS = 8;
  const MAX_COMMAND_STARTS = 64;
  const PARSER_LIMIT = Symbol("clickfix-parser-limit");
  const PARSER_LIMIT_TOOL = "unverified wrapped command";
  const WRAPPER_OPTIONS_WITH_VALUES = {
    sudo: new Set([
      "-u", "-g", "-h", "-p", "-c", "-t", "-r", "-C", "-D", "-R", "-T",
      "--user", "--group", "--host", "--prompt", "--close-from", "--chdir",
      "--role", "--type",
    ]),
    doas: new Set(["-u", "-C"]),
    env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
    nohup: new Set(),
    command: new Set(),
    exec: new Set(["-a"]),
    time: new Set(["-f", "-o", "--format", "--output"]),
    nice: new Set(["-n", "--adjustment"]),
    "!": new Set(),
    then: new Set(),
    do: new Set(),
    else: new Set(),
  };
  const START_OPTIONS_WITH_VALUES = new Set(["/d", "/node", "/affinity", "/machine"]);

  // PowerShell accepts any unambiguous parameter prefix. These bodies list the
  // valid abbreviations of its command-bearing and encoded parameters; they are
  // only evidence after parsing an actual command position, never in prose.
  const PS_COMMAND_OPTION_BODY =
    "c|co|com|comm|comma|comman|command" +
    "|commandw|commandwi|commandwit|commandwith|commandwitha|commandwithar|commandwitharg|commandwithargs|cwa" +
    "|fi|fil|file";
  const PS_ENCODED_OPTION_BODY =
    "e|ec|en|enc|enco|encod|encode|encoded" +
    "|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand" +
    "|encodeda|encodedar|encodedarg|encodedargu|encodedargum|encodedargume|encodedargumen|encodedargument|encodedarguments";
  const POWERSHELL_EXECUTION_OPTION_RE = new RegExp(
    String.raw`(?:^|\s)-(?:${PS_COMMAND_OPTION_BODY}|${PS_ENCODED_OPTION_BODY})\b`, "i"
  );
  // cmd parses /c and /k even when the payload is attached (`cmd /ccalc`).
  const CMD_EXECUTION_OPTION_RE = /(?:^|\s)\/[ck](?=$|\S|\s)/i;
  // Single-dash POSIX shell bundles that contain `c` (`-c`, `-lc`, `-xec`).
  const POSIX_C_BUNDLE_OPTION_RE = /(?:^|\s)-(?!-)[a-z]{0,3}c[a-z]{0,3}(?=$|\s|=)/;
  // Inline-code options are tool-specific and case-sensitive. This catches
  // forms the runtimes really execute while avoiding Python `-E` and shell
  // `-C`, which are ordinary configuration flags. Module execution (`-m`) is
  // deliberately excluded because it is everyday developer use.
  const INTERPRETER_INLINE_OPTION_RES = {
    python: /(?:^|\s)-c/,
    python2: /(?:^|\s)-c/,
    python3: /(?:^|\s)-c/,
    py: /(?:^|\s)-c/,
    perl: /(?:^|\s)-e/,
    ruby: /(?:^|\s)-e/,
    node: /(?:^|\s)(?:-e(?=$|\s)|--eval(?:=|\s|$)|-p(?=$|\s)|--print(?:=|\s|$))/,
    php: /(?:^|\s)-r(?=$|\s)/,
    osascript: /(?:^|\s)-e(?=$|\s)/,
  };
  const WSL_EXECUTION_OPTION_RE = /(?:^|\s)(?:-e|--exec)(?=$|\s)/i;
  // Union of the execution-option shapes above; used where the tool identity
  // is unknown (split-name confirmation and the strong-behavior fallback).
  const SHARED_EXECUTION_OPTION_BODY =
    String.raw`\/[ck]|-(?:${PS_COMMAND_OPTION_BODY}|${PS_ENCODED_OPTION_BODY}|m|lc)\b`;
  const EXECUTION_OPTION_UNION_RE =
    new RegExp(String.raw`(?:^|\s)(?:${SHARED_EXECUTION_OPTION_BODY})`, "i");
  const LEADING_EXECUTION_OPTION_RE =
    new RegExp(String.raw`^\s*(?:${SHARED_EXECUTION_OPTION_BODY})`, "i");
  const SPLIT_NAME_FOLLOW_OPTION_RE =
    new RegExp(String.raw`^\s*-(?:${PS_COMMAND_OPTION_BODY}|${PS_ENCODED_OPTION_BODY}|m|lc)\b`, "i");

  // Download, execution, encoding, chaining, and obfuscation behavior. This is
  // scanned only against the arguments of a parsed command candidate, so the
  // tool token itself can never satisfy its own behavior requirement and
  // option names mentioned in prose stay inert.
  const RISKY_BEHAVIOR_RE = new RegExp(String.raw`(?:https?:\/\/|\\\\[^\\\s]+\\` +
    String.raw`|\biex\b|\binvoke-expression\b|\bstart-process\b|\binvoke-command\b` +
    String.raw`|\biwr\b|\birm\b|\binvoke-(?:webrequest|restmethod)\b|\bstart-bitstransfer\b` +
    String.raw`|\bdownload(?:file|string)\b|\burllib\b|\burlopen\b|\bexec\s*\(|\beval\s*\(` +
    String.raw`|\bprocess\s+call\s+create\b|\/(?:create|run|tr)\b|\b(?:vbscript|javascript):` +
    String.raw`|\b(?:mshta|wscript|cscript|rundll32|regsvr32)(?:\.exe)?\b` +
    String.raw`|\bencodedcommand\b` +
    String.raw`|\bfrombase64string\b|\bbase64\b|\bexecutionpolicy\s+(?:bypass|unrestricted)\b` +
    String.raw`|\bwindowstyle\s+hidden\b` +
    String.raw`|\|\s*(?:bash|sh|zsh|powershell|pwsh|cmd)\b|&&|\|\|)`, "i");

  // Strong-behavior fallback (issue #79): high-confidence execution actions
  // that can block strict mode even when the tool name is unrecognized.
  // Download cmdlets are deliberately absent — "Invoke-WebRequest https://…"
  // appears in ordinary documentation prose.
  const FALLBACK_EXECUTION_ACTION_RE = new RegExp(String.raw`(?:\biex\b|\binvoke-expression\b` +
    String.raw`|\bstart-process\b|\bsaps\b|\binvoke-command\b|\bicm\b|\bstart-job\b|\bsajb\b` +
    String.raw`|\bprocess\s+call\s+create\b|\b(?:vbscript|javascript):` +
    String.raw`|\bencodedcommand\b|(?:^|\s)-(?:${PS_ENCODED_OPTION_BODY})\b|\bfrombase64string\b` +
    String.raw`|\bdownload(?:file|string)\b|\bexecutionpolicy\s+(?:bypass|unrestricted)\b` +
    String.raw`|\bwindowstyle\s+hidden\b|\|\s*(?:bash|sh|zsh|powershell|pwsh|cmd)\b)`, "i");
  const ENCODED_CONTENT_RE =
    /(?:\bencodedcommand\b|\bfrombase64string\b|\bbase64\b|(?:^|\s)[a-z0-9+/]{24,}={0,2}(?=$|\s))/i;
  const BRACED_VARIABLE_BODY = String.raw`\$\{(?:[a-z_][a-z0-9_]*|env:[^}\s]+)\}`;
  const DYNAMIC_INVOCATION_SYNTAX_RE = new RegExp(
    String.raw`(?:&\s*[$(]|%[^%\s]+%|![^!\s]+!|\$env:[a-z_]|${BRACED_VARIABLE_BODY})`, "i"
  );
  const REMOTE_SOURCE_RE = /(?:https?:\/\/|\\\\[^\\\s]+\\)/i;
  const BOUNDED_OPTION_PREFIX_BODY = String.raw`(?:["']?[-/][^\s"']+["']?\s+){0,4}`;
  // Risk signals that justify warning about an otherwise generic executable or
  // path: remote sources, encoded payloads, persistence, or execution verbs.
  const GENERIC_EXECUTABLE_RISK_RE = new RegExp(String.raw`^\s*${BOUNDED_OPTION_PREFIX_BODY}(?:["']?(?:https?:\/\/|\\\\[^\\\s]+\\)` +
    String.raw`|\bencodedcommand\b|-(?:${PS_ENCODED_OPTION_BODY})\b|\bfrombase64string\b` +
    String.raw`|\bbase64\b|\/(?:create|run|tr)\b|\bdownload(?:file|string)\b` +
    String.raw`|\b(?:vbscript|javascript):|\biex\b|\binvoke-expression\b|\bstart-process\b)`, "i");

  // Windows launchable and script suffixes for the strict executable-shape
  // rule. `.com` is included per policy even though it collides with bare
  // domain names; email-shaped tokens are exempted below instead.
  const EXECUTABLE_SUFFIX_BODY =
    "exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msc|msi|msp|scr|hta|cpl|pif|lnk|chm|url";
  const EXECUTABLE_SUFFIX_RE = new RegExp(String.raw`\.(?:${EXECUTABLE_SUFFIX_BODY})$`, "i");
  const EXECUTABLE_SUFFIX_SET = new Set(EXECUTABLE_SUFFIX_BODY.split("|"));
  const SHORT_83_NAME_RE = /^[^\s\\/.~]{1,8}~\d{1,6}$/;
  const WEB_URL_RE = /^https?:\/\//i;
  const EMAIL_TOKEN_RE = /^[^@\s\\/]+@[^@\s\\/]+$/;
  const LEADING_SCRIPT_ARGUMENT_RE = new RegExp(
    String.raw`^\s*${BOUNDED_OPTION_PREFIX_BODY}["']?[^"'\s<>]+\.(?:hta|vbs|vbe|js|jse|wsf|dll|sct|msi|msp|ps1|py|php|rb|pl|scpt|sh|bat|cmd|scr)(?=$|[,"'\s])`,
    "i"
  );
  const TOOL_ARGUMENT_RISK_RES = {
    mshta: /(?:\b(?:vbscript|javascript):|\.hta\b)/i,
    wscript: /\.(?:vbs|vbe|js|jse|wsf|wsh)\b/i,
    cscript: /\.(?:vbs|vbe|js|jse|wsf|wsh)\b/i,
    rundll32: /\.(?:dll|cpl)(?=$|[,\s])/i,
    regsvr32: /\.(?:dll|sct)\b/i,
    msiexec: /(?:^|\s)\/(?:i|package|a)(?=$|[:\s])/i,
  };
  const DIRECT_ARGUMENT_SHAPE_RE = new RegExp(
    String.raw`^\s*(?:["'\-\/$%&!({]|https?:\/\/|\\\\|[a-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[^\s"'<>]+\.(?:${EXECUTABLE_SUFFIX_BODY})(?=$|\s))`,
    "i"
  );
  const INPUT_REDIRECTION_RE = /(?:^|\s)\d*<{1,3}\s*\S/;
  // Explicit path shapes that Windows or POSIX launchers resolve directly.
  // Bare single-segment "/word" tokens (slash commands, fractions) are
  // excluded on purpose: they are common benign clipboard content, while a
  // launchable POSIX executable path names at least two segments.
  const EXPLICIT_PATH_RE = new RegExp("^(?:" + [
    String.raw`[a-z]:(?:[\\/]|[^\\/\s])`,
    String.raw`\\(?!\\)[^\s]`,
    String.raw`\\\\[^\s]`,
    String.raw`%[^%\s]+%[\\/]`,
    String.raw`\$env:[a-z_][a-z0-9_]*[\\/]`,
    String.raw`\$[a-z_][a-z0-9_]*[\\/]`,
    String.raw`${BRACED_VARIABLE_BODY}[\\/]`,
    String.raw`~[\\/]`,
    String.raw`\.{1,2}[\\/]`,
    String.raw`\/[^/\s]+\/`,
    String.raw`[^\\/\s]+[\\/][^\s]+`,
  ].join("|") + ")", "i");
  // A variable or expression standing in for the executable itself.
  const DYNAMIC_EXECUTABLE_RE = new RegExp(
    String.raw`^(?:%[^%\s]+%|![^!\s]+!|\$env:[a-z_][a-z0-9_]*|${BRACED_VARIABLE_BODY}|\$[a-z_][a-z0-9_]*)$`, "i"
  );
  const EMBEDDED_DYNAMIC_EXECUTABLE_RE = new RegExp(
    String.raw`(?:%[^%\s]+%|![^!\s]+!|${BRACED_VARIABLE_BODY}|\$env:[a-z_][a-z0-9_]*|\$[a-z_][a-z0-9_]*(?=[\\/]))`, "i"
  );

  // Detection-only Unicode skeleton (issue #79). Each entry lists non-ASCII
  // letters that convincingly imitate the ASCII letter inside a protected
  // command name. NFKC normalization upstream already folds fullwidth and
  // compatibility forms; this curated table only covers cross-script
  // lookalikes that NFKC preserves. It never rewrites clipboard text.
  const CONFUSABLE_LETTER_SOURCES = {
    a: "\u0430\u03B1\u0251\u13AA",       // Cyrillic а, Greek α, Latin ɑ, Cherokee Ꭺ
    b: "\u044C\u13CF",                   // Cyrillic ь, Cherokee Ꮟ
    c: "\u0441\u03F2\u13DF",             // Cyrillic с, Greek ϲ, Cherokee Ꮯ
    d: "\u0501\u13A0",                   // Cyrillic ԁ, Cherokee Ꭰ
    e: "\u0435\u0454\u03B5\u13AC",       // Cyrillic е/є, Greek ε, Cherokee Ꭼ
    g: "\u0261\u0581",                   // Latin ɡ, Armenian ց
    h: "\u04BB\u0570\u13BB",             // Cyrillic һ, Armenian հ, Cherokee Ꮋ
    i: "\u0456\u0457\u03B9\u0131",       // Cyrillic і/ї, Greek ι, dotless ı
    j: "\u0458",                         // Cyrillic ј
    k: "\u043A\u03BA",                   // Cyrillic к, Greek κ
    l: "\u04CF\u2113\u13DE",             // Cyrillic ӏ, script ℓ, Cherokee Ꮮ
    m: "\u043C\u13B7",                   // Cyrillic м, Cherokee Ꮇ
    n: "\u043F\u03B7\u0578",             // Cyrillic п, Greek η, Armenian ո
    o: "\u043E\u03BF\u0585\u13BE",       // Cyrillic о, Greek ο, Armenian օ, Cherokee Ꮎ
    p: "\u0440\u03C1\u13F2",             // Cyrillic р, Greek ρ, Cherokee Ꮲ
    q: "\u051B",                         // Cyrillic ԛ
    r: "\u0433\u13A1",                   // Cyrillic г, Cherokee Ꭱ
    s: "\u0455\u13E5",                   // Cyrillic ѕ, Cherokee Ꮥ
    t: "\u0442\u03C4",                   // Cyrillic т, Greek τ
    u: "\u03C5\u057D",                   // Greek υ, Armenian ս
    v: "\u0475\u03BD",                   // Cyrillic ѵ, Greek ν
    w: "\u051D\u0461\u03C9\u0561\u13E4", // Cyrillic ԝ/ѡ, Greek ω, Armenian ա, Cherokee Ꮤ
    x: "\u0445\u03C7",                   // Cyrillic х, Greek χ
    y: "\u0443\u04AF\u03B3",             // Cyrillic у/ү, Greek γ
  };
  const CONFUSABLE_TO_ASCII = new Map();
  for (const [ascii, sources] of Object.entries(CONFUSABLE_LETTER_SOURCES)) {
    for (const source of sources) {
      CONFUSABLE_TO_ASCII.set(source, ascii);
      CONFUSABLE_TO_ASCII.set(source.toLowerCase(), ascii);
    }
  }
  // The two digit stand-ins that read as letters inside tool names.
  CONFUSABLE_TO_ASCII.set("1", "l");
  CONFUSABLE_TO_ASCII.set("0", "o");

  function skeletonFold(value) {
    let folded = "";
    for (const character of value.toLowerCase()) {
      // Combining marks (e.g. the dot İ decomposes to) are presentation only.
      if (character >= "\u0300" && character <= "\u036F") continue;
      folded += CONFUSABLE_TO_ASCII.get(character) ?? character;
    }
    return folded;
  }

  // Coarse script classes for mixed-script detection in an executable
  // basename. Unicode Common/Inherited characters (digits, punctuation,
  // combining marks) are ignored by simply not being listed.
  const COMMAND_NAME_SCRIPT_RANGES = [
    /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/, // Latin
    /[\u0370-\u03FF\u1F00-\u1FFF]/,                    // Greek
    /[\u0400-\u052F]/,                                 // Cyrillic
    /[\u0530-\u058F\uFB13-\uFB17]/,                    // Armenian
    /[\u05D0-\u05EA]/,                                 // Hebrew
    /[\u0600-\u06FF\u0750-\u077F]/,                    // Arabic
    /[\u13A0-\u13F5\uAB70-\uABBF]/,                    // Cherokee
    /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/, // CJK + Hangul
  ];

  function hasMixedScripts(value) {
    let seen = 0;
    for (const range of COMMAND_NAME_SCRIPT_RANGES) {
      if (!range.test(value)) continue;
      seen += 1;
      if (seen > 1) return true;
    }
    return false;
  }

  // Chromium supports this binary Unicode property and the warning UI already
  // relies on Unicode property escapes. It covers the previous hand-maintained
  // ranges plus variation selectors and other default-ignorable format marks.
  const INVISIBLE_AND_DIRECTIONAL_RE = /\p{Default_Ignorable_Code_Point}/gu;

  function normalizeForDetection(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(INVISIBLE_AND_DIRECTIONAL_RE, "")
      // Join the three bounded continuation forms used by the supported
      // command environments. Other token escapes are handled only while an
      // executable-position token is inspected below.
      .replace(/\\\r?\n/g, "")
      .replace(/\^\r?\n/g, "")
      .replace(/`\r?\n/g, "")
      // cmd/shell parsers concatenate empty quoted segments inside a token.
      .replace(/(?:""|'')(?=[A-Za-z0-9_%./\\])/g, "")
      // Preserve unescaped line boundaries for bounded command-start scans.
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n+ */g, "\n")
      .trim();
  }

  function hostnameMatches(hostname, excludedDomain) {
    const host = String(hostname).toLowerCase().replace(/\.$/, "");
    const excluded = String(excludedDomain).toLowerCase().replace(/\.$/, "");
    return excluded !== "" && (host === excluded || host.endsWith(`.${excluded}`));
  }

  function isExcludedDomain(url, excludedDomains) {
    if (!Array.isArray(excludedDomains) || excludedDomains.length === 0) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return excludedDomains.some((domain) => hostnameMatches(parsed.hostname, domain));
  }

  // Return the initial executable token. This small tokenizer intentionally
  // handles quoted/full paths without attempting to parse an entire shell
  // language. A regex anchored directly on the tool name misses ordinary
  // invocations such as C:\\Windows\\...\\powershell.exe and /usr/bin/bash,
  // which are common and trivial for a hostile page to use.
  function leadingToken(value) {
    const input = value.trimStart();
    if (input === "") return null;
    const startsQuoted = input[0] === '"' || input[0] === "'";
    let quote = null;
    let token = "";
    let index = 0;
    for (; index < input.length; index += 1) {
      const character = input[index];
      if (quote === null && /\s/.test(character)) break;
      // A redirection attached to a command (`cmd.exe>nul`, `bash<input`)
      // ends the executable token. Keep leading redirection forms intact so
      // analyzeCommandClause can skip them before looking for the command.
      if (quote === null && (character === "<" || character === ">") &&
          !/^(?:\d*|[&*])$/.test(token)) {
        break;
      }
      if (quote === null && character === "&" && input[index + 1] === ">" && token !== "") {
        break;
      }
      if (character === '"' || character === "'") {
        if (quote === null) {
          quote = character;
          continue;
        }
        if (quote === character) {
          quote = null;
          continue;
        }
      }
      token += character;
    }
    if (quote !== null) return null;
    return { token, quoted: startsQuoted, rest: input.slice(index) };
  }

  // Shell escaping is applied only to a token currently being considered as
  // an executable. This avoids globally rewriting Windows paths or prose.
  function executableTokenViews(token) {
    // Windows ignores bounded trailing dots/spaces in many path-resolution
    // contexts. Normalize them for matching only; the displayed tool remains
    // the exact clipboard token.
    const lower = token === "." ? "." : token.toLowerCase().replace(/[. ]+$/, "");
    const narrowUnescaped = lower
      .replace(/\^(?=[^\s])/g, "")
      .replace(/`(?=[A-Za-z0-9_%./\\-])/g, "");
    const posixUnescaped = narrowUnescaped.replace(/\\(?=[A-Za-z0-9_%./-])/g, "");
    return [...new Set([narrowUnescaped, posixUnescaped])];
  }

  function executableCommandNames(token) {
    const names = [];
    for (const view of executableTokenViews(token)) {
      const windowsParts = view.split(/[\\/]/);
      const posixParts = view.split("/");
      names.push(windowsParts[windowsParts.length - 1].replace(EXECUTABLE_SUFFIX_RE, ""));
      names.push(posixParts[posixParts.length - 1].replace(EXECUTABLE_SUFFIX_RE, ""));
    }
    return [...new Set(names)];
  }

  function isCommandGroupOpener(value, index, dynamicCallArmed) {
    const character = value[index];
    if (character !== "(" && character !== "{") return false;
    if (dynamicCallArmed) return true;
    const previous = value[index - 1];
    if (character === "(" && previous === "$") return true;
    if (character === "{" && previous === "%") return true;
    // Do not split ordinary source calls such as `require('./util')`. Shell
    // command groups occur at the beginning or after whitespace/separators.
    return index === 0 || /[\s;&|({]/.test(previous);
  }

  // Split the normalized text into command clauses at common separators and
  // group openers while keeping quoted text as data. Escape semantics differ
  // across cmd, PowerShell, and POSIX shells, so each unquoted marker is a
  // possible boundary. Clause boundaries also scope evidence co-location:
  // tool and behavior signals must fall inside the same clause to combine.
  // The hard bound fails closed instead of growing this into a general parser.
  function commandClauses(value) {
    const clauses = [];
    let clauseStart = 0;
    let clauseAfterNonPipeChain = false;
    let clauseAfterPipe = false;
    let clauseDynamicCall = false;
    let clauseCallOperator = false;
    let dynamicCallArmed = false;
    let groupDepth = 0;
    let quote = null;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const next = value[index + 1];
      if (quote !== null) {
        // No escape character has the same quote semantics across cmd,
        // PowerShell, and POSIX shells. Closing on the matching quote is the
        // conservative choice for finding later command boundaries.
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      // File-descriptor duplication (`2>&1`, `<&0`) is one redirection
      // token; its ampersand does not begin another command clause.
      if (character === "&" && (value[index - 1] === ">" || value[index - 1] === "<" ||
          next === ">")) {
        continue;
      }
      if (character === "|" && value[index - 1] === ">") continue;
      const opensGroup = isCommandGroupOpener(value, index, dynamicCallArmed);
      const closesGroup = (character === ")" || character === "}") && groupDepth > 0;
      if (character !== "\n" && character !== ";" && character !== "&" &&
          character !== "|" && !opensGroup && !closesGroup) continue;
      // Newlines and group openers separate clauses without implying that one
      // command chains into the next; prose lists must not look chained.
      const pipeSeparator = character === "|" && next !== "|";
      const nonPipeChain = character === ";" || character === "&" ||
        (character === "|" && next === "|");
      if (clauses.length >= MAX_COMMAND_STARTS - 1) return PARSER_LIMIT;
      clauses.push({
        start: clauseStart,
        end: index,
        nonPipeChained: clauseAfterNonPipeChain || nonPipeChain,
        afterPipe: clauseAfterPipe,
        groupFollows: opensGroup,
        dynamicCall: clauseDynamicCall,
        callOperator: clauseCallOperator,
      });
      let doubled = false;
      if ((character === "&" || character === "|") && next === character) {
        index += 1;
        doubled = true;
      } else if (character === "|" && next === "&") {
        index += 1;
      }
      // A PowerShell call operator immediately before a group ("& (...)")
      // executes whatever the expression yields; tag the group's clause.
      clauseCallOperator = opensGroup && dynamicCallArmed;
      clauseDynamicCall = clauseCallOperator ||
        (opensGroup && character === "(" && value[index - 1] === "$");
      dynamicCallArmed = character === "&" && !doubled &&
        /^\s*[({]/.test(value.slice(index + 1, index + 9));
      clauseStart = index + 1;
      clauseAfterNonPipeChain = nonPipeChain;
      clauseAfterPipe = pipeSeparator;
      if (opensGroup) groupDepth += 1;
      if (closesGroup) groupDepth -= 1;
    }
    clauses.push({
      start: clauseStart,
      end: value.length,
      nonPipeChained: clauseAfterNonPipeChain,
      afterPipe: clauseAfterPipe,
      groupFollows: false,
      dynamicCall: clauseDynamicCall,
      callOperator: clauseCallOperator,
    });
    return clauses;
  }

  const NO_COMMAND = Object.freeze({
    kind: "none", tool: "", canonical: null, evidence: [], rest: "",
  });
  const OBFUSCATION_EVIDENCE = new Set([
    "8.3 command name",
    "confusable command name",
    "mixed-script command name",
    "split command name",
    "command substitution",
    "escaped command name",
  ]);

  function hasObfuscationEvidence(command) {
    return command.evidence.some((item) => OBFUSCATION_EVIDENCE.has(item));
  }

  // Bounded split-name matching (issue #79): reconstruct a protected name from
  // a small leading window, permitting whitespace between its letters, and
  // require either an executable suffix or a recognized execution option
  // immediately after. "power shell.exe -Command" matches; "Power Shell
  // scripting is useful" does not. No global squeezing, no edit distance.
  const SPLIT_NAME_WINDOW = 96;
  const PROTECTED_NAMES_BY_LENGTH =
    [...PROTECTED_COMMAND_NAMES].sort((a, b) => b.length - a.length);

  function splitProtectedName(remainder) {
    const window = remainder.slice(0, SPLIT_NAME_WINDOW);
    if (!window.includes(" ")) return null;
    outer: for (const name of PROTECTED_NAMES_BY_LENGTH) {
      let windowIndex = 0;
      let splits = 0;
      let confusable = false;
      for (let nameIndex = 0; nameIndex < name.length; nameIndex += 1) {
        while (window[windowIndex] === " ") {
          windowIndex += 1;
          splits += 1;
        }
        const character = window[windowIndex];
        if (character === undefined) continue outer;
        const folded = skeletonFold(character);
        if (folded === "") {
          // Combining mark: presentation only, consume without matching.
          windowIndex += 1;
          nameIndex -= 1;
          continue;
        }
        if (folded !== name[nameIndex]) continue outer;
        if (folded !== character.toLowerCase()) confusable = true;
        windowIndex += 1;
      }
      // Whole, un-split names were already handled by plain token matching.
      if (splits === 0) continue;
      const nextCharacter = window[windowIndex];
      if (nextCharacter !== undefined && nextCharacter !== " " && nextCharacter !== ".") continue;
      let end = windowIndex;
      let confirmed = false;
      if (nextCharacter === ".") {
        const suffix = /^\.([a-z0-9]{1,4})/i.exec(window.slice(windowIndex));
        if (suffix !== null && EXECUTABLE_SUFFIX_SET.has(suffix[1].toLowerCase()) &&
            !/[a-z0-9]/i.test(window[windowIndex + suffix[0].length] ?? "")) {
          end = windowIndex + suffix[0].length;
          confirmed = true;
        }
      } else if ((name === "cmd" ? CMD_EXECUTION_OPTION_RE :
                   SPLIT_NAME_FOLLOW_OPTION_RE).test(remainder.slice(windowIndex))) {
        confirmed = true;
      }
      if (!confirmed) continue;
      const evidence = ["split command name"];
      if (confusable) evidence.push("confusable command name");
      return { name, end, evidence };
    }
    return null;
  }

  // Classify the token found in executable position. The original text is
  // never rewritten; folding and squeezing exist only for matching and for
  // explicit evidence strings.
  function classifyCommandToken(part, remainder) {
    const token = part.token;
    const commandSubstitution = token.length > 2 && token.startsWith("`") && token.endsWith("`");
    const escapedName = /\^(?=\S)|`(?=[A-Za-z0-9_%./\\-])/.test(token);
    const unwrappedToken = commandSubstitution ? token.slice(1, -1) : token;
    const matchingToken = unwrappedToken === "." ? "." : unwrappedToken.replace(/[. ]+$/, "");
    const tokenViews = executableTokenViews(matchingToken);
    const rawNames = executableCommandNames(matchingToken);
    const evidence = [];
    if (commandSubstitution) evidence.push("command substitution");
    if (escapedName) evidence.push("escaped command name");
    let canonical = rawNames.find((name) => PROTECTED_COMMAND_NAMES.has(name)) ?? null;
    if (canonical === null) {
      canonical = rawNames.map(skeletonFold)
        .find((name) => PROTECTED_COMMAND_NAMES.has(name)) ?? null;
      if (canonical !== null) evidence.push("confusable command name");
    }
    if (canonical === null && token.includes(" ")) {
      // A quoted "power shell.exe" token reaches here with its space intact.
      canonical = rawNames.map((name) => skeletonFold(name.replace(/ /g, "")))
        .find((name) => PROTECTED_COMMAND_NAMES.has(name)) ?? null;
      if (canonical !== null) evidence.push("split command name");
    }
    if (canonical !== null) {
      return { kind: "protected", tool: token, canonical, evidence, rest: part.rest };
    }
    const split = splitProtectedName(remainder);
    if (split !== null) {
      return {
        kind: "protected",
        tool: remainder.slice(0, split.end).trim(),
        canonical: split.name,
        evidence: split.evidence,
        rest: remainder.slice(split.end),
      };
    }
    const basenames = tokenViews.map((view) => view.split(/[\\/]/).pop() ?? view);
    const basename = basenames[0] ?? matchingToken;
    // The ASCII launchable suffix is not part of the executable's name for
    // script-mixing purposes. Otherwise every non-Latin `program.exe` would
    // look mixed merely because `.exe` is Latin.
    const basenameStem = basename.replace(EXECUTABLE_SUFFIX_RE, "");
    const mixedScript = hasMixedScripts(basenameStem);
    // Exempt only complete web URLs and complete email tokens. Parentheses and
    // `@` are legal path characters and must not disable executable detection.
    const inertShape = WEB_URL_RE.test(matchingToken) ||
      (EMAIL_TOKEN_RE.test(matchingToken) && /\.com$/i.test(matchingToken) && part.rest.trim() === "");
    if (!inertShape) {
      if ((DYNAMIC_EXECUTABLE_RE.test(matchingToken) ||
           EMBEDDED_DYNAMIC_EXECUTABLE_RE.test(matchingToken)) &&
          !part.rest.trimStart().startsWith("=")) {
        return { kind: "dynamic", tool: token, canonical: null, evidence, rest: part.rest };
      }
      const launchableBasename = basenames.find((item) => EXECUTABLE_SUFFIX_RE.test(item));
      if (launchableBasename !== undefined) {
        if (SHORT_83_NAME_RE.test(launchableBasename.replace(/\.[a-z0-9]{1,4}$/, ""))) {
          evidence.push("8.3 command name");
        }
        if (mixedScript) evidence.push("mixed-script command name");
        return { kind: "executable", tool: token, canonical: null, evidence, rest: part.rest };
      }
      if (basenames.some((item) => SHORT_83_NAME_RE.test(item))) {
        evidence.push("8.3 command name");
        return { kind: "executable", tool: token, canonical: null, evidence, rest: part.rest };
      }
      if (tokenViews.some((view) => EXPLICIT_PATH_RE.test(view))) {
        if (mixedScript) evidence.push("mixed-script command name");
        return { kind: "path", tool: token, canonical: null, evidence, rest: part.rest };
      }
    }
    return {
      kind: "none",
      tool: token,
      canonical: null,
      evidence: mixedScript ? ["mixed-script command name"] : [],
      rest: part.rest,
    };
  }

  // Parse one clause: strip a small, explicit set of launchers/wrappers, then
  // classify whatever sits in executable position. The bounds keep adversarial
  // input from turning this into an open-ended shell parser.
  function analyzeCommandClause(clauseText, dynamicCall = false) {
    let remainder = clauseText.trimStart();
    let wrapperFallback = null;
    const unresolvedCommand = () => dynamicCall ?
      dynamicResultOrNone(true, clauseText) : (wrapperFallback ?? NO_COMMAND);
    const rememberWrapperShape = (part) => {
      if (wrapperFallback !== null) return;
      const shape = classifyCommandToken(part, remainder.trimStart());
      if (shape.kind !== "none") wrapperFallback = shape;
    };
    let commandPrefixCount = 0;
    while (remainder !== "") {
      const first = remainder[0];
      if (first === "@" || first === "(" || first === "{") {
        if (commandPrefixCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
        commandPrefixCount += 1;
        remainder = remainder.slice(1).trimStart();
        continue;
      }
      if (first === "&" && remainder[1] !== "&" && remainder[1] !== ">") {
        if (commandPrefixCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
        commandPrefixCount += 1;
        remainder = remainder.slice(1).trimStart();
        continue;
      }

      const prefixPart = leadingToken(remainder);
      if (prefixPart === null) return unresolvedCommand();
      const redirection = /^(?:(?:\d*|\*)(?:>\||>>?|<<?)|&>>?)(.*)$/.exec(prefixPart.token);
      if (redirection === null) break;
      if (commandPrefixCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
      commandPrefixCount += 1;
      remainder = prefixPart.rest.trimStart();
      if (redirection[1] === "") {
        const target = leadingToken(remainder);
        if (target === null) return unresolvedCommand();
        remainder = target.rest.trimStart();
      }
    }
    let wrapperDepth = 0;
    let leadingAssignmentCount = 0;

    while (true) {
      const part = leadingToken(remainder);
      if (part === null) return unresolvedCommand();
      const commandNames = executableCommandNames(part.token);

      // POSIX shells permit NAME=value prefixes in command position. Consume
      // only a bounded run; assignment expansion itself remains out of scope.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part.token)) {
        if (leadingAssignmentCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
        leadingAssignmentCount += 1;
        remainder = part.rest.trimStart();
        continue;
      }

      if (commandNames.includes("call")) {
        rememberWrapperShape(part);
        if (wrapperDepth >= MAX_WRAPPER_DEPTH) return PARSER_LIMIT;
        wrapperDepth += 1;
        remainder = part.rest;
        continue;
      }

      if (commandNames.includes("start")) {
        rememberWrapperShape(part);
        if (wrapperDepth >= MAX_WRAPPER_DEPTH) return PARSER_LIMIT;
        wrapperDepth += 1;
        remainder = part.rest.trimStart();
        let optionCount = 0;
        while (true) {
          const option = leadingToken(remainder);
          if (option === null || option.quoted || !/^\/[a-z]+$/i.test(option.token)) break;
          if (optionCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
          optionCount += 1;
          remainder = option.rest.trimStart();
          if (START_OPTIONS_WITH_VALUES.has(option.token.toLowerCase())) {
            const optionValue = leadingToken(remainder);
            if (optionValue === null) return unresolvedCommand();
            remainder = optionValue.rest.trimStart();
          }
        }
        const candidate = leadingToken(remainder);
        // The first quoted START argument is its window title when another
        // token follows it (including the conventional empty title).
        if (candidate?.quoted === true && candidate.rest.trim() !== "") {
          remainder = candidate.rest;
        }
        while (true) {
          const option = leadingToken(remainder);
          if (option === null || option.quoted || !/^\/[a-z]+$/i.test(option.token)) break;
          if (optionCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
          optionCount += 1;
          remainder = option.rest.trimStart();
          if (START_OPTIONS_WITH_VALUES.has(option.token.toLowerCase())) {
            const optionValue = leadingToken(remainder);
            if (optionValue === null) return unresolvedCommand();
            remainder = optionValue.rest.trimStart();
          }
        }
        continue;
      }

      const commandName = commandNames.find((name) => COMMAND_WRAPPERS.has(name));
      if (commandName !== undefined) {
        rememberWrapperShape(part);
        if (wrapperDepth >= MAX_WRAPPER_DEPTH) return PARSER_LIMIT;
        wrapperDepth += 1;
        const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[commandName];
        remainder = part.rest.trimStart();
        let optionCount = 0;
        while (true) {
          const option = leadingToken(remainder);
          if (option === null) return unresolvedCommand();
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option.token)) {
            if (optionCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
            optionCount += 1;
            remainder = option.rest.trimStart();
            continue;
          }
          if (!option.token.startsWith("-")) break;
          if (optionCount >= MAX_WRAPPER_OPTIONS) return PARSER_LIMIT;
          optionCount += 1;
          remainder = option.rest.trimStart();

          if (commandName === "env") {
            let splitString = null;
            if (option.token === "-S" || option.token === "--split-string") {
              const optionValue = leadingToken(remainder);
              if (optionValue === null) return unresolvedCommand();
              splitString = optionValue.token;
              remainder = optionValue.rest.trimStart();
            } else if (option.token.startsWith("--split-string=")) {
              splitString = option.token.slice("--split-string=".length);
            } else if (option.token.startsWith("-S") && option.token.length > 2) {
              splitString = option.token.slice(2);
            }
            if (splitString !== null) {
              const tail = remainder.trimStart();
              remainder = `${splitString}${tail === "" ? "" : ` ${tail}`}`.trimStart();
              continue;
            }
          }

          if (!option.token.includes("=") && optionsWithValues.has(option.token)) {
            const optionValue = leadingToken(remainder);
            if (optionValue === null) return unresolvedCommand();
            remainder = optionValue.rest.trimStart();
          }
        }
        continue;
      }

      const classified = classifyCommandToken(part, remainder.trimStart());
      if (classified.kind === "none") return unresolvedCommand();
      return classified;
    }
  }

  function dynamicResultOrNone(dynamicCall, clauseText) {
    if (!dynamicCall) return NO_COMMAND;
    return {
      kind: "dynamic",
      tool: "& (…)",
      canonical: null,
      evidence: ["dynamic invocation"],
      rest: clauseText,
    };
  }

  // Tool-aware execution options (issue #79 §6). Only consulted against the
  // arguments of a parsed command candidate.
  function toolExecutionOption(canonical, text) {
    if (POWERSHELL_COMMAND_NAMES.has(canonical)) {
      return POWERSHELL_EXECUTION_OPTION_RE.exec(text)?.[0] ?? null;
    }
    if (canonical === "cmd") return CMD_EXECUTION_OPTION_RE.exec(text)?.[0] ?? null;
    if (POSIX_SHELL_COMMAND_NAMES.has(canonical)) {
      return POSIX_C_BUNDLE_OPTION_RE.exec(text)?.[0] ?? null;
    }
    if (INTERPRETER_COMMAND_NAMES.has(canonical)) {
      return INTERPRETER_INLINE_OPTION_RES[canonical]?.exec(text)?.[0] ?? null;
    }
    if (canonical === "wsl") return WSL_EXECUTION_OPTION_RE.exec(text)?.[0] ?? null;
    return null;
  }

  function scriptArgumentEvidence(canonical, text) {
    const inspected = canonical === "osascript" ?
      text.replace(/^\s*-l\s+\S+\s+/, " ") : text;
    return LEADING_SCRIPT_ARGUMENT_RE.exec(inspected)?.[0] ?? null;
  }

  // Check for a documented command-bearing argument of a known proxy. Option
  // values and WT subcommands are skipped with a hard bound; nothing is
  // recursively parsed or evaluated.
  function hasProxyCommandArgument(canonical, rest) {
    let remainder = rest.trimStart();
    for (let step = 0; step < MAX_WRAPPER_OPTIONS * 2; step += 1) {
      const part = leadingToken(remainder);
      if (part === null || part.token === "") return false;
      const lower = part.token.toLowerCase();
      if (canonical === "forfiles" || canonical === "pcalua") {
        const bearingOption = canonical === "forfiles" ? "/c" : "-a";
        if (lower === bearingOption) {
          const argument = leadingToken(part.rest.trimStart());
          return argument !== null && argument.token !== "";
        }
        remainder = part.rest.trimStart();
        continue;
      }
      if (canonical === "wt" && WT_SUBCOMMAND_NAMES.has(lower)) {
        remainder = part.rest.trimStart();
        continue;
      }
      const optionToken = lower.startsWith("-") ||
        (canonical === "runas" && lower.startsWith("/"));
      if (optionToken) {
        remainder = part.rest.trimStart();
        const optionName = lower.split("=", 1)[0];
        const optionsWithValues = PROXY_OPTIONS_WITH_VALUES[canonical];
        if (!lower.includes("=") && optionsWithValues?.has(optionName)) {
          const value = leadingToken(remainder);
          if (value === null || value.token === "") return false;
          remainder = value.rest.trimStart();
        }
        continue;
      }
      return true;
    }
    return false;
  }

  // Strong-behavior fallback: a high-confidence execution action plus one
  // distinct co-located risk signal. The primary match is masked out before
  // searching for secondaries so overlapping regexes cannot count twice.
  function strongBehaviorEvidence(clause) {
    const text = clause.text;
    const primary = FALLBACK_EXECUTION_ACTION_RE.exec(text);
    if (primary === null) return null;
    const command = leadingToken(text);
    if (command === null) return null;

    // The execution action itself must occupy command-argument position: as
    // the first argument, directly after a first execution option, or as a
    // leading encoded option. This structural gate replaces a prose-word list.
    const executionActionStarts = (value) => {
      const candidate = value.trimStart().replace(/^["'({\[]+/, "");
      return FALLBACK_EXECUTION_ACTION_RE.exec(candidate)?.index === 0;
    };
    const commandOption = LEADING_EXECUTION_OPTION_RE.exec(command.rest);
    const encodedOptionIsAction = commandOption !== null &&
      /encoded/i.test(commandOption[0]);
    const commandShapedAction = executionActionStarts(command.rest) ||
      encodedOptionIsAction ||
      (commandOption !== null &&
       executionActionStarts(command.rest.slice(commandOption[0].length)));
    if (!commandShapedAction) return null;

    const masked = text.slice(0, primary.index) +
      " ".repeat(primary[0].length) +
      text.slice(primary.index + primary[0].length);
    // For an unknown launcher, an execution option is corroboration only when
    // it is the launcher's first argument.
    const maskedCommand = leadingToken(masked);
    const leadingOption = maskedCommand === null ? null :
      LEADING_EXECUTION_OPTION_RE.exec(maskedCommand.rest);
    if (leadingOption !== null) {
      return { primary: primary[0].trim(), secondary: leadingOption[0].trim() };
    }

    // Remote evidence is accepted only when the action itself is the first
    // argument, or follows a first execution option. This catches an obscured
    // launcher without treating prose that merely co-locates an API and URL
    // as a command.
    const remote = REMOTE_SOURCE_RE.exec(masked);
    if (remote !== null) {
      return { primary: primary[0].trim(), secondary: remote[0].trim() };
    }
    for (const pattern of [ENCODED_CONTENT_RE, DYNAMIC_INVOCATION_SYNTAX_RE]) {
      const secondary = pattern.exec(masked);
      if (secondary !== null) {
        return { primary: primary[0].trim(), secondary: secondary[0].trim() };
      }
    }
    if (hasObfuscationEvidence(clause)) {
      return { primary: primary[0].trim(), secondary: "obfuscated command name" };
    }
    return null;
  }

  // Warn-mode calibration (issue #79): simple Boolean combinations that all
  // require command and risk evidence inside the same clause.
  function warnClauseEvidence(clause) {
    const rest = clause.rest ?? "";
    if (clause.kind === "protected") {
      const reasons = ["system or scripting tool", "download, execution, or obfuscation behavior",
        ...clause.evidence];
      if (DIRECT_EXECUTION_COMMAND_NAMES.has(clause.canonical) &&
          (DIRECT_ARGUMENT_SHAPE_RE.test(rest) || clause.groupFollows)) {
        return { reasons, behavior: "direct execution command" };
      }
      if (PROXY_COMMAND_NAMES.has(clause.canonical)) {
        if (hasProxyCommandArgument(clause.canonical, rest)) {
          return { reasons, behavior: "command-bearing proxy argument" };
        }
      }
      if (clause.dynamicCall) {
        return { reasons, behavior: clause.callOperator ?
          "dynamic invocation" : "command substitution" };
      }
      if (hasObfuscationEvidence(clause)) {
        return { reasons, behavior: "obfuscated command name" };
      }
      if (clause.afterPipe && PIPE_INPUT_COMMAND_NAMES.has(clause.canonical)) {
        return { reasons, behavior: "piped input to command" };
      }
      if (INPUT_REDIRECTION_RE.test(rest) && PIPE_INPUT_COMMAND_NAMES.has(clause.canonical)) {
        return { reasons, behavior: "redirected input to command" };
      }
      const risky = RISKY_BEHAVIOR_RE.exec(rest);
      if (risky !== null) return { reasons, behavior: risky[0].trim() };
      const toolRisk = TOOL_ARGUMENT_RISK_RES[clause.canonical]?.exec(rest)?.[0] ?? null;
      if (toolRisk !== null) return { reasons, behavior: toolRisk.trim() };
      const script = scriptArgumentEvidence(clause.canonical, rest);
      if (script !== null) return { reasons, behavior: script.trim() };
      const option = toolExecutionOption(clause.canonical, rest);
      if (option !== null) return { reasons, behavior: option.trim() };
      return null;
    }
    if (clause.kind === "executable" || clause.kind === "path") {
      const reasons = ["executable in command position",
        "remote, encoded, chained, or obfuscated behavior", ...clause.evidence];
      if (clause.dynamicCall) {
        return { reasons, behavior: clause.callOperator ?
          "dynamic invocation" : "command substitution" };
      }
      const risky = GENERIC_EXECUTABLE_RISK_RE.exec(rest);
      if (risky !== null) return { reasons, behavior: risky[0].trim() };
      if (clause.nonPipeChained) {
        return { reasons, behavior: "command chaining" };
      }
      if (hasObfuscationEvidence(clause)) {
        return { reasons, behavior: "obfuscated executable name" };
      }
      return null;
    }
    if (clause.kind === "dynamic") {
      const reasons = ["dynamic executable invocation", "execution or payload behavior"];
      if (clause.callOperator) return { reasons, behavior: "dynamic invocation" };
      if (clause.afterPipe || INPUT_REDIRECTION_RE.test(rest)) {
        return { reasons, behavior: "redirected input to command" };
      }
      const risky = RISKY_BEHAVIOR_RE.exec(rest) ?? EXECUTION_OPTION_UNION_RE.exec(rest);
      if (risky !== null) return { reasons, behavior: risky[0].trim() };
      return null;
    }
    return null;
  }

  // settings: { mode: "strict" | "warn", excluded_domains: string[] }
  function detectClickfixCommand(value, settings = {}, context = {}) {
    const originalText = String(value ?? "");
    const mode = settings.mode === "warn" ? "warn" : "strict";

    // Domain exclusions are an explicit warn-mode escape hatch. They never
    // weaken strict mode and are resolved against the trusted sender URL.
    if (mode === "warn" && isExcludedDomain(context.url, settings.excluded_domains)) {
      return { action: "allow", reasons: ["excluded domain"], originalText };
    }

    if (originalText.length > MAX_COPY_TEXT_LENGTH) {
      return {
        action: mode === "warn" ? "warn" : "block",
        reasons: ["clipboard text is too large to inspect safely"],
        originalText,
        normalizedText: "",
        tool: "unverified content",
        behavior: "inspection limit exceeded",
      };
    }

    // Normalize before any detection-length decision. This prevents leading
    // spaces or invisible characters from pushing the command beyond a slice.
    const normalizedText = normalizeForDetection(originalText);
    if (normalizedText === "") {
      return { action: "allow", reasons: [], originalText, normalizedText };
    }

    const limitResult = () => ({
      action: mode === "warn" ? "warn" : "block",
      reasons: ["command structure exceeded inspection limits"],
      tool: PARSER_LIMIT_TOOL,
      behavior: "command, wrapper, or option inspection limit exceeded",
      originalText,
      normalizedText,
    });
    const clauses = commandClauses(normalizedText);
    if (clauses === PARSER_LIMIT) return limitResult();
    const analyzed = [];
    for (const clause of clauses) {
      const text = normalizedText.slice(clause.start, clause.end);
      const info = analyzeCommandClause(text, clause.dynamicCall);
      if (info === PARSER_LIMIT) return limitResult();
      analyzed.push({
        ...info,
        text,
        nonPipeChained: clause.nonPipeChained,
        afterPipe: clause.afterPipe,
        groupFollows: clause.groupFollows,
        dynamicCall: clause.dynamicCall,
        callOperator: clause.callOperator,
      });
    }

    if (mode === "strict") {
      const STRICT_KIND_REASONS = {
        protected: "system or administrative command",
        executable: "executable file reference in command position",
        path: "explicit executable path in command position",
        dynamic: "dynamic executable invocation",
      };
      for (const clause of analyzed) {
        if (clause.kind === "none") continue;
        const result = {
          action: "block",
          reasons: [STRICT_KIND_REASONS[clause.kind], ...clause.evidence],
          tool: clause.tool,
          originalText,
          normalizedText,
        };
        if (clause.canonical !== null) result.canonicalTool = clause.canonical;
        return result;
      }
      for (const clause of analyzed) {
        const strong = strongBehaviorEvidence(clause);
        if (strong !== null) {
          return {
            action: "block",
            reasons: ["high-confidence execution behavior", "corroborating execution risk signal"],
            tool: "unrecognized command",
            behavior: `${strong.primary} with ${strong.secondary}`,
            originalText,
            normalizedText,
          };
        }
      }
      return { action: "allow", reasons: [], originalText, normalizedText };
    }

    for (const clause of analyzed) {
      if (clause.kind === "none") continue;
      const found = warnClauseEvidence(clause);
      if (found !== null) {
        const result = {
          action: "warn",
          reasons: found.reasons,
          tool: clause.tool,
          behavior: found.behavior,
          originalText,
          normalizedText,
        };
        if (clause.canonical !== null) result.canonicalTool = clause.canonical;
        return result;
      }
    }
    for (const clause of analyzed) {
      if (clause.kind !== "none") continue;
      const strong = strongBehaviorEvidence(clause);
      if (strong !== null) {
        return {
          action: "warn",
          reasons: ["high-confidence execution behavior", "corroborating execution risk signal"],
          tool: "unrecognized command",
          behavior: `${strong.primary} with ${strong.secondary}`,
          originalText,
          normalizedText,
        };
      }
    }
    // Command-shaped content without risk signals stays copyable in warn mode
    // but is recorded as recognized so callers and diagnostics can see it.
    const shaped = analyzed.find((clause) => clause.kind !== "none");
    if (shaped !== undefined) {
      return {
        action: "allow",
        reasons: ["command-shaped content without risk signals"],
        tool: shaped.tool,
        originalText,
        normalizedText,
      };
    }
    return { action: "allow", reasons: [], originalText, normalizedText };
  }

  return {
    MAX_COPY_TEXT_LENGTH,
    normalizeForDetection,
    hostnameMatches,
    isExcludedDomain,
    detectClickfixCommand,
  };
});
