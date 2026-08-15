// Direct fixture tests for the login-page heuristic (issue #11).
//
// login-detector.js walks the DOM through a deliberately small API surface, so
// a compact fixture helper is enough to exercise it under plain Node. The
// helper models the native semantics the detector intentionally delegates to:
// form ownership, label association, and :disabled. Observer-to-pipeline
// lifecycle is covered separately in content.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LOGIN_THRESHOLD,
  PASSWORD_CONFIDENCE,
  IDENTITY_CONFIDENCE,
  DETECTION_ATTRIBUTES,
  VISUAL_ATTRIBUTES,
  collectOpenShadowRoots,
  detectLoginPage,
} = require("./login-detector.js");

// -----------------------------------------------------------------------------
// Fixture helper.
//
// el(tag, props, ...children): props keys `text`, `style`, `rect`, `disabled`,
// `readOnly`, `hidden`, `inert` map to element state; `shadow` / `closedShadow`
// take a child list rendered in an attached Shadow root; every other key
// becomes an attribute. Defaults describe an ordinary rendered element.
// -----------------------------------------------------------------------------

const ELEMENT_PROPS = new Set([
  "text", "style", "rect", "disabled", "readOnly", "hidden", "inert", "shadow", "closedShadow",
]);
const FORM_ASSOCIATED_TAGS = new Set(["input", "button", "select", "textarea", "output", "fieldset", "object"]);
const DISABLEABLE_TAGS = new Set(["button", "fieldset", "input", "optgroup", "option", "select", "textarea"]);
const LABELABLE_TAGS = new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);

function fixtureTag(el) {
  return el.tagName.toLowerCase();
}

function isWithin(el, container) {
  for (let cur = el; cur !== null; cur = cur.parentElement) {
    if (cur === container) return true;
  }
  return false;
}

function isFixtureDisabled(el) {
  if (!DISABLEABLE_TAGS.has(fixtureTag(el))) return false;
  if (el.disabled || el.getAttribute("disabled") !== null) return true;
  for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) {
    if (
      fixtureTag(cur) !== "fieldset" ||
      (!cur.disabled && cur.getAttribute("disabled") === null)
    ) continue;
    const firstLegend = cur.children.find((child) => fixtureTag(child) === "legend");
    if (firstLegend !== undefined && isWithin(el, firstLegend)) continue;
    return true;
  }
  return false;
}

function firstLabelableDescendant(root) {
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (LABELABLE_TAGS.has(fixtureTag(node)) && node.getAttribute("type") !== "hidden") return node;
    stack.push(...[...node.children].reverse());
  }
  return null;
}

function el(tag, props = {}, ...children) {
  const attrs = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ELEMENT_PROPS.has(key)) attrs[key] = value;
  }
  const element = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children,
    disabled: props.disabled ?? false,
    readOnly: props.readOnly ?? false,
    hidden: props.hidden ?? false,
    inert: props.inert ?? false,
    form: null,
    labels: [],
    _text: props.text ?? "",
    _attrs: attrs,
    _style: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      contentVisibility: "visible",
      ...props.style,
    },
    _rect: { left: 0, top: 0, width: 120, height: 24, ...props.rect },
    getAttribute(name) {
      return Object.hasOwn(this._attrs, name) ? String(this._attrs[name]) : null;
    },
    getBoundingClientRect() {
      return this._rect;
    },
    matches(selector) {
      return selector === ":disabled" ? isFixtureDisabled(this) : false;
    },
    get textContent() {
      return [this._text, ...this.children.map((child) => child.textContent)].join(" ");
    },
  };
  for (const child of children) child.parentElement = element;
  // An open Shadow root: its top-level children have no parentElement — their
  // parentNode is the root, whose host is this element — exactly as in the
  // DOM. A closed root exposes nothing at all, so the fixture only records
  // that `shadowRoot` is null for it.
  if (Array.isArray(props.shadow)) {
    const shadowRoot = { host: element, children: props.shadow };
    for (const child of props.shadow) child.parentNode = shadowRoot;
    element.shadowRoot = shadowRoot;
  } else if (Array.isArray(props.closedShadow)) {
    element.shadowRoot = null;
  }
  return element;
}

