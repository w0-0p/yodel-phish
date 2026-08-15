// Shared login-page detector (issue #11).
//
// Fixed patterns replace the old additive score. Each complete pattern carries
// a fixed confidence, the highest matched value is returned, and partial
// evidence is never summed across candidates or regions:
//
//   1. An ACTIVE password field                                → 0.9
//   2. An ACTIVE identity field
//      + an ASSOCIATED forward action
//      + (autocomplete contains "username" OR a local auth cue
//         OR a coherent hidden password step)                  → 0.7
//
// ACTIVE means the user could really type into or click the element right
// now: not natively disabled (including the browser's exact <fieldset> /
// <legend> semantics), not readOnly, no inert ancestor, a non-zero box, not
// visibility-hidden or content-visibility-hidden, no zero-opacity ancestor,
// and not placed entirely above or left of the document (off-canvas
// honeypots). Being outside the current viewport is deliberately NOT
// "off-screen": below-the-fold forms must stay detectable because scrolling
// never re-triggers detection.
//
// ARIA and hidden attributes describe intended state but do not by themselves
// prove the rendered result: author CSS can override hidden, while ARIA never
// enforces rendering or interaction. They therefore never veto evidence from
// an otherwise rendered, natively enabled control. Page-authored declarations
// must not become one-attribute detector bypasses.
//
// ASSOCIATION between a field and an action is decided in a fixed order based
// on the field's own context, with no fallback once a context applies:
//   1. The field has a form owner F (via ancestry or form="…"): the action
//      must share F, or be a non-form-associated element (e.g. a
//      [role="button"] div) inside F.
//   2. Otherwise, the field has a closest dialog-like ancestor (<dialog>,
//      [role="dialog"], [role="form"], [aria-modal="true"]): the action's
//      closest dialog-like ancestor must be the same element.
//   3. Otherwise, field and action must share one immediate parent — or a
//      wrapper within a few levels that also contains a coherent hidden
//      password step, which is how a form-less multi-step credential page is
//      laid out. The walk is
//      bounded and stops at <body>, so a newsletter field still cannot borrow
//      a header button elsewhere in a shared application shell.
//   4. A separate, constrained deep fallback (issue #5) reaches past that few-
//      level limit for form-less multi-step flows whose identity step, forward
//      action and still-hidden password step sit in deeply nested, separate
//      wrapper trees (Google's first sign-in step is one). It is entered only
//      by an active, form-less, dialog-less field with the standardized
//      username token, and only associates through the smallest shared ancestor
//      that holds a compatible forward action and a coherent password step. A
//      <main>/application landmark may bound the search but is never that
//      ancestor: sharing only a broad <main> or <body> is never an association.
// Modal or application containers are never inferred from class names or ids.
//
// The candidate walk covers open Shadow roots as well as the light DOM (issue
// #88). Closed roots are not readable and remain unsupported. Documents inside
// iframes are out of scope here by construction: each frame runs its own copy
// of this detector (see content/login-frame.js).
//
// This file deliberately supports both environments in which it runs:
// - as a classic content script, where it exposes an immutable isolated-world
//   global consumed by content.js; and
// - as a CommonJS dependency of the Node test suite, where detectLoginPage is
//   exercised directly against small DOM fixtures.
(function attachLoginDetector(root, factory) {
  const detector = Object.freeze(factory());
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = detector;
    return;
  }
  if (root !== null && typeof root === "object" && !("YodelLoginDetector" in root)) {
    Object.defineProperty(root, "YodelLoginDetector", {
      value: detector,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
})(typeof globalThis === "object" ? globalThis : null, function createLoginDetector() {
  const LOGIN_THRESHOLD = 0.5;
  const PASSWORD_CONFIDENCE = 0.9;
  const IDENTITY_CONFIDENCE = 0.7;
  // How far the form-less/dialog-less association fallback may walk up from
  // the identity field before giving up (see ASSOCIATION rule 3 above).
  const LOCAL_ASSOCIATION_MAX_DEPTH = 4;
  // Kept beside the detector dependencies and consumed by content.js and the
  // child-frame watcher (login-frame.js), so a new attribute signal cannot
  // silently drift away from mutation handling.
  const DETECTION_ATTRIBUTES = Object.freeze([
    "inert", "readonly", "type", "autocomplete", "form", "role",
    "aria-label", "aria-labelledby", "name", "id", "placeholder",
    "value", "alt", "for",
  ]);
  // Attributes that change what is rendered without changing any detector
  // metadata: a form revealed by a class, style, hidden or dialog-state change
  // must still schedule a new evaluation. Kept here for the same reason.
  const VISUAL_ATTRIBUTES = Object.freeze([
    "class", "style", "hidden", "aria-hidden", "aria-disabled", "aria-modal",
    "open", "disabled", "src", "width", "height",
  ]);

  // The auth cue is deliberately only these three terms; localized pages are
  // supported through autocomplete="username", not through translated text.
  const AUTH_CUE_RE = /\b(?:sign[\s-]?in|log[\s-]?in|login)\b/;
  // Names that make a generic button a forward/authentication action. Reveal,
  // Cancel, Close, Help and Reset controls never match.
  const FORWARD_ACTION_RE = /\b(?:sign[\s-]?in|log[\s-]?in|login|next|continue|submit|verify)\b/;
  // Identifies an identity-like field from its own metadata. These attributes
  // must never also satisfy the separate authentication-cue requirement.
  const IDENTITY_HINT_RE = /user|e[\s-]?mail|account|log[\s-]?in|login|sign[\s-]?in|phone|mobile|member/;
  // Explicit search semantics outrank otherwise ambiguous identity words such
  // as "account". Profile/settings cues are used only by the deep fallback:
  // shallow form and dialog association remains authoritative for real
  // reauthentication controls embedded in settings pages.
  const SEARCH_HINT_RE = /\bsearch\b|(?:^|_)search(?:_|$)/;
  const NON_CREDENTIAL_ACCOUNT_CONTEXT_RE =
    /\b(?:profile|settings|preferences)\b|(?:^|_)(?:profile|settings|preferences)(?:_|$)/;

  const KNOWN_INPUT_TYPES = new Set([
    "button", "checkbox", "color", "date", "datetime-local", "email", "file",
    "hidden", "image", "month", "number", "password", "radio", "range",
    "reset", "search", "submit", "tel", "text", "time", "url", "week",
  ]);
  // search/url/number are deliberately absent: a site-search box next to a
  // "Sign in" header button must not look like a login form.
  const IDENTITY_INPUT_TYPES = new Set(["text", "email", "tel"]);
  const SKIP_TAGS = new Set(["script", "style", "link", "meta", "noscript", "template"]);
  // Visible cue text is read only from elements that name or label things.
  // Plain <a> links are excluded: a navigation "Sign in" link appears on
  // pages that request no credentials at all.
  const CUE_TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "label", "legend", "button"]);
  const FORM_ASSOCIATED_TAGS = new Set(["input", "button", "select", "textarea", "output", "fieldset", "object"]);

  function tagOf(el) {
    return typeof el?.tagName === "string" ? el.tagName.toLowerCase() : "";
  }

  function getAttr(el, name) {
    return typeof el?.getAttribute === "function" ? el.getAttribute(name) : null;
  }

  function normalize(text) {
    return String(text ?? "").toLowerCase().replace(/\s+/g, " ");
  }

  function tokensOf(el, attribute) {
    return (getAttr(el, attribute) ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function inputType(el) {
    const raw = (getAttr(el, "type") ?? "").toLowerCase();
    // Missing and unrecognized types behave as text inputs.
    return KNOWN_INPUT_TYPES.has(raw) ? raw : "text";
  }

  // ---------------------------------------------------------------------------
  // Candidate collection — one bounded walk from <body>.
  //
  // The walk descends into open Shadow roots as part of the same traversal: a
  // credential form rendered inside a custom element is still a credential
  // form (issue #88). Nested open roots need no special case — every root's
  // own elements are pushed exactly like light-DOM children. A closed root
  // reports `shadowRoot === null`, so a closed tree is simply never visited
  // and can never throw.
  // ---------------------------------------------------------------------------

  function collectOpenShadowRoots(doc) {
    const roots = [];
    const stack = doc?.body ? [doc.body] : [];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.children ?? []) {
        const shadow = child.shadowRoot;
        if (shadow !== null && shadow !== undefined) {
          roots.push(shadow);
          stack.push(shadow);
        }
        stack.push(child);
      }
    }
    return roots;
  }

  function collectCandidates(doc) {
    const inputs = [];
    const actionCandidates = [];
    const cueCandidates = [];
    const stack = doc?.body ? [doc.body] : [];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.children ?? []) {
        const tag = tagOf(child);
        if (SKIP_TAGS.has(tag)) continue;
        stack.push(child);
        if (child.shadowRoot !== null && child.shadowRoot !== undefined) {
          stack.push(child.shadowRoot);
        }

        const roles = tokensOf(child, "role");
        if (tag === "input") inputs.push(child);
        if (tag === "button" || tag === "input" || roles.includes("button")) {
          actionCandidates.push(child);
        }
        if (
          CUE_TEXT_TAGS.has(tag) ||
          roles.includes("heading") ||
          roles.includes("button") ||
          tag === "img" ||
          (tag === "input" && ["submit", "button", "image"].includes(inputType(child))) ||
          getAttr(child, "aria-label") !== null ||
          getAttr(child, "aria-labelledby") !== null
        ) {
          cueCandidates.push(child);
        }
      }
    }
    return { inputs, actionCandidates, cueCandidates };
  }

  // ---------------------------------------------------------------------------
  // Active-state checks.
  // ---------------------------------------------------------------------------

  // Climbs out of an open Shadow root through its host, so state that really
  // does inherit through the flattened tree — inert, zero opacity, hidden
  // content-visibility — is still enforced for elements rendered inside one.
  // Containment (isWithin, dialogAncestor, the local association walk)
  // deliberately does NOT use this: association must stay inside one node
  // tree, so a light-DOM header button can never adopt a Shadow-DOM field.
  function renderingAncestor(el) {
    if (el.parentElement !== null && el.parentElement !== undefined) return el.parentElement;
    return el.parentNode?.host ?? null;
  }

  function isRendered(el, ctx) {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;

    // Off-document, not off-viewport: a document cannot scroll to negative
    // coordinates, so a box entirely above or left of the document origin is a
    // honeypot placement. Below-the-fold content stays detectable.
    const scrollX = Number(ctx.win.scrollX) || 0;
    const scrollY = Number(ctx.win.scrollY) || 0;
    if (rect.left + rect.width + scrollX <= 0) return false;
    if (rect.top + rect.height + scrollY <= 0) return false;

    // Computed visibility inherits, and a display:none ancestor already
    // yields a zero-size box, so both are element-level checks. Opacity does
    // not inherit into computed style, so it needs the ancestor walk below.
    const style = ctx.win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;

    for (let cur = el; cur !== null && cur !== undefined; cur = renderingAncestor(cur)) {
      const curStyle = cur === el ? style : ctx.win.getComputedStyle(cur);
      if (cur.inert === true || getAttr(cur, "inert") !== null) return false;
      // content-visibility:hidden (including hidden="until-found" in Chrome)
      // can retain non-zero layout geometry while skipping the subtree's
      // rendering, so rectangle checks alone are insufficient.
      if (curStyle.contentVisibility === "hidden") return false;
      if (Number.parseFloat(curStyle.opacity) === 0) return false;
    }
    return true;
  }

  function isActiveControl(el, ctx) {
    // :disabled is the browser's authoritative answer. In particular, it
    // handles disabled-fieldset inheritance, the first-legend exception, and
    // the fact that a [role=button] div is not disabled by a fieldset.
    if (el.matches(":disabled")) return false;
    return isRendered(el, ctx);
  }

  function isActiveField(el, ctx) {
    if (el.readOnly === true || getAttr(el, "readonly") !== null) return false;
    return isActiveControl(el, ctx);
  }

  // ---------------------------------------------------------------------------
  // Accessible names and cue text.
  // ---------------------------------------------------------------------------

  function imgAltText(el) {
    const parts = [];
    const stack = [el];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.children ?? []) {
        if (tagOf(child) === "img") parts.push(getAttr(child, "alt") ?? "");
        stack.push(child);
      }
    }
    return parts.join(" ");
  }

  // aria-labelledby resolves in the element's own node tree: ids inside a
  // Shadow root are scoped to that root and are invisible to
  // document.getElementById.
  function ownerRoot(el, ctx) {
    const root = typeof el?.getRootNode === "function" ? el.getRootNode() : null;
    return typeof root?.getElementById === "function" ? root : ctx.doc;
  }

  function labelledbyText(el, ctx) {
    const references = tokensOf(el, "aria-labelledby");
    if (references.length === 0) return "";
    const root = ownerRoot(el, ctx);
    if (typeof root?.getElementById !== "function") return "";
    return references
      .map((id) => root.getElementById(id)?.textContent ?? "")
      .join(" ");
  }

  function nativeLabelText(el) {
    return Array.from(el?.labels ?? [])
      .map((label) => label?.textContent ?? "")
      .join(" ");
  }

  function accessibleName(el, ctx) {
    const fromLabelledby = labelledbyText(el, ctx);
    if (fromLabelledby.trim() !== "") return fromLabelledby;
    const ariaLabel = getAttr(el, "aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel;
    const fromNativeLabels = nativeLabelText(el);
    if (fromNativeLabels.trim() !== "") return fromNativeLabels;
    if (tagOf(el) === "input") {
      const type = inputType(el);
      if (type === "image") {
        const alt = getAttr(el, "alt");
        if (alt !== null && alt.trim() !== "") return alt;
      }
      // Only button-like inputs derive their accessible name from value. A
      // text field's value is user data, not its accessible name.
      if (type === "submit" || type === "button" || type === "reset") {
        return getAttr(el, "value") ?? "";
      }
      return "";
    }
    return `${el.textContent ?? ""} ${imgAltText(el)}`;
  }

  // Text a cue candidate contributes: its accessible naming, plus rendered
  // text only for elements whose text names things (headings, labels,
  // buttons). Input name/id/placeholder never feed the cue.
  function cueText(el, ctx) {
    const parts = [labelledbyText(el, ctx), getAttr(el, "aria-label") ?? ""];
    const tag = tagOf(el);
    const roles = tokensOf(el, "role");
    if (CUE_TEXT_TAGS.has(tag) || roles.includes("heading") || roles.includes("button")) {
      parts.push(el.textContent ?? "", imgAltText(el));
    } else if (tag === "img") {
      parts.push(getAttr(el, "alt") ?? "");
    } else if (tag === "input") {
      const type = inputType(el);
      if (type === "submit" || type === "button") parts.push(getAttr(el, "value") ?? "");
      if (type === "image") parts.push(getAttr(el, "alt") ?? "");
    }
    return parts.join(" ");
  }

  function isWithin(el, container) {
    for (let cur = el; cur !== null && cur !== undefined; cur = cur.parentElement) {
      if (cur === container) return true;
    }
    return false;
  }

  function containerHasAuthCue(container, cueCandidates, ctx) {
    return cueCandidates.some(
      (el) =>
        isWithin(el, container) &&
        isRendered(el, ctx) &&
        AUTH_CUE_RE.test(normalize(cueText(el, ctx)))
    );
  }

  // ---------------------------------------------------------------------------
  // Actions.
  // ---------------------------------------------------------------------------

  // "native": a real submit control with a form owner, which qualifies as a
  // forward action directly.
  // "named": only qualifies with a small forward/authentication name. This
  // includes submit-looking controls with no form owner: without a form they
  // have no native submission behavior, and "Close" must not become forward.
  // null: never a forward action (reset controls, ordinary inputs, links).
  function actionKind(el) {
    const tag = tagOf(el);
    const submitKind = formOwner(el) === null ? "named" : "native";
    if (tag === "input") {
      const type = inputType(el);
      if (type === "submit" || type === "image") return submitKind;
      if (type === "button") return "named";
      return null;
    }
    if (tag === "button") {
      const type = (getAttr(el, "type") ?? "").toLowerCase();
      if (type === "reset") return null;
      if (type === "button") return "named";
      return submitKind; // missing or invalid type defaults to submit
    }
    if (tokensOf(el, "role").includes("button")) return "named";
    return null;
  }

  function isForwardAction(el, ctx) {
    const kind = actionKind(el);
    if (kind === null) return false;
    if (!isActiveControl(el, ctx)) return false;
    if (kind === "native") return true;
    return FORWARD_ACTION_RE.test(normalize(accessibleName(el, ctx)));
  }

  // ---------------------------------------------------------------------------
  // Association.
  // ---------------------------------------------------------------------------

  function isFormAssociated(el) {
    return FORM_ASSOCIATED_TAGS.has(tagOf(el));
  }

  function formOwner(el) {
    // Native form ownership covers ancestry, form="...", duplicate-id rules,
    // and parser edge cases more accurately and with less code than recreating
    // the HTML algorithm here.
    return isFormAssociated(el) ? (el.form ?? null) : null;
  }

  function isDialogContainer(el) {
    if (tagOf(el) === "dialog") return true;
    if (getAttr(el, "aria-modal") === "true") return true;
    const roles = tokensOf(el, "role");
    return roles.includes("dialog") || roles.includes("form");
  }

  function dialogAncestor(el) {
    for (let cur = el.parentElement; cur !== null && cur !== undefined; cur = cur.parentElement) {
      if (isDialogContainer(cur)) return cur;
    }
    return null;
  }

  function actionsCarryAuthCue(actions, ctx) {
    return actions.some((el) => AUTH_CUE_RE.test(normalize(accessibleName(el, ctx))));
  }

  function isPotentialPasswordStep(el) {
    if (inputType(el) !== "password" || el.readOnly === true || getAttr(el, "readonly") !== null) return false;
    if (el.matches(":disabled")) return false;
    for (let cur = el; cur !== null && cur !== undefined; cur = renderingAncestor(cur)) {
      if (cur.inert === true || getAttr(cur, "inert") !== null) return false;
    }
    return true;
  }

  // A hidden password input alone is too weak: newsletter and signup forms may
  // carry inactive password honeypots. Count it only when standardized as the
  // current-password step or paired with an auth-named control in the same
  // bounded container.
  function containerHasPasswordStep(container, inputs, actionCandidates, ctx) {
    const passwords = inputs.filter(
      (el) => isWithin(el, container) && isPotentialPasswordStep(el)
    );
    if (passwords.length === 0) return false;
    if (passwords.some((el) => tokensOf(el, "autocomplete").includes("current-password"))) return true;
    return actionCandidates.some(
      (el) =>
        isWithin(el, container) &&
        actionKind(el) !== null &&
        AUTH_CUE_RE.test(normalize(accessibleName(el, ctx)))
    );
  }

  // A <main> or an application landmark may frame a credential flow, so the deep
  // fallback below may search up to one. A landmark is page structure, not
  // authentication evidence, so it only ever bounds the walk: sharing nothing
  // but a broad <main> (or <body>) must never associate unrelated controls.
  function isApplicationLandmark(el) {
    if (tagOf(el) === "main") return true;
    const roles = tokensOf(el, "role");
    return roles.includes("main") || roles.includes("application");
  }

  // A password input is a coherent later step of a form-less multi-step flow
  // when it is standardized as the current-password field, or when
  // password-stage evidence sits in its own locality — an auth cue or
  // auth-named control within a few ancestors of the input, not merely
  // somewhere in the broad flow container. The input may be hidden (its step is
  // not shown yet) but must be otherwise usable, and must not sit behind a form
  // or dialog boundary the identity field is not part of.
  function isCoherentPasswordStep(pw, actionCandidates, cueCandidates, ctx) {
    if (!isPotentialPasswordStep(pw)) return false;
    if (formOwner(pw) !== null || dialogAncestor(pw) !== null) return false;
    if (tokensOf(pw, "autocomplete").includes("current-password")) return true;
    let local = pw.parentElement;
    for (let depth = 0; depth < LOCAL_ASSOCIATION_MAX_DEPTH; depth += 1) {
      if (
        local === null ||
        local === ctx.doc.body ||
        local === ctx.doc.documentElement ||
        isApplicationLandmark(local)
      ) return false;
      const authNamedAction = actionCandidates.some(
        (el) =>
          isWithin(el, local) &&
          actionKind(el) !== null &&
          AUTH_CUE_RE.test(normalize(accessibleName(el, ctx)))
      );
      if (authNamedAction || containerHasAuthCue(local, cueCandidates, ctx)) return true;
      local = local.parentElement;
    }
    return false;
  }

  // The deep fallback must not reinterpret a profile/settings control as an
  // identifier step merely because distant account controls share a wrapper.
  // This veto is intentionally local and deep-only: normal form/dialog/shallow
  // login association has already had priority before the fallback is reached.
  function hasLocalNonCredentialAccountContext(field, cueCandidates, ctx) {
    if (NON_CREDENTIAL_ACCOUNT_CONTEXT_RE.test(fieldMetadata(field, ctx))) return true;
    let local = field.parentElement;
    for (let depth = 0; depth < LOCAL_ASSOCIATION_MAX_DEPTH; depth += 1) {
      if (
        local === null ||
        local === ctx.doc.body ||
        local === ctx.doc.documentElement ||
        isApplicationLandmark(local)
      ) return false;
      const hasContextCue = cueCandidates.some(
        (el) =>
          isWithin(el, local) &&
          isRendered(el, ctx) &&
          NON_CREDENTIAL_ACCOUNT_CONTEXT_RE.test(normalize(cueText(el, ctx)))
      );
      if (hasContextCue) return true;
      local = local.parentElement;
    }
    return false;
  }

  // If the active action and password already form their own small subtree,
  // that subtree is an unrelated widget rather than evidence connecting the
  // distant identity field. Valid deep flows keep the visible identifier
  // action and the hidden password step in separate wrapper trees.
  function controlsShareLocalSubtree(action, password, outer) {
    let local = action.parentElement;
    for (let depth = 0; depth < LOCAL_ASSOCIATION_MAX_DEPTH; depth += 1) {
      if (local === null || local === outer) return false;
      if (isWithin(password, local)) return true;
      local = local.parentElement;
    }
    return false;
  }

  // Separate, constrained fallback for deeply nested, form-less, multi-step
  // credential pages (issue #5). Their identity step is shown while the forward
  // action and a still-hidden password step live in separate wrapper trees, so
  // the nearest ancestor shared by all three is far beyond the shallow local
  // reach. This never widens the shallow rule: it is only reached for an
  // active, form-less, dialog-less field carrying the standardized username
  // token, and it still demands a compatible forward action and a coherent
  // password step, so a lone distant username field followed by a stray button
  // never qualifies. The smallest such shared ancestor is the flow container; a
  // bounding landmark, <body> or <html> is never it.
  function deepCredentialFlowMatches(field, forwardActions, inputs, actionCandidates, cueCandidates, ctx) {
    if (hasLocalNonCredentialAccountContext(field, cueCandidates, ctx)) return false;
    for (
      let container = field.parentElement;
      container !== null &&
      container !== undefined &&
      container !== ctx.doc.body &&
      container !== ctx.doc.documentElement &&
      !isApplicationLandmark(container);
      container = container.parentElement
    ) {
      // Active and forward-named already; here they must also not be fenced off
      // by a native form or dialog the form-less, dialog-less field is not in.
      const compatibleActions = forwardActions.filter(
        (el) => isWithin(el, container) && formOwner(el) === null && dialogAncestor(el) === null
      );
      if (compatibleActions.length === 0) continue;
      const passwordSteps = inputs.filter(
        (pw) => isWithin(pw, container) && isCoherentPasswordStep(pw, actionCandidates, cueCandidates, ctx)
      );
      if (passwordSteps.length === 0) continue;

      // A complete flow distributes its visible action and later password step
      // across the candidate. If those two already make up a smaller local
      // widget, that widget cannot be borrowed by the distant identity field.
      const hasDistributedCredentialPattern = compatibleActions.some(
        (action) => passwordSteps.some(
          (pw) => !controlsShareLocalSubtree(action, pw, container)
        )
      );
      if (hasDistributedCredentialPattern) return true;
    }
    return false;
  }

  function identityPatternMatches(field, forwardActions, actionCandidates, cueCandidates, inputs, ctx) {
    // autocomplete="username" is strong standardized evidence and replaces the
    // textual cue, so localized pages need no English text. An associated
    // forward action is still required in every branch.
    const usernameAutocomplete = tokensOf(field, "autocomplete").includes("username");

    const owner = formOwner(field);
    if (owner !== null) {
      const associated = forwardActions.filter(
        (el) => formOwner(el) === owner || (!isFormAssociated(el) && isWithin(el, owner))
      );
      if (associated.length === 0) return false;
      if (usernameAutocomplete) return true;
      // Decision: a heading outside the <form> but inside its enclosing
      // dialog-like container may provide the cue — a common login layout.
      const cueContainer = dialogAncestor(owner) ?? owner;
      return containerHasAuthCue(cueContainer, cueCandidates, ctx) ||
        actionsCarryAuthCue(associated, ctx) ||
        containerHasPasswordStep(owner, inputs, actionCandidates, ctx);
    }

    const dialog = dialogAncestor(field);
    if (dialog !== null) {
      const associated = forwardActions.filter((el) => dialogAncestor(el) === dialog);
      if (associated.length === 0) return false;
      if (usernameAutocomplete) return true;
      return containerHasAuthCue(dialog, cueCandidates, ctx) ||
        actionsCarryAuthCue(associated, ctx) ||
        containerHasPasswordStep(dialog, inputs, actionCandidates, ctx);
    }

    // No form and no dialog: the field's own wrapper decides. The walk widens
    // past the immediate parent only through containers that also hold a
    // coherent password step — a multi-step credential form (identity step
    // visible, password step present but hidden) is the one form-less shape that needs
    // the extra reach, and the pages that must not match here (a newsletter
    // field in a footer, a site-search box) have no password input at all.
    let container = field.parentElement;
    for (let depth = 0; depth < LOCAL_ASSOCIATION_MAX_DEPTH; depth += 1) {
      if (
        container === null ||
        container === ctx.doc.body ||
        container === ctx.doc.documentElement
      ) break;
      const hasPasswordStep = containerHasPasswordStep(container, inputs, actionCandidates, ctx);
      if (depth === 0 || hasPasswordStep) {
        const associated = forwardActions.filter((action) => isWithin(action, container));
        if (associated.length > 0) {
          if (usernameAutocomplete || hasPasswordStep) return true;
          return containerHasAuthCue(container, cueCandidates, ctx) ||
            actionsCarryAuthCue(associated, ctx);
        }
      }
      container = container.parentElement;
    }

    // Deeply nested, form-less, multi-step credential pages (issue #5) reach
    // past that shallow limit, but only with the standardized username token to
    // enter and a coherent hidden password step to anchor the association.
    if (usernameAutocomplete) {
      return deepCredentialFlowMatches(field, forwardActions, inputs, actionCandidates, cueCandidates, ctx);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Identity fields.
  // ---------------------------------------------------------------------------

  function fieldMetadata(el, ctx) {
    return normalize(
      [getAttr(el, "name"), getAttr(el, "id"), getAttr(el, "placeholder"), accessibleName(el, ctx)]
        .filter((value) => value !== null)
        .join(" ")
    );
  }

  function hasSearchSemantics(el, ctx) {
    if (inputType(el) === "search" || tokensOf(el, "role").includes("searchbox")) return true;
    if (SEARCH_HINT_RE.test(fieldMetadata(el, ctx))) return true;
    for (let cur = el.parentElement; cur !== null && cur !== undefined; cur = cur.parentElement) {
      if (tagOf(cur) === "search" || tokensOf(cur, "role").includes("search")) return true;
    }
    return false;
  }

  function isIdentityField(el, ctx) {
    if (!IDENTITY_INPUT_TYPES.has(inputType(el))) return false;
    if (hasSearchSemantics(el, ctx)) return false;
    const autocomplete = tokensOf(el, "autocomplete");
    if (autocomplete.includes("username")) return true;
    // type=email / autocomplete=email are weak (newsletters use both): they
    // identify the field but the pattern still demands the separate cue.
    if (inputType(el) === "email" || inputType(el) === "tel") return true;
    if (autocomplete.includes("email") || autocomplete.includes("tel")) return true;
    return IDENTITY_HINT_RE.test(fieldMetadata(el, ctx));
  }

  // ---------------------------------------------------------------------------
  // Entry point.
  // ---------------------------------------------------------------------------

  function detectLoginPage(doc = globalThis.document, win = globalThis.window) {
    const ctx = { doc, win };
    const { inputs, actionCandidates, cueCandidates } = collectCandidates(doc);
    let confidence = 0;

    if (inputs.some((el) => inputType(el) === "password" && isActiveField(el, ctx))) {
      // An inactive password field never matches this pattern on its own; it
      // only feeds the identity pattern below as container evidence for a
      // coherent multi-step flow (see containerHasPasswordStep).
      confidence = PASSWORD_CONFIDENCE;
    } else {
      const forwardActions = actionCandidates.filter((el) => isForwardAction(el, ctx));
      if (forwardActions.length > 0) {
        const matched = inputs.some(
          (el) =>
            isIdentityField(el, ctx) &&
            isActiveField(el, ctx) &&
            identityPatternMatches(el, forwardActions, actionCandidates, cueCandidates, inputs, ctx)
        );
        if (matched) confidence = IDENTITY_CONFIDENCE;
      }
    }

    return { isLogin: confidence >= LOGIN_THRESHOLD, confidence };
  }

  return {
    LOGIN_THRESHOLD,
    PASSWORD_CONFIDENCE,
    IDENTITY_CONFIDENCE,
    DETECTION_ATTRIBUTES,
    VISUAL_ATTRIBUTES,
    collectOpenShadowRoots,
    detectLoginPage,
  };
});
