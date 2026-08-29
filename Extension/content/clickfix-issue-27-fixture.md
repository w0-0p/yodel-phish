## Summary

ClickFix falsely warns on long, benign clipboard content because it treats every newline and shell separator as a possible command boundary and stops after 64 clauses.

Remove the 64-clause limit. Continue inspecting the complete clipboard value up to 65,536 characters.

Clipboard values longer than 65,536 characters are explicitly outside ClickFix inspection scope. They must be copied without a ClickFix warning or block.

## Current behavior

`Extension/content/clickfix-policy.js` defines:

```js
const MAX_COMMAND_STARTS = 64;
```

`commandClauses()` counts unquoted newlines, semicolons, pipes, ampersands, and group boundaries. After 64 boundaries, it returns `PARSER_LIMIT`.

`detectClickfixCommand()` converts this into:

```js
{
  action: "warn", // or "block" in strict mode
  reasons: ["command structure exceeded inspection limits"],
  tool: "unverified wrapped command",
  behavior: "command, wrapper, or option inspection limit exceeded"
}
```

As a result, ordinary Markdown and documentation can trigger ClickFix without matching any dangerous command pattern.

## Required behavior

### Clipboard values up to 65,536 characters

For clipboard text whose length is less than or equal to 65,536 characters:

- Inspect the complete value.
- Remove the global 64-clause/command-start limit.
- Do not warn merely because the value contains many lines or separators.
- Detect dangerous commands even when they appear after the 64th clause.
- Preserve the existing strict/warn policy behavior for genuine detections.
- Preserve the existing wrapper-depth and wrapper-option limits. These are separate structural safety limits and must remain enforced.

### Clipboard values exceeding 65,536 characters

For clipboard text longer than 65,536 characters:

- Do not inspect it with the ClickFix command policy.
- Do not open a ClickFix warning.
- Do not block or silently suppress the copy.
- Copy the complete original value normally.
- Apply this behavior in both strict and warn modes.

The policy result should be equivalent to:

```js
{
  action: "allow",
  reasons: ["clipboard content exceeds ClickFix inspection scope"],
  originalText
}
```

This is an intentional policy decision and accepted tradeoff/limitation.

## Implementation requirements

### 1. Remove only the clause-count failure

In `Extension/content/clickfix-policy.js`:

- Remove `MAX_COMMAND_STARTS`.
- Remove the `PARSER_LIMIT` return caused solely by the number of clauses.
- Do not remove `PARSER_LIMIT` entirely because it is also used by:
  - wrapper-depth limits;
  - wrapper-option limits;
  - leading assignment limits;
  - command-prefix limits.

Those structural parser limits must continue to fail according to the existing policy.

### 2. Avoid unnecessary clause arrays

The current implementation first creates an array of every clause and then creates another array containing every analyzed clause.

Refactor this to process clauses incrementally:

- Use a generator, iterator, callback, or equivalent streaming approach.
- Skip empty and whitespace-only clauses immediately.
- Analyze each non-empty clause as it is produced.
- Return immediately when a conclusive policy result is found.
- Retain only limited fallback evidence when needed to preserve existing result precedence.

The full input remains bounded by 65,536 characters.

Local measurements with the clause limit disabled showed approximately:

- Supplied issue Markdown: 1–2 ms.
- Maximum-length prose: 15–26 ms.
- Pathological separator-heavy maximum-length input: approximately 150 ms before streaming optimization.

### 3. Separate inspection and transport limits

Currently `MAX_COPY_TEXT_LENGTH` is used both as:

- the ClickFix inspection ceiling; and
- a clipboard transport/write ceiling.

These concepts must be separated.

Introduce a clearly named policy constant such as:

```js
const MAX_CLICKFIX_INSPECTION_LENGTH = 65_536;
```

Do not reject an otherwise valid clipboard operation merely because its value exceeds this inspection ceiling.

Review and update length guards in:

- `Extension/content/clickfix-policy.js`
- `Extension/content/clickfix.js`
- `Extension/content/clickfix-page-hook.js`
- `Extension/background/service_worker.js`
- `Extension/runtime/clipboard.js`

Programmatic and manual clipboard operations exceeding the inspection ceiling must follow an allowed copy path.

Possible implementation:

- native clipboard passthrough for out-of-scope values

For the implementation:

- preserve the complete original value;
- do not truncate it;
- do not raise a ClickFix warning;
- do not report `blocked`;
- do not silently cancel manual copy or cut.

If a separate transport limit is necessary, exceeding it must be treated as an ordinary clipboard failure or native passthrough, not as a ClickFix verdict.

## Acceptance criteria

- [ ] `MAX_COMMAND_STARTS` no longer limits inspection.
- [ ] More than 64 benign lines or clauses do not produce a warning.
- [ ] A dangerous command after more than 64 benign clauses is still detected.
- [ ] Existing strict-mode command detections remain blocking.
- [ ] Existing warn-mode risk detections remain bypassable warnings.
- [ ] Wrapper-depth and wrapper-option safety limits remain enforced.
- [ ] Text of exactly 65,536 characters is inspected normally.
- [ ] Text of 65,537 characters is allowed without inspection in both modes.
- [ ] An oversized value opens no ClickFix interstitial.
- [ ] The complete oversized value is actually copied.
- [ ] Oversized manual copy is not cancelled and lost.
- [ ] Oversized cut behaves like an ordinary allowed cut.
- [ ] Oversized `navigator.clipboard.writeText()` resolves normally when the native clipboard operation succeeds.
- [ ] Oversized `navigator.clipboard.write()` behaves consistently.
- [ ] Clipboard contents are never truncated or rewritten.
- [ ] Classification remains bounded and does not introduce unbounded parser work.

## Required tests

### Policy tests

Update `Extension/content/clickfix-policy.test.js`:

1. Add the supplied issue Markdown as a regression fixture.
2. Assert that it returns `allow` in warn mode.
3. Test benign content containing substantially more than 64 clauses.
4. Place a genuine dangerous command after more than 64 benign clauses.
5. Assert that the late command is still detected.
6. Test exactly 65,536 characters.
7. Test 65,537 characters in strict and warn modes and assert `allow`.
8. Retain the existing wrapper-depth and option-limit tests.
9. Add or retain a maximum-length performance test.
10. Add a separator-heavy performance case.

### Clipboard mediation tests

Update:

- `Extension/content/clickfix.test.js`
- `Extension/content/clickfix-page-hook.test.js`
- `Extension/runtime/clipboard.test.js`
- relevant service-worker tests

Cover:

1. Oversized `writeText()`.
2. Oversized `Clipboard.write()`.
3. Oversized trusted manual copy.
4. Oversized trusted manual cut.
5. Exact preservation of the complete value.
6. No ClickFix runtime request or warning when using native passthrough.
7. Successful extension-owned writing if a separate transport path is used.
8. Failure behavior that does not misrepresent transport failure as a ClickFix detection.

## Out of scope

This issue does not change:

- ClickFix warning-tab lifecycle;
- warning-session storage;
- interstitial rendering;
- warn-mode confirmation UI;
- warning-tab cleanup.