// Wires one node tree — the document, or one open Shadow root. Ids, form
// ownership and label association are all scoped to the tree the element lives
// in, which is what the DOM does and what the detector relies on. Shadow roots
// found on the way are wired the same way, recursively.
function wireRoot(root) {
  const byId = new Map();
  const nodes = [];
  const shadowRoots = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop();
    nodes.push(node);
    node.getRootNode = () => root;
    const id = node.getAttribute("id");
    if (id !== null && !byId.has(id)) byId.set(id, node);
    if (node.shadowRoot !== null && node.shadowRoot !== undefined) shadowRoots.push(node.shadowRoot);
    stack.push(...node.children);
  }
  root.getElementById = (id) => byId.get(id) ?? null;

  for (const node of nodes) {
    if (!FORM_ASSOCIATED_TAGS.has(fixtureTag(node))) continue;
    const explicit = node.getAttribute("form");
    if (explicit !== null) {
      const target = byId.get(explicit);
      node.form = target !== undefined && fixtureTag(target) === "form" ? target : null;
      continue;
    }
    for (let cur = node.parentElement; cur !== null; cur = cur.parentElement) {
      if (fixtureTag(cur) === "form") {
        node.form = cur;
        break;
      }
    }
  }

  for (const label of nodes.filter((node) => fixtureTag(node) === "label")) {
    const targetId = label.getAttribute("for");
    const target = targetId === null ? firstLabelableDescendant(label) : byId.get(targetId);
    if (target !== null && target !== undefined && Array.isArray(target.labels)) {
      target.labels.push(label);
    }
  }

  for (const shadowRoot of shadowRoots) wireRoot(shadowRoot);
}

function page(...children) {
  const body = el("body", {}, ...children);
  const html = el("html", {}, body);
  const documentRoot = { children: [html] };
  wireRoot(documentRoot);

  const document = {
    body,
    documentElement: html,
    getElementById: (id) => documentRoot.getElementById(id),
  };
  const window = {
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: (node) => node._style,
  };
  return { document, window };
}

function detect(...children) {
  const { document, window } = page(...children);
  return detectLoginPage(document, window);
}

// Wraps children in `levels` plain, meaning-free <div> wrappers — the kind of
// deeply nested container tree that separates the steps of a form-less
// multi-step credential page (issue #5). Reaching past LOCAL_ASSOCIATION_MAX_DEPTH
// is the whole point, so each fixture states its depth explicitly rather than
// relying on an exact number.
function nest(levels, ...children) {
  let node = el("div", {}, ...children);
  for (let i = 1; i < levels; i += 1) node = el("div", {}, node);
  return node;
}

test("open Shadow-root discovery includes nested roots and skips closed roots", () => {
  const nestedHost = el("section", { shadow: [el("input", { type: "password" })] });
  const openHost = el("div", { shadow: [nestedHost] });
  const closedHost = el("div", { closedShadow: [el("input", { type: "password" })] });
  const { document } = page(openHost, closedHost);

  assert.deepEqual(collectOpenShadowRoots(document), [
    openHost.shadowRoot,
    nestedHost.shadowRoot,
  ]);
});

// -----------------------------------------------------------------------------
// Pattern 1 — an active password field is sufficient on its own.
// -----------------------------------------------------------------------------

test("a visible usable password field alone is a login page", () => {
  const result = detect(el("input", { type: "password" }));

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, PASSWORD_CONFIDENCE);
});

test("a password field with only reveal/cancel/close controls is still a login page", () => {
  const result = detect(
    el("form", {},
      el("input", { type: "password" }),
      el("button", { type: "button", "aria-label": "Show password" }),
      el("button", { type: "button", text: "Cancel" }),
      el("button", { type: "button", text: "Close" })
    )
  );

  assert.equal(result.isLogin, true, "the password rule must not require any action");
});

test("registration and password-change screens stay in scope through their password field", () => {
  const result = detect(
    el("form", {},
      el("h1", { text: "Create your account" }),
      el("input", { type: "password", autocomplete: "new-password" })
    )
  );

  assert.equal(result.isLogin, true);
});

test("page-authored banner ids cannot hide credential fields", () => {
  const result = detect(
    el("form", { id: "yp-banner" },
      el("input", { type: "password" })
    )
  );

  assert.equal(result.isLogin, true, "a public DOM id must never identify extension-owned content");
});

test("the extension banner's own controls do not create login evidence", () => {
  const result = detect(
    el("main", {},
      el("input", { type: "email", placeholder: "Newsletter email" })
    ),
    el("div", { id: "yp-banner", role: "status" },
      el("span", { text: "Manual analysis in progress…" }),
      el("button", { "aria-label": "Close", text: "×" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("ARIA alone cannot veto visible, natively enabled password evidence", () => {
  const variants = {
    "aria-disabled field": el("input", { type: "password", "aria-disabled": "true" }),
    "aria-hidden ancestor": el("div", { "aria-hidden": "true" },
      el("input", { type: "password" })),
  };

  for (const [label, fixture] of Object.entries(variants)) {
    assert.equal(detect(fixture).isLogin, true, label + " must not veto actual usability");
  }
});

test("a CSS-overridden hidden attribute cannot veto actually rendered password evidence", () => {
  const result = detect(
    el("input", { type: "password", hidden: true, style: { display: "block" } })
  );

  assert.equal(result.isLogin, true, "actual rendering wins over a page-authored hidden declaration");
});

test("the enabled first-legend exception of a disabled fieldset is honoured", () => {
  const firstLegend = detect(
    el("fieldset", { disabled: true },
      el("legend", {},
        el("input", { type: "password" })
      )
    )
  );
  const secondLegend = detect(
    el("fieldset", { disabled: true },
      el("legend", { text: "Settings" }),
      el("legend", {},
        el("input", { type: "password" })
      )
    )
  );

  assert.equal(firstLegend.isLogin, true, "native :disabled keeps controls in the first legend enabled");
  assert.equal(secondLegend.isLogin, false, "the exception applies only to the first legend");
});

// -----------------------------------------------------------------------------
// A password field that is not genuinely usable contributes no evidence.
// -----------------------------------------------------------------------------

test("a hidden password field never reaches the password confidence on its own", () => {
  const result = detect(
    el("div", {},
      el("input", { type: "password", rect: { width: 0, height: 0 }, style: { display: "none" } })
    )
  );

  assert.equal(result.isLogin, false);
  assert.equal(result.confidence, 0, "an unusable password field must not satisfy the password pattern");
});

test("a coherent hidden password step beside a visible identity step is a login page", () => {
  // Issue #68: a multi-step credential form keeps the password field in the
  // DOM and reveals it after the identity step. It matches the identity
  // pattern (the password input is the cue), never the password pattern.
  const result = detect(
    el("form", {},
      el("input", { type: "email", name: "email" }),
      el("input", { type: "submit", value: "Continue" }),
      el("input", {
        type: "password",
        autocomplete: "current-password",
        rect: { width: 0, height: 0 },
        style: { display: "none" },
      })
    )
  );

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE, "an unusable password field is a cue, not password evidence");
});

test("inactive password fields are excluded for every active-state reason", () => {
  const variants = {
    "natively disabled": el("input", { type: "password", disabled: true }),
    "read-only": el("input", { type: "password", readOnly: true }),
    "disabled fieldset ancestor": el("fieldset", { disabled: true }, el("input", { type: "password" })),
    "normally hidden ancestor": el("div", { hidden: true },
      el("input", { type: "password", rect: { width: 0, height: 0 } })),
    "inert ancestor": el("div", { inert: true }, el("input", { type: "password" })),
    "zero-opacity ancestor": el("div", { style: { opacity: "0" } }, el("input", { type: "password" })),
    "content-visibility hidden ancestor": el("div", { style: { contentVisibility: "hidden" } },
      el("input", { type: "password" })),
    "zero-size box": el("input", { type: "password", rect: { width: 0, height: 0 } }),
  };

  for (const [label, fixture] of Object.entries(variants)) {
    const result = detect(fixture);
    assert.equal(result.isLogin, false, `${label} must exclude the field`);
    assert.equal(result.confidence, 0, `${label} must contribute no partial evidence`);
  }
});

test("off-canvas honeypot placement is excluded but below-the-fold stays detectable", () => {
  const honeypot = detect(
    el("input", { type: "password", rect: { left: -9999, top: -9999 } })
  );
  assert.equal(honeypot.isLogin, false, "a field entirely above/left of the document is a honeypot");

  const belowTheFold = detect(
    el("form", { rect: { top: 2400 } },
      el("input", {
        type: "password",
        rect: { top: 2450 },
        style: { contentVisibility: "auto" },
      })
    )
  );
  assert.equal(belowTheFold.isLogin, true, "outside the viewport is not off-screen — scrolling never re-triggers detection");
});

// -----------------------------------------------------------------------------
// Pattern 2 — identity field + associated forward action + cue.
// -----------------------------------------------------------------------------

test("autocomplete=username with a fully localized UI is a login page", () => {
  const result = detect(
    el("form", {},
      el("h1", { text: "Connexion à votre espace" }),
      el("input", { type: "text", autocomplete: "username", name: "identifiant" }),
      el("button", { text: "Se connecter" })
    )
  );

  assert.equal(result.isLogin, true, "autocomplete=username must not require any English text");
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("a no-type username input with a local Login cue is a login page", () => {
  const result = detect(
    el("div", {},
      el("input", { name: "account" }),
      el("div", { role: "button", text: "Login" })
    )
  );

  assert.equal(result.isLogin, true);
});

test("Microsoft-style input[type=button] and input[type=image] submits are recognised", () => {
  const nextButton = detect(
    el("form", {},
      el("div", { role: "heading", "aria-level": "1", text: "Sign in" }),
      el("input", { type: "email", name: "loginfmt" }),
      el("input", { type: "button", value: "Next" })
    )
  );
  assert.equal(nextButton.isLogin, true);

  const imageSubmit = detect(
    el("form", {},
      el("input", { type: "email", name: "loginfmt" }),
      el("input", { type: "image", alt: "Sign in" })
    )
  );
  assert.equal(imageSubmit.isLogin, true);

  const imageValueIsNotAName = detect(
    el("form", {},
      el("input", { type: "email", name: "loginfmt" }),
      el("input", { type: "image", value: "Sign in" })
    )
  );
  assert.equal(imageValueIsNotAName.isLogin, false, "an image input is named by alt, not value");
});

test("controls connected through form=… associate with the field's form", () => {
  const result = detect(
    el("form", { id: "loginform" },
      el("input", { type: "text", name: "username" })
    ),
    el("button", { form: "loginform", text: "Log in" })
  );

  assert.equal(result.isLogin, true);
});

test("a field and an action in different forms never associate", () => {
  const result = detect(
    el("form", {},
      el("input", { type: "text", name: "username" }),
      el("label", { text: "Sign in" })
    ),
    el("form", {},
      el("button", { text: "Log in" })
    )
  );

  assert.equal(result.isLogin, false, "association must not fall through to a looser rule");
});

test("a native action explicitly disassociated from its containing form does not associate", () => {
  const result = detect(
    el("form", { id: "owner" },
      el("input", { name: "username" }),
      el("button", { form: "missing", text: "Log in" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("a heading outside the form but inside its enclosing dialog provides the cue", () => {
  const withDialog = detect(
    el("div", { role: "dialog" },
      el("h1", { text: "Sign in" }),
      el("form", {},
        el("input", { type: "text", name: "user" }),
        el("input", { type: "submit", value: "Continue" })
      )
    )
  );
  assert.equal(withDialog.isLogin, true);

  const withPlainCard = detect(
    el("div", { class: "card" },
      el("h1", { text: "Sign in" }),
      el("form", {},
        el("input", { type: "text", name: "user" }),
        el("input", { type: "submit", value: "Continue" })
      )
    )
  );
  assert.equal(withPlainCard.isLogin, false, "containers are never inferred from class names");
});

test("a valid login is found after an earlier newsletter candidate", () => {
  const newsletterOnly = detect(
    el("form", {},
      el("input", { type: "email", placeholder: "Email address" }),
      el("button", { text: "Subscribe" })
    )
  );
  assert.equal(newsletterOnly.isLogin, false, "email-typed fields are weak evidence on their own");

  const newsletterThenLogin = detect(
    el("form", {},
      el("input", { type: "email", placeholder: "Email address" }),
      el("button", { text: "Subscribe" })
    ),
    el("form", {},
      el("input", { type: "text", name: "username" }),
      el("button", { text: "Log in" })
    )
  );
  assert.equal(newsletterThenLogin.isLogin, true, "one failed candidate must not mask a later complete one");
});

test("an action's accessible name may come from aria-labelledby", () => {
  const result = detect(
    el("div", {},
      el("input", { name: "user" }),
      el("div", { role: "button", "aria-labelledby": "submit-label" }),
      el("span", { id: "submit-label", text: "Log in" })
    )
  );

  assert.equal(result.isLogin, true);
});

test("a native label may identify an otherwise opaque identity field", () => {
  const result = detect(
    el("form", {},
      el("h1", { text: "Sign in" }),
      el("label", { for: "opaque-field", text: "Username" }),
      el("input", { id: "opaque-field" }),
      el("button", { text: "Continue" })
    )
  );

  assert.equal(result.isLogin, true);
});

test("a wrapping native label may identify an otherwise opaque identity field", () => {
  const result = detect(
    el("form", {},
      el("h1", { text: "Sign in" }),
      el("label", { text: "Username" },
        el("input", { id: "opaque-wrapped-field" })
      ),
      el("button", { text: "Continue" })
    )
  );

  assert.equal(result.isLogin, true);
});

test("ARIA naming takes precedence over a native label", () => {
  const result = detect(
    el("form", {},
      el("label", { for: "opaque-search", text: "Username" }),
      el("input", { id: "opaque-search", "aria-label": "Search" }),
      el("button", { text: "Sign in" })
    )
  );

  assert.equal(result.isLogin, false, "the effective accessible name is Search, not Username");
});

test("role=form keeps wrapper-heavy JavaScript login controls associated", () => {
  const result = detect(
    el("div", { role: "form" },
      el("div", {},
        el("input", { autocomplete: "username" })
      ),
      el("div", {},
        el("button", { text: "Continue" })
      )
    )
  );

  assert.equal(result.isLogin, true);
});

// -----------------------------------------------------------------------------
// Negative space — what must NOT count.
// -----------------------------------------------------------------------------

test("a search box next to a header sign-in button is not a login page", () => {
  const result = detect(
    el("div", {},
      el("input", { type: "text", name: "q", placeholder: "Search" }),
      el("div", { role: "button", text: "Sign in" })
    )
  );

  assert.equal(result.isLogin, false, "an identity-like field is required, not just any text input");
});

test("an account-related text search cannot borrow a header Sign in action", () => {
  const result = detect(
    el("header", {},
      el("input", { type: "text", "aria-label": "Search accounts" }),
      el("button", { type: "button", text: "Sign in" })
    )
  );

  assert.equal(result.isLogin, false, "search semantics must win over the account identity hint");
});

test("a newsletter field and header sign-in button do not associate across an application shell", () => {
  const result = detect(
    el("div", { id: "app" },
      el("header", {},
        el("button", { type: "button", text: "Sign in" })
      ),
      el("footer", {},
        el("input", { type: "email", placeholder: "Email address" })
      )
    )
  );

  assert.equal(result.isLogin, false, "form-less association is intentionally limited to one immediate parent");
});

test("a form-less multi-step credential page is detected through its wrapper", () => {
  // Issue #68: no <form>, no dialog, each control in its own wrapper div, the
  // password step hidden until the identity step is submitted, and the only
  // "Sign In" text on a control that is not rendered yet.
  const result = detect(
    el("div", { class: "form-container" },
      el("div", { class: "form-input-container" },
        el("input", { type: "email", name: "username", placeholder: "Enter email" })
      ),
      el("div", { class: "form-input-container", style: { display: "none" } },
        el("input", { type: "password", name: "pr", rect: { width: 0, height: 0 } }),
        el("button", { type: "button", text: "Sign In", rect: { width: 0, height: 0 } })
      ),
      el("div", { class: "form-input-container" },
        el("button", { type: "button", text: "Next" })
      )
    )
  );

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("a form-less multi-step credential page allows separate email-step wrappers", () => {
  // The shared step container is the fourth ancestor of the email field:
  // input-wrapper -> form-group -> email step -> shared step container.
  const result = detect(
    el("main", {},
      el("div", { class: "step-content" },
        el("div", { id: "stepEmail" },
          el("div", { class: "form-group" },
            el("div", { class: "input-wrapper" },
              el("input", { type: "email", autocomplete: "email", placeholder: "you@example.com" })
            )
          ),
          el("button", { text: "Continue" })
        ),
        el("div", { id: "stepPassword", style: { display: "none" } },
          el("input", {
            type: "password",
            autocomplete: "current-password",
            rect: { width: 0, height: 0 },
          }),
          el("button", { text: "Sign In", rect: { width: 0, height: 0 } })
        )
      )
    )
  );

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

// -----------------------------------------------------------------------------
// Issue #5 — deeply nested, form-less, identifier-first multi-step flows.
//
// The identity step is shown while the forward action and the still-hidden
// password step sit in separate, deeply nested wrapper trees whose nearest
// shared ancestor is far beyond LOCAL_ASSOCIATION_MAX_DEPTH. Google's first
// sign-in step is one such page. The fixtures use no host, id, class-name or
// exact-depth checks and no <form>/dialog container.
// -----------------------------------------------------------------------------

test("a deeply nested form-less identifier-first credential page is detected", () => {
  // The three steps are ~7 ancestors above the identity field, well past the
  // shallow four-level reach. The password step is present but hidden, exactly
  // as a first sign-in step keeps its later password view in the DOM.
  const flow = el("div", {},
    nest(6,
      el("label", { for: "identifier", text: "Email or phone" }),
      el("input", {
        id: "identifier",
        type: "text",
        name: "identifier",
        autocomplete: "username webauthn",
      })
    ),
    nest(6, el("button", { type: "button", text: "Next" })),
    nest(6, el("div", { style: { display: "none" } },
      el("input", {
        type: "password",
        autocomplete: "current-password",
        rect: { width: 0, height: 0 },
      })
    ))
  );
  const result = detect(el("main", {}, flow));

  assert.equal(result.isLogin, true, "the identifier stage of a form-less multi-step flow must match");
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("extra neutral wrappers do not change the deep form-less positive result", () => {
  // Same page, only more meaningless nesting between the steps and the shared
  // container. Depth is not a signal, so the result must not move.
  const flow = el("div", {},
    nest(11,
      el("input", {
        type: "text",
        name: "identifier",
        autocomplete: "username webauthn",
        "aria-label": "Email or phone",
      })
    ),
    nest(9, el("button", { type: "button", text: "Next" })),
    nest(13, el("div", { style: { display: "none" } },
      el("input", { type: "password", autocomplete: "current-password", rect: { width: 0, height: 0 } })
    ))
  );
  const result = detect(el("main", {}, el("div", {}, el("div", {}, flow))));

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("a non-current-password step is coherent only through evidence local to it", () => {
  // No autocomplete=current-password: the later step qualifies only because a
  // "Sign in" control sits right beside the password input, not merely
  // somewhere in the broad flow container.
  const flow = el("div", {},
    nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username" })),
    nest(6, el("button", { type: "button", text: "Next" })),
    nest(6, el("div", { style: { display: "none" } },
      el("input", { type: "password", name: "pass", rect: { width: 0, height: 0 } }),
      el("button", { type: "button", text: "Sign in", rect: { width: 0, height: 0 } })
    ))
  );
  const result = detect(el("main", {}, flow));

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("a distant auth cue does not make a non-current-password step coherent", () => {
  // The password input carries no current-password token and no auth evidence
  // in its own locality; the only "Sign in" text is a heading in a separate
  // subtree, merely somewhere in the broad flow container. That is not enough.
  const flow = el("div", {},
    nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username" })),
    nest(6, el("button", { type: "button", text: "Next" })),
    nest(6, el("div", { style: { display: "none" } },
      el("input", { type: "password", name: "pass", rect: { width: 0, height: 0 } })
    )),
    nest(6, el("h1", { text: "Sign in" }))
  );
  const result = detect(el("main", {}, flow));

  assert.equal(result.isLogin, false);
});

test("a lone deeply nested username field and Next action without a password step do not match", () => {
  // The deep fallback is for multi-step credential flows, not for any form-less
  // username field that happens to be followed by a distant forward button.
  const flow = el("div", {},
    nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username" })),
    nest(6, el("button", { type: "button", text: "Next" }))
  );
  const result = detect(el("main", {}, flow));

  assert.equal(result.isLogin, false, "no coherent password step means no deep association");
});

test("merely sharing a broad <main> does not associate otherwise unrelated controls", () => {
  // Structurally comparable to the positive fixture, but with no flow container
  // below <main>: identity field, Next action and password step are three
  // separate subtrees whose only shared ancestor is the landmark itself.
  const result = detect(
    el("main", {},
      nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username webauthn" })),
      nest(6, el("button", { type: "button", text: "Next" })),
      nest(6, el("div", { style: { display: "none" } },
        el("input", { type: "password", autocomplete: "current-password", rect: { width: 0, height: 0 } })
      ))
    )
  );

  assert.equal(result.isLogin, false, "a landmark bounds the search but is never itself the association");
});

test("an autocomplete=username profile field borrows no unrelated action or password in the same <main>", () => {
  // A settings screen: the username field and an unrelated widget carrying a
  // Continue button and a current-password input live in different branches of
  // one <main>. They must never combine into a credential flow.
  const result = detect(
    el("main", {},
      nest(6, el("input", { type: "text", name: "username", autocomplete: "username" })),
      nest(4,
        el("button", { type: "button", text: "Continue" }),
        el("input", { type: "password", autocomplete: "current-password", rect: { width: 0, height: 0 } })
      )
    )
  );

  assert.equal(result.isLogin, false);
});

test("neutral wrappers do not let profile controls bypass the <main> association boundary", () => {
  const result = detect(
    el("main", {},
      el("div", {},
        nest(6,
          el("input", {
            type: "text",
            autocomplete: "username",
            "aria-label": "Profile username",
          })
        ),
        nest(6, el("button", { type: "button", text: "Continue" })),
        nest(6,
          el("input", {
            type: "password",
            autocomplete: "current-password",
            rect: { width: 0, height: 0 },
          })
        )
      )
    )
  );

  assert.equal(result.isLogin, false, "a broad wrapper is not credential-flow evidence");
});

test("a wrapped unrelated Continue/password widget cannot be adopted by a profile username", () => {
  const result = detect(
    el("main", {},
      el("div", {},
        nest(6, el("input", { type: "text", name: "username", autocomplete: "username" })),
        nest(4,
          el("button", { type: "button", text: "Continue" }),
          el("input", {
            type: "password",
            autocomplete: "current-password",
            rect: { width: 0, height: 0 },
          })
        )
      )
    )
  );

  assert.equal(result.isLogin, false, "a separate local widget is not the username field's credential flow");
});

test("the deep fallback refuses a forward action owned by a different native form", () => {
  const result = detect(
    el("main", {},
      el("div", {},
        nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username" })),
        nest(6, el("div", { style: { display: "none" } },
          el("input", { type: "password", autocomplete: "current-password", rect: { width: 0, height: 0 } })
        )),
        nest(4, el("form", {}, el("button", { text: "Next" })))
      )
    )
  );

  assert.equal(result.isLogin, false, "a form-less field cannot borrow an action owned by another form");
});

test("the deep fallback refuses a forward action inside a separate dialog region", () => {
  const result = detect(
    el("main", {},
      el("div", {},
        nest(6, el("input", { type: "text", name: "identifier", autocomplete: "username" })),
        nest(6, el("div", { style: { display: "none" } },
          el("input", { type: "password", autocomplete: "current-password", rect: { width: 0, height: 0 } })
        )),
        nest(4, el("div", { role: "dialog" }, el("button", { type: "button", text: "Next" })))
      )
    )
  );

  assert.equal(result.isLogin, false, "controls in separate dialog-like regions cannot associate");
});

test("a deeply nested newsletter email field borrows no distant action or honeypot password", () => {
  // No autocomplete=username token anywhere, so the deep fallback is never even
  // entered: a plain email field plus a distant Next and a hidden password
  // honeypot is not a credential flow.
  const result = detect(
    el("main", {},
      nest(6, el("input", { type: "email", placeholder: "Email address" })),
      nest(6, el("button", { type: "button", text: "Next" })),
      nest(6, el("div", { style: { display: "none" } },
        el("input", { type: "password", name: "hp", rect: { width: 0, height: 0 } })
      ))
    )
  );

  assert.equal(result.isLogin, false);
});

test("a newsletter form with a hidden password honeypot is not a login page", () => {
  const result = detect(
    el("form", {},
      el("label", { text: "Newsletter" },
        el("input", { type: "email", name: "email" })
      ),
      el("input", {
        type: "password",
        name: "password_confirmation",
        rect: { width: 0, height: 0 },
        style: { display: "none" },
      }),
      el("button", { type: "submit", text: "Subscribe" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("plain wrapper divs do not broaden form-less association", () => {
  const result = detect(
    el("div", { class: "card" },
      el("div", {},
        el("input", { type: "email" })
      ),
      el("div", {},
        el("button", { type: "button", text: "Sign in" })
      )
    )
  );

  assert.equal(result.isLogin, false, "use a form, dialog, role=form, or local siblings for automatic detection");
});

test("a form-less submit-looking Close button is not a forward action", () => {
  const result = detect(
    el("div", {},
      el("h1", { text: "Sign in" }),
      el("input", { type: "email" }),
      el("button", { text: "Close" })
    )
  );

  assert.equal(result.isLogin, false, "without a form owner, a default button must have a forward name");
});

test("reveal, cancel, help and reset controls are not forward actions", () => {
  const result = detect(
    el("form", {},
      el("label", { text: "Sign in to your account" }),
      el("input", { type: "text", name: "username" }),
      el("button", { type: "button", "aria-label": "Show password" }),
      el("button", { type: "button", text: "Cancel" }),
      el("button", { type: "button", text: "Help" }),
      el("button", { type: "reset", text: "Reset" })
    )
  );

  assert.equal(result.isLogin, false, "a cue without any forward action must not match");
});

test("a plain navigation Sign in link is neither an action nor a cue", () => {
  const result = detect(
    el("div", {},
      el("input", { type: "email", name: "email" }),
      el("a", { href: "/signin", text: "Sign in" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("an input's own name/id/placeholder never satisfy the authentication cue", () => {
  // The field identifies itself as identity-like via name/placeholder, but
  // those same attributes must not double as the separate cue.
  const result = detect(
    el("div", {},
      el("input", { type: "text", name: "login", placeholder: "Your login" }),
      el("button", { type: "button", text: "Next" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("a text input's value is user data, not an accessible identity name", () => {
  const result = detect(
    el("div", {},
      el("input", { type: "text", value: "user@example.test" }),
      el("button", { type: "button", text: "Sign in" })
    )
  );

  assert.equal(result.isLogin, false);
});

test("actions and cues inside inert or hidden containers are ignored", () => {
  const result = detect(
    el("div", { inert: true },
      el("h1", { text: "Sign in" }),
      el("input", { type: "text", name: "username" }),
      el("button", { text: "Log in" })
    )
  );

  assert.equal(result.isLogin, false);
});

// -----------------------------------------------------------------------------
// Confidence contract — fixed values, no partial evidence.
// -----------------------------------------------------------------------------

test("confidence is fixed per pattern, finite, within [0,1], and consistent with the threshold", () => {
  const password = detect(el("input", { type: "password" }));
  const identity = detect(
    el("form", {},
      el("input", { type: "text", autocomplete: "username" }),
      el("button", { text: "Log in" })
    )
  );
  const blank = detect(el("p", { text: "Just an article." }));

  for (const result of [password, identity, blank]) {
    assert.equal(Number.isFinite(result.confidence), true);
    assert.equal(result.confidence >= 0 && result.confidence <= 1, true);
    assert.equal(result.isLogin, result.confidence >= LOGIN_THRESHOLD);
  }
  assert.equal(password.confidence, PASSWORD_CONFIDENCE);
  assert.equal(identity.confidence, IDENTITY_CONFIDENCE);
  assert.equal(blank.confidence, 0);
  assert.ok(PASSWORD_CONFIDENCE >= LOGIN_THRESHOLD);
  assert.ok(IDENTITY_CONFIDENCE >= LOGIN_THRESHOLD);
});

test("the shared mutation dependency list covers every attribute-derived signal", () => {
  const required = [
    "inert", "readonly", "type", "autocomplete", "form", "role",
    "aria-label", "aria-labelledby", "name", "id", "placeholder",
    "value", "alt", "for",
  ];

  assert.deepEqual([...DETECTION_ATTRIBUTES], required);
  assert.equal(Object.isFrozen(DETECTION_ATTRIBUTES), true);
});

test("the shared visual attribute list stays beside the detector it belongs to", () => {
  const required = [
    "class", "style", "hidden", "aria-hidden", "aria-disabled", "aria-modal",
    "open", "disabled", "src", "width", "height",
  ];

  assert.deepEqual([...VISUAL_ATTRIBUTES], required);
  assert.equal(Object.isFrozen(VISUAL_ATTRIBUTES), true);
});

// -----------------------------------------------------------------------------
// Shadow DOM — issue #88. The candidate walk covers open roots; closed roots
// stay unsupported and must never throw.
// -----------------------------------------------------------------------------

test("a credential form rendered inside an open Shadow root is a login page", () => {
  const result = detect(
    el("div", {
      shadow: [
        el("form", {},
          el("h2", { text: "Sign in" }),
          el("input", { type: "email", name: "email" }),
          el("input", { type: "password", name: "password" }),
          el("button", { type: "submit", text: "Next" })
        ),
      ],
    })
  );

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, PASSWORD_CONFIDENCE);
});

test("nested open Shadow roots are traversed", () => {
  const result = detect(
    el("div", {
      shadow: [
        el("section", {},
          el("div", { shadow: [el("input", { type: "password" })] })
        ),
      ],
    })
  );

  assert.equal(result.isLogin, true, "a root inside a root is reached by the same walk");
});

test("the identity pattern resolves aria-labelledby inside the element's own root", () => {
  // A same-id heading in the document would resolve to unrelated text: ids
  // inside a Shadow root are scoped to that root, and document.getElementById
  // can neither see the real one nor be allowed to answer with the decoy.
  const result = detect(
    el("h2", { id: "title", text: "Newsletter" }),
    el("div", {
      shadow: [
        el("h2", { id: "title", text: "Sign in" }),
        el("div", {},
          el("input", { type: "email", name: "email" }),
          el("button", { type: "button", "aria-labelledby": "title" })
        ),
      ],
    })
  );

  assert.equal(result.isLogin, true);
  assert.equal(result.confidence, IDENTITY_CONFIDENCE);
});

test("a closed Shadow root is neither readable nor a source of errors", () => {
  const result = detect(
    el("div", { closedShadow: [el("input", { type: "password" })] }),
    el("p", { text: "Nothing else on this page." })
  );

  assert.equal(result.isLogin, false, "a closed root is not readable, so it stays unsupported");
});

test("a Shadow host's own rendered state still governs the form it renders", () => {
  const result = detect(
    el("div", {
      style: { opacity: "0" },
      shadow: [el("input", { type: "password" })],
    })
  );

  assert.equal(result.isLogin, false, "ancestor state inherits through the host into the root");
});
