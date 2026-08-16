// settings.js is a classic script loaded by settings.html, so it can be
// require()d under plain Node once document/chrome are stubbed -- the same
// approach logo-selector.test.js takes. That runs the real page: the real
// listeners, the real render path, the real entry cards.
//
// Coverage is the issue #22 contract -- the page refreshes from storage. The
// service worker cannot reach an extension page with chrome.tabs.sendMessage,
// so a logo saved in another tab must show up through chrome.storage.onChanged
// and all open settings pages must stay synchronized. A page that was suspended
// when the change landed reconciles when it becomes visible; none of this relies
// on a runtime notification being delivered.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const SETTINGS_SCRIPT_PATH = require.resolve("./settings.js");
const SERVICE_WORKER_SOURCE = readFileSync(path.join(__dirname, "../background/service_worker.js"), "utf8");

// =============================================================================
// MINIMAL DOM
// =============================================================================

class FakeNode {}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.src = "";
    this.alt = "";
    this.title = "";
    this.href = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.colSpan = 1;
    this.dataset = {};
    this.children = [];
    this.cells = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.html = "";
  }

  get classList() {
    const names = this.className.split(/\s+/).filter(Boolean);
    const list = {
      add: (...added) => {
        this.className = [...new Set([...names, ...added])].join(" ");
      },
      remove: (...removed) => {
        this.className = names.filter((name) => !removed.includes(name)).join(" ");
      },
      toggle: (name, force) => {
        const shouldHave = force ?? !names.includes(name);
        if (shouldHave) list.add(name);
        else list.remove(name);
        return shouldHave;
      },
      contains: (name) => names.includes(name),
    };
    names.forEach((name, index) => {
      list[index] = name;
    });
    return list;
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(html) {
    this.children.forEach((child) => {
      child.parentNode = null;
    });
    this.children = [];
    this.html = html;
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    this.html = "";
    return node;
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (typeof node === "string") this.textContent += node;
      else this.appendChild(node);
    });
  }

  replaceChildren(...nodes) {
    this.innerHTML = "";
    this.append(...nodes);
  }

  matches(selector) {
    assert.ok(selector.startsWith("."), `only class selectors are supported: ${selector}`);
    return this.classList.contains(selector.slice(1));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    this.children.forEach((child) => {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    });
    return found;
  }

  cloneNode() {
    const copy = new FakeElement(this.tagName, this.ownerDocument);
    Object.assign(copy, {
      id: this.id,
      className: this.className,
      textContent: this.textContent,
      value: this.value,
      hidden: this.hidden,
      dataset: { ...this.dataset },
    });
    this.children.forEach((child) => copy.appendChild(child.cloneNode()));
    return copy;
  }

  createTHead() {
    return this.appendChild(new FakeElement("thead", this.ownerDocument));
  }

  createTBody() {
    return this.appendChild(new FakeElement("tbody", this.ownerDocument));
  }

  insertRow() {
    return this.appendChild(new FakeElement("tr", this.ownerDocument));
  }

  insertCell() {
    const cell = this.appendChild(new FakeElement("td", this.ownerDocument));
    this.cells.push(cell);
    return cell;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  fire(type, event = {}) {
    const handler = this.listeners.get(type);
    assert.ok(handler, `${this.id || this.className || this.tagName} has no ${type} handler`);
    return handler({ target: this, preventDefault() {}, ...event });
  }
}

// The classes settings.js queries on each card.
const TRUSTED_CARD_CLASSES = [
  "entry-fqdn", "entry-etld1", "entry-last-visited", "badge-protocol",
  "entry-logo", "entry-logo-missing", "btn-modify-logo",
  "entry-ocr-words", "entry-user-words", "word-input", "btn-add-word",
  "btn-remove", "advanced-field",
];

const MUTED_CARD_CLASSES = [
  "entry-fqdn", "entry-etld1", "entry-last-visited", "badge-protocol",
  "muted-until-select", "btn-move-trusted",
  "entry-user-words", "word-input", "btn-add-word",
  "btn-remove", "advanced-field",
];

function createDocument() {
  const listeners = new Map();
  const root = new FakeElement("body", null);

  const document = {
    visibilityState: "visible",
    activeElement: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      return findById(root, id);
    },
    querySelectorAll(selector) {
      return root.querySelectorAll(selector);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    fire(type) {
      const handler = listeners.get(type);
      assert.ok(handler, `the page registered no ${type} handler`);
      return handler({});
    },
    hasListener(type) {
      return listeners.has(type);
    },
    root,
  };
  root.ownerDocument = document;
  return document;
}

function findById(node, id) {
  for (const child of node.children) {
    if (child.id === id) return child;
    const found = findById(child, id);
    if (found !== null) return found;
  }
  return null;
}

function addPageElement(document, tagName, id, className = "") {
  const element = new FakeElement(tagName, document);
  element.id = id;
  element.className = className;
  document.root.appendChild(element);
  return element;
}

function addTemplate(document, id, classes) {
  const template = addPageElement(document, "template", id);
  const card = new FakeElement("div", document);
  card.className = "entry-card";
  classes.forEach((className) => {
    const child = new FakeElement(className === "word-input" ? "input" : "div", document);
    child.className = className;
    card.appendChild(child);
  });
  template.content = {
    cloneNode: () => {
      const holder = new FakeElement("div", document);
      holder.appendChild(card.cloneNode());
      return holder;
    },
  };
  return template;
}

// =============================================================================
// PAGE HARNESS
// =============================================================================

function trustedEntry(overrides = {}) {
  return {
    fqdn: "bank.test",
    etld1: "bank.test",
    protocol: "https",
    variant_id: "variant-1",
    storage_revision: "revision-1",
    logo_image: "data:image/png;base64,OLD",
    ocr_words: ["bank"],
    user_words: [],
    last_visited: "01012026",
    scores: [],
    ...overrides,
  };
}

async function loadSettings({ stored = {}, deviceFlowBuiltins = [] } = {}) {
  const document = createDocument();
  addPageElement(document, "div", "trusted-list", "entry-list");
  addPageElement(document, "div", "muted-list", "entry-list");
  addPageElement(document, "input", "developer-mode-toggle");
  addPageElement(document, "div", "manual-sites-section");
  addPageElement(document, "div", "manual-trusted-list");
  addPageElement(document, "input", "manual-trusted-input");
  addPageElement(document, "button", "manual-trusted-add");
  addPageElement(document, "button", "manual-trusted-cancel");
  addPageElement(document, "p", "manual-trusted-error");
  addPageElement(document, "div", "manual-muted-list");
  addPageElement(document, "input", "manual-muted-input");
  addPageElement(document, "button", "manual-muted-add");
  addPageElement(document, "button", "manual-muted-cancel");
  addPageElement(document, "p", "manual-muted-error");
  addPageElement(document, "section", "analysis-history-section");
  addPageElement(document, "div", "analysis-history-list");
  addPageElement(document, "button", "export-analysis-history");
  addPageElement(document, "button", "clear-analysis-history");
  addPageElement(document, "div", "clickfix-warn-mode-row");
  addPageElement(document, "div", "device-code-auth-row");
  addPageElement(document, "input", "device-code-auth-toggle");
  addPageElement(document, "div", "reset-defaults-row");
  addPageElement(document, "button", "reset-defaults-btn");
  addPageElement(document, "div", "device-flow-section");
  addPageElement(document, "div", "banner-font-preview");
  ["small", "medium", "large"].forEach((size) => {
    const button = addPageElement(document, "button", `font-size-${size}`, "font-size-btn");
    button.dataset.size = size;
  });
  addPageElement(document, "input", "clickfix-warn-mode-toggle");
  addPageElement(document, "div", "clickfix-exclusions");
  addPageElement(document, "div", "clickfix-domain-list");
  addPageElement(document, "input", "clickfix-domain-input");
  addPageElement(document, "button", "clickfix-domain-add");
  addPageElement(document, "p", "clickfix-domain-error");
  addPageElement(document, "div", "device-flow-builtin-list");
  addPageElement(document, "div", "device-flow-trusted-initiator-list");
  addPageElement(document, "div", "device-flow-user-list");
  addPageElement(document, "input", "device-flow-endpoint-input");
  addPageElement(document, "button", "device-flow-endpoint-add");
  addPageElement(document, "button", "device-flow-endpoint-cancel");
  addPageElement(document, "p", "device-flow-endpoint-error");
  addTemplate(document, "tpl-trusted-entry", TRUSTED_CARD_CLASSES);
  addTemplate(document, "tpl-muted-entry", MUTED_CARD_CLASSES);

  const store = { trusted_list: [], muted_list: [], settings: {}, analysis_history: [], ...stored };
  const storageListeners = [];
  const runtimeListeners = [];
  const sentMessages = [];
  const sendMessageBehaviors = new Map();
  // The page fetches the read-only built-in endpoints once at load (issue #39).
  sendMessageBehaviors.set("get_device_flow_builtin_endpoints", () => ({ ok: true, endpoints: deviceFlowBuiltins }));
  let reads = 0;
  let deferredRead = null;

  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
      },
      sendMessage(message) {
        sentMessages.push(message);
        const behavior = sendMessageBehaviors.get(message.type);
        if (behavior !== undefined) return Promise.resolve(behavior(message));
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: {
        get(keys) {
          reads += 1;
          const requested = Array.isArray(keys) ? keys : [keys];
          const snapshot = {};
          requested.forEach((key) => {
            if (store[key] !== undefined) snapshot[key] = structuredClone(store[key]);
          });
          if (deferredRead !== null) {
            const pending = deferredRead;
            deferredRead = null;
            return new Promise((resolve) => {
              pending.release = () => resolve(snapshot);
            });
          }
          return Promise.resolve(snapshot);
        },
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
  };

  global.document = document;
  global.chrome = chrome;
  global.Node = FakeNode;
  global.confirm = () => true;

  delete require.cache[SETTINGS_SCRIPT_PATH];
  require(SETTINGS_SCRIPT_PATH);

  await document.fire("DOMContentLoaded");

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const activate = () => {
    global.document = document;
    global.chrome = chrome;
  };

  return {
    document,
    store,
    sentMessages,
    runtimeListeners,
    activate,
    setSendMessageBehavior(type, behavior) {
      sendMessageBehaviors.set(type, behavior);
    },
    lastMessageOfType(type) {
      return [...sentMessages].reverse().find((m) => m.type === type);
    },
    deferNextRead() {
      assert.equal(deferredRead, null, "a storage read is already deferred");
      const pending = { release: null };
      deferredRead = pending;
      return () => {
        assert.equal(typeof pending.release, "function", "the deferred storage read has not started");
        pending.release();
      };
    },
    readCount: () => reads,
    cards(containerId = "trusted-list") {
      return document.getElementById(containerId).querySelectorAll(".entry-card");
    },
    card(fqdn, containerId = "trusted-list") {
      return this.cards(containerId).find((entry) => entry.dataset.fqdn === fqdn) ?? null;
    },
    // What the service worker's storage commit looks like from this page.
    async commit(changedKeys) {
      activate();
      const changes = {};
      changedKeys.forEach((key) => {
        changes[key] = { newValue: structuredClone(store[key]) };
      });
      storageListeners.forEach((listener) => listener(changes, "local"));
      await settle();
    },
    async dispatchStorageChange(changes, areaName) {
      activate();
      storageListeners.forEach((listener) => listener(changes, areaName));
      await settle();
    },
    async returnToSettings() {
      activate();
      document.visibilityState = "visible";
      document.fire("visibilitychange");
      await settle();
    },
    settle,
  };
}

// =============================================================================
// TESTS
// =============================================================================

test("a logo saved by the worker re-renders the card from storage", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  assert.equal(page.card("bank.test").querySelector(".entry-logo").src, "data:image/png;base64,OLD");

  // The worker commits the manual selection, then re-activates this tab.
  page.store.trusted_list = [trustedEntry({ logo_image: "data:image/png;base64,NEW", storage_revision: "revision-2" })];
  await page.commit(["trusted_list"]);

  const logo = page.card("bank.test").querySelector(".entry-logo");
  assert.equal(logo.src, "data:image/png;base64,NEW");
  assert.equal(logo.hidden, false);
});

test("the page needs no runtime message to refresh", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });

  // chrome.tabs.sendMessage cannot reach an extension page (issue #22), so the
  // page must not be waiting on one -- storage alone has to carry the refresh.
  assert.deepEqual(page.runtimeListeners, []);
  assert.doesNotMatch(SERVICE_WORKER_SOURCE, /logo_selector_done/);
});

test("returning to the settings tab reconciles a change the page never saw", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });

  // A frozen background tab runs no listener: the change lands with no event.
  page.store.trusted_list = [trustedEntry({ logo_image: "data:image/png;base64,NEW" })];
  await page.returnToSettings();

  assert.equal(page.card("bank.test").querySelector(".entry-logo").src, "data:image/png;base64,NEW");
});

test("an unchanged snapshot leaves the rendered page alone", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  const rendered = page.card("bank.test");

  await page.returnToSettings();
  await page.commit(["trusted_list"]);

  assert.equal(page.card("bank.test"), rendered, "the cards were rebuilt for a change that was not one");
});

test("changes to other areas and other keys are ignored", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  const readsAfterLoad = page.readCount();

  await page.dispatchStorageChange({ trusted_list: { newValue: [] } }, "session");
  await page.dispatchStorageChange({ logo_selector_sessions: { newValue: {} } }, "local");

  assert.equal(page.readCount(), readsAfterLoad, "an unrelated change must not re-read storage");
  assert.equal(page.cards().length, 1);
});

test("an entry removed in the background disappears", async () => {
  const page = await loadSettings({
    stored: { settings: { developer_mode: true }, trusted_list: [trustedEntry()] },
  });

  page.store.trusted_list = [];
  await page.commit(["trusted_list"]);

  assert.equal(page.cards().length, 0);
  assert.match(page.document.getElementById("trusted-list").innerHTML, /No trusted sites yet/);
});

test("a muted entry moved to the trusted list shows up in both lists' renders", async () => {
  const page = await loadSettings({
    stored: { muted_list: [{ fqdn: "shop.test", etld1: "shop.test", protocol: "https", muted_until: "forever", user_words: [] }] },
  });
  assert.equal(page.cards("muted-list").length, 1);
  assert.equal(page.cards("trusted-list").length, 0);

  page.store.muted_list = [];
  page.store.trusted_list = [trustedEntry({ fqdn: "shop.test" })];
  await page.commit(["trusted_list", "muted_list"]);

  assert.equal(page.cards("muted-list").length, 0);
  assert.equal(page.card("shop.test", "trusted-list")?.dataset.fqdn, "shop.test");
});

test("storage changes synchronize every open settings page", async () => {
  const first = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  const second = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  const pages = [first, second];

  for (const page of pages) {
    page.store.trusted_list = [trustedEntry({ logo_image: "data:image/png;base64,NEW" })];
    page.store.muted_list = [{
      fqdn: "muted.test",
      etld1: "muted.test",
      protocol: "https",
      muted_until: "forever",
      user_words: [],
    }];
    page.store.settings = { developer_mode: true };
    page.store.analysis_history = [{
      status: "error",
      datetime: "2026-07-31T12:00:00.000Z",
      url: "https://bank.test/login",
      origin: { fqdn: "bank.test" },
      error: "test failure",
    }];
  }

  // Chrome broadcasts one storage change to every extension page. The harness
  // delivers that same change to each isolated settings-page instance.
  for (const page of pages) {
    await page.commit(["trusted_list", "muted_list", "settings", "analysis_history"]);
  }

  for (const page of pages) {
    assert.equal(page.card("bank.test").querySelector(".entry-logo").src, "data:image/png;base64,NEW");
    assert.equal(page.card("muted.test", "muted-list")?.dataset.fqdn, "muted.test");
    assert.equal(page.document.getElementById("developer-mode-toggle").checked, true);
    assert.equal(page.card("bank.test").querySelector(".advanced-field").hidden, false);
    assert.equal(page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card").length, 1);
  }
});

test("a developer-mode change committed elsewhere reveals the advanced fields", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });
  assert.equal(page.card("bank.test").querySelector(".advanced-field").hidden, true);
  assert.equal(page.document.getElementById("analysis-history-section").hidden, true);

  page.store.settings = { developer_mode: true };
  await page.commit(["settings"]);

  assert.equal(page.card("bank.test").querySelector(".advanced-field").hidden, false);
  assert.equal(page.document.getElementById("developer-mode-toggle").checked, true);
  assert.equal(page.document.getElementById("analysis-history-section").hidden, false);
});

test("a completed record hides candidate, proposal, routing, timing, and image diagnostics", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "completed",
        datetime: "2026-08-07T12:00:00.000Z",
        origin: { fqdn: "" },
        context: "add_to_trusted",
        displayed_verdict: "logo_validation_pending",
        global_score: 0,
        candidates: [],
        timings_ms: { totalMs: 1000 },
        query_stats: {
          regionCount: 3,
          yoloRegionCount: 0,
          cvRegionCount: 3,
          fullOcrRan: true,
          yoloValidation: "cv-fallback",
        },
        preprocessing: {
          candidates: [
            { xRatio: 0.05, yRatio: 0.05, widthRatio: 0.2, heightRatio: 0.1, score: 0.18 },
          ],
        },
        compared_logo_image: "data:image/png;base64,ONE",
      }, {
        status: "completed",
        datetime: "2026-08-07T12:01:00.000Z",
        origin: { fqdn: "" },
        context: "add_to_trusted",
        displayed_verdict: "logo_validation_pending",
        global_score: 0,
        candidates: [],
        preprocessing: { candidates: [] },
      }],
    },
  });

  const cards = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card");
  assert.equal(cards.length, 2);
  const blockByTitle = (card, title) =>
    card.querySelectorAll(".analysis-block").find((block) => block.children[0]?.textContent === title) ?? null;
  for (const card of cards) {
    for (const title of [
      "Compared logo",
      "Proposed logo candidates",
      "Trusted preprocessing OCR",
      "Candidate references",
      "Query stats",
      "Timings (ms)",
    ]) {
      assert.equal(blockByTitle(card, title), null, title + " must not render");
    }
  }
});

// The card shows what the record actually holds. A field that is absent says
// nothing, so it is dropped rather than rendered as a dash -- but `false` and
// `0` are answers and stay.
test("a completed card drops absent fields while keeping false and zero", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "completed",
        datetime: "2026-08-09T12:00:00.000Z",
        extension_version: "0.1.0",
        origin: { valid: true, fqdn: "bank.test", protocol: "https", in_trusted_list: false, origin_mismatch: false },
        context: "detection",
        displayed_verdict: "suspicious",
        pipeline_verdict: "phishing",
        global_score: 0.62,
        matched_fqdn: "bank.test",
        matched_variant_id: "",
        winner: {
          fqdn: "bank.test",
          global_score: 0.62,
          dinov2_logo_similarity: 0.82,
          score_composition: { logo_assigned_score: 0.4, ocr_assigned_score: 0 },
          logo: {
            score: 0.5,
            shape_score: 0.4,
            color_score: 0.3,
            texture_score: 0.2,
            layout_score: 0.1,
            geometry_score: 0.2,
            color_conflict: false,
            reason: "compared",
            query_box: "10,10,50,50",
            trusted_box: "12,12,50,50",
            rejected_pairs_without_evidence: 2,
            query_ocr_diagnostics: { status: "text", cropSize: "80x40" },
          },
          ocr: {
            normalized_score: 0,
            fuzzy_score: 0.8,
            matched_tokens: ["bank"],
            fuzzy_matched_tokens: ["b4nk"],
            rejected_ui_tokens: ["sign in"],
          },
        },
        reference: {
          fqdn: "bank.test",
          variant_id: "variant-1",
          logo_source: "manual",
          logo_regions: [{
            rank: 1,
            source: "manual",
            x: 1095,
            y: 280,
            width: 124,
            height: 47,
            dominantHueBin: "0",
            dominantHueFraction: 0.2469,
          }],
          ocr_domain: "bank",
          ocr_words: ["bank"],
          user_words: [],
        },
        candidates: [],
      }],
    },
  });

  const card = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card")[0];
  const blockByTitle = (title) =>
    card.querySelectorAll(".analysis-block").find((block) => block.children[0]?.textContent === title) ?? null;
  const gridText = (grid) => grid.children.map((node) => node.textContent).join("|");

  const overview = gridText(card.querySelector(".metric-grid"));
  assert.match(overview, /Origin\|bank\.test/);
  assert.match(overview, /Pipeline verdict\|phishing/);
  assert.match(overview, /Origin mismatch\|no\|Trusted page\|no/, "false is a value and stays");
  // A confirmed phishing match names its matched domain here; the empty variant
  // id still says nothing, and the displayed verdict stays in the header badge.
  assert.match(overview, /Matched domain\|bank\.test/);
  assert.doesNotMatch(overview, /Displayed verdict|Matched variant/);
  // The address of the analysed page is never rendered, not even from a
  // record written before it stopped being stored.
  assert.doesNotMatch(overview, /URL|\/login/);

  assert.equal(blockByTitle("Score composition"), null, "score details are not rendered");
  assert.equal(blockByTitle("Candidate references"), null, "candidate scores are not rendered");

  // A crop that produced text needs no canvas-size forensics.
  const logo = gridText(blockByTitle("Logo comparison").children[1]);
  assert.doesNotMatch(logo, /crop OCR status|crop size|OCR canvas/);
  assert.match(logo, /Reason\|compared/);
  assert.doesNotMatch(logo, /Final score|Shape|Color|Texture|Layout|Geometry|Histogram|DINO|Score capped|Query box|Reference box|Rejected pairs/);

  const ocr = gridText(blockByTitle("OCR evidence").children[1]);
  assert.match(ocr, /Matched tokens\|bank\|Fuzzy matches\|b4nk/);
  assert.doesNotMatch(ocr, /Normalized|Rejected/);

  const reference = gridText(blockByTitle("Saved reference").children[1]);
  assert.match(reference, /FQDN\|bank\.test\|Variant ID\|variant-1/);
  assert.doesNotMatch(reference, /Logo regions|dominantHue|1095|0\.2469/);

  assert.equal(dashCount(card), 0, "no row renders as a placeholder dash");
});

// dt and dd alike: a label is never "—", so any dash is a rendered empty value.
function dashCount(card) {
  return card
    .querySelectorAll(".metric-grid")
    .flatMap((grid) => grid.children.map((node) => node.textContent))
    .filter((text) => text === "—")
    .length;
}

// The card title names the analysed page, never the pipeline's closest
// candidate: for an unknown result that candidate is not a confirmed match, so
// titling with it would name an unrelated brand. Matched domain/variant appear
// as details only for a confirmed phishing match; the winner/reference
// diagnostics stay for every completed record, unknown ones included.
test("an unknown analysis is titled by its origin and never names the closest candidate as a match", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "completed",
        datetime: "2026-08-09T12:00:00.000Z",
        extension_version: "0.1.0",
        origin: { valid: true, fqdn: "accounts.zalando.com", protocol: "https", in_trusted_list: false, origin_mismatch: false },
        context: "detection",
        displayed_verdict: "unknown",
        pipeline_verdict: "unknown",
        global_score: 0.31,
        matched_fqdn: "login.microsoftonline.com",
        matched_variant_id: "variant-ms",
        winner: { logo: { reason: "compared" }, ocr: { matched_tokens: ["microsoft"] } },
        reference: {
          fqdn: "login.microsoftonline.com",
          variant_id: "variant-ms",
          logo_source: "automatic",
          ocr_domain: "microsoft",
          ocr_words: ["microsoft"],
          user_words: [],
        },
        candidates: [],
      }],
    },
  });

  const card = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card")[0];
  assert.equal(
    card.querySelector(".analysis-summary-title").textContent,
    "accounts.zalando.com",
    "the analysed origin titles the card, not the closest candidate"
  );

  const blockByTitle = (title) =>
    card.querySelectorAll(".analysis-block").find((block) => block.children[0]?.textContent === title) ?? null;
  const gridText = (grid) => grid.children.map((node) => node.textContent).join("|");

  const overview = gridText(card.querySelector(".metric-grid"));
  assert.doesNotMatch(overview, /Matched domain/, "an unknown result has no confirmed match to name");
  assert.doesNotMatch(overview, /Matched variant/);
  assert.doesNotMatch(overview, /login\.microsoftonline\.com/, "the closest candidate is never a match row");

  // The winner and saved-reference diagnostics remain useful and stay put, and
  // that is where the closest candidate legitimately appears -- as a diagnostic.
  assert.notEqual(blockByTitle("Logo comparison"), null, "winner diagnostics stay for unknown results");
  const reference = blockByTitle("Saved reference");
  assert.notEqual(reference, null, "the saved-reference section stays for unknown results");
  assert.match(gridText(reference.children[1]), /FQDN\|login\.microsoftonline\.com/);
});

test("a confirmed phishing match is titled by its origin and shows matched domain and variant", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "completed",
        datetime: "2026-08-09T12:00:00.000Z",
        extension_version: "0.1.0",
        origin: { valid: true, fqdn: "paypa1-login.test", protocol: "https", in_trusted_list: false, origin_mismatch: false },
        context: "detection",
        // Phishing without an origin mismatch is displayed as suspicious.
        displayed_verdict: "suspicious",
        pipeline_verdict: "phishing",
        global_score: 0.71,
        matched_fqdn: "paypal.com",
        matched_variant_id: "variant-7",
        winner: null,
        reference: null,
        candidates: [],
      }],
    },
  });

  const card = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card")[0];
  assert.equal(
    card.querySelector(".analysis-summary-title").textContent,
    "paypa1-login.test",
    "even a confirmed match is titled by the analysed origin, not the matched brand"
  );

  const overview = card.querySelector(".metric-grid").children.map((node) => node.textContent).join("|");
  assert.match(overview, /Matched domain\|paypal\.com/, "a confirmed match names its matched domain");
  assert.match(overview, /Matched variant\|variant-7/);
});

test("a phishing record without a matched domain exposes no partial match fields", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "completed",
        datetime: "2026-08-09T12:00:00.000Z",
        extension_version: "0.1.0",
        origin: { valid: true, fqdn: "malformed.example", protocol: "https", in_trusted_list: false, origin_mismatch: true },
        context: "detection",
        displayed_verdict: "phishing",
        pipeline_verdict: "phishing",
        global_score: 0.71,
        matched_fqdn: "",
        matched_variant_id: "orphaned-variant",
        winner: null,
        reference: null,
        candidates: [],
      }],
    },
  });

  const card = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card")[0];
  const overview = card.querySelector(".metric-grid").children.map((node) => node.textContent).join("|");
  assert.doesNotMatch(overview, /Matched domain|Matched variant/);
});

// A failed analysis has no verdict, no scores and no candidates. It used to
// render the completed-analysis grid anyway, one dash per missing field.
test("an error record renders as its own card, not an empty analysis", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      analysis_history: [{
        status: "error",
        datetime: "2026-08-09T12:00:00.000Z",
        extension_version: "0.1.0",
        url: "https://bank.test/login",
        origin: { valid: true, fqdn: "bank.test", protocol: "https" },
        context: "detection",
        failure_code: "job_timeout",
        error: "Analysis exceeded the whole-job deadline",
      }],
    },
  });

  const card = page.document.getElementById("analysis-history-list").querySelectorAll(".analysis-card")[0];
  assert.equal(card.querySelector(".analysis-verdict").textContent, "ERROR");
  assert.equal(card.querySelector(".analysis-score").textContent, "");

  const overview = card.querySelector(".metric-grid").children.map((node) => node.textContent).join("|");
  assert.match(overview, /Origin\|bank\.test/);
  assert.match(overview, /Context\|detection/);
  assert.match(overview, /Failure code\|job_timeout/);
  assert.doesNotMatch(overview, /Pipeline verdict|Matched reference|Protocol|Trusted page/);
  assert.doesNotMatch(overview, /URL|\/login/, "a failed analysis names the host, never the address");

  const blocks = card.querySelectorAll(".analysis-block");
  assert.deepEqual(blocks.map((block) => block.children[0].textContent), ["Pipeline error"]);
  assert.equal(dashCount(card), 0, "no row renders as a placeholder dash");
});

test("overlapping refreshes settle on the last committed state", async () => {
  const page = await loadSettings({ stored: { trusted_list: [trustedEntry()] } });

  const releaseOldRead = page.deferNextRead();
  page.store.trusted_list = [trustedEntry({ logo_image: "data:image/png;base64,ONE" })];
  page.activate();
  page.document.fire("visibilitychange");
  await page.settle();

  page.store.trusted_list = [trustedEntry({ logo_image: "data:image/png;base64,TWO" })];
  await page.dispatchStorageChange({
    trusted_list: { newValue: structuredClone(page.store.trusted_list) },
  }, "local");

  // The old visibility read resolves after the newer event was received. The
  // shared queue must still leave the event's newer value rendered last.
  releaseOldRead();
  await page.settle();

  assert.equal(page.card("bank.test").querySelector(".entry-logo").src, "data:image/png;base64,TWO");
});

// =============================================================================
// MANUAL TRUSTED/MUTED SITES (issue #93)
// =============================================================================

test("the settings page carries no phishing-bypass control any more", async () => {
  const settingsSource = readFileSync(require.resolve("./settings.js"), "utf8");
  const settingsHtml = readFileSync(require.resolve("./settings.html"), "utf8");

  assert.doesNotMatch(settingsSource, /set_phishing_bypass|phishing-bypass|allow_phishing_bypass/);
  assert.doesNotMatch(settingsHtml, /phishing-bypass|Proceed at my own risk/);
  assert.match(settingsHtml, /grey muted-site banner is shown/);
  assert.match(settingsHtml, /ClickFix and Device Code protection remain enforced/);
});

test("the manual sites section follows developer mode while its entries stay listed", async () => {
  const manualEntry = trustedEntry({ fqdn: "manual.test", manual_entry: true, logo_image: "" });
  const page = await loadSettings({ stored: { trusted_list: [manualEntry] } });

  // Advanced Settings off: the controls are hidden, the entry stays active on
  // the normal Trusted Sites tab.
  assert.equal(page.document.getElementById("manual-sites-section").hidden, true);
  assert.equal(page.card("manual.test")?.dataset.fqdn, "manual.test");

  page.store.settings = { developer_mode: true };
  await page.commit(["settings"]);
  assert.equal(page.document.getElementById("manual-sites-section").hidden, false);
});

test("only entries with manual provenance render in the manual lists, once per hostname", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      trusted_list: [
        trustedEntry({ fqdn: "manual.test", variant_id: "variant-1", manual_entry: true }),
        trustedEntry({ fqdn: "manual.test", variant_id: "variant-2", manual_entry: true }),
        trustedEntry({ fqdn: "inpage.test", variant_id: "variant-3" }),
      ],
      muted_list: [
        { fqdn: "manualmute.test", etld1: "manualmute.test", protocol: "https", muted_until: "forever", user_words: [], manual_entry: true },
        { fqdn: "inpagemute.test", etld1: "inpagemute.test", protocol: "https", muted_until: "forever", user_words: [] },
      ],
    },
  });

  const trustedTags = page.document.getElementById("manual-trusted-list").querySelectorAll(".tag");
  assert.equal(trustedTags.length, 1, "two variants of one manual hostname render as one tag");
  assert.match(trustedTags[0].textContent, /manual\.test/);
  assert.equal(trustedTags[0].querySelectorAll?.(".tag-edit").length ?? 1, 1);

  const mutedTags = page.document.getElementById("manual-muted-list").querySelectorAll(".tag");
  assert.equal(mutedTags.length, 1);
  assert.match(mutedTags[0].textContent, /manualmute\.test/);

  // Both hostnames also render as regular cards in their normal tabs.
  assert.equal(page.card("manual.test")?.dataset.fqdn, "manual.test");
  assert.equal(page.card("manualmute.test", "muted-list")?.dataset.fqdn, "manualmute.test");
});

test("adding a manual trusted site confirms with the exact hostname before sending", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  const confirmations = [];
  global.confirm = (text) => {
    confirmations.push(text);
    return true;
  };

  page.document.getElementById("manual-trusted-input").value = " Login.Example.com. ";
  await page.document.getElementById("manual-trusted-add").fire("click");
  await page.settle();

  const sent = page.lastMessageOfType("add_manual_site");
  assert.equal(sent?.listType, "trusted");
  assert.equal(sent?.hostname, "login.example.com");
  assert.match(confirmations[0], /login\.example\.com/);
  assert.equal(page.document.getElementById("manual-trusted-input").value, "", "the form resets after an accepted add");
  assert.equal(page.document.getElementById("manual-trusted-error").hidden, true);

  page.document.getElementById("manual-trusted-input").value = "faß.de";
  await page.document.getElementById("manual-trusted-add").fire("click");
  assert.equal(page.lastMessageOfType("add_manual_site")?.hostname, "xn--fa-hia.de");
  assert.match(confirmations[1], /xn--fa-hia\.de/);

  page.document.getElementById("manual-trusted-input").value = "127.1";
  await page.document.getElementById("manual-trusted-add").fire("click");
  assert.equal(page.lastMessageOfType("add_manual_site")?.hostname, "127.0.0.1");
  assert.match(confirmations[2], /127\.0\.0\.1/);
});

test("declining the manual add confirmation sends nothing", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  let confirmation = "";
  global.confirm = (text) => { confirmation = text; return false; };

  page.document.getElementById("manual-muted-input").value = "login.example.com";
  await page.document.getElementById("manual-muted-add").fire("click");
  await page.settle();

  assert.equal(page.lastMessageOfType("add_manual_site"), undefined);
  assert.match(confirmation, /normal phishing detection will be muted/i);
  assert.match(confirmation, /ClickFix and Device Code protection remain enforced/);
  assert.equal(page.document.getElementById("manual-muted-input").value, "login.example.com");
});

test("invalid manual input is rejected before confirmation or worker messaging", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  let confirmations = 0;
  global.confirm = () => { confirmations += 1; return true; };

  const input = page.document.getElementById("manual-trusted-input");
  input.value = "https://login.example.com/path";
  await page.document.getElementById("manual-trusted-add").fire("click");

  const errorEl = page.document.getElementById("manual-trusted-error");
  assert.equal(confirmations, 0);
  assert.equal(page.lastMessageOfType("add_manual_site"), undefined);
  assert.match(errorEl.textContent, /exact hostname/);
  assert.equal(input.value, "https://login.example.com/path");

  page.setSendMessageBehavior("add_manual_site", () => ({ ok: false, code: "already_trusted" }));
  input.value = "login.example.com";
  await page.document.getElementById("manual-trusted-add").fire("click");
  assert.match(errorEl.textContent, /already in your Trusted Sites/);
  assert.equal(input.value, "login.example.com");
});

test("a manual-site mutation is single-flight and recovers from transport failure", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  global.confirm = () => true;
  let release;
  page.setSendMessageBehavior("add_manual_site", () => new Promise((resolve) => { release = resolve; }));

  const input = page.document.getElementById("manual-muted-input");
  const addButton = page.document.getElementById("manual-muted-add");
  const cancelButton = page.document.getElementById("manual-muted-cancel");
  input.value = "one.example";
  const first = addButton.fire("click");
  assert.equal(addButton.disabled, true);
  assert.equal(input.disabled, true);
  assert.equal(cancelButton.disabled, true);

  await addButton.fire("click");
  assert.equal(page.sentMessages.filter((message) => message.type === "add_manual_site").length, 1);
  release({ ok: true });
  await first;
  assert.equal(addButton.disabled, false);

  page.setSendMessageBehavior("add_manual_site", () => Promise.reject(new Error("worker unavailable")));
  input.value = "two.example";
  await addButton.fire("click");
  assert.match(page.document.getElementById("manual-muted-error").textContent, /could not update/);
  assert.equal(input.value, "two.example");
  assert.equal(addButton.disabled, false);
});

test("editing a manual entry fills the form and sends the old and new hostnames", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      trusted_list: [trustedEntry({ fqdn: "manual.test", manual_entry: true })],
    },
  });
  global.confirm = () => true;

  await page.document.getElementById("manual-trusted-list").querySelector(".tag-edit").fire("click");
  const input = page.document.getElementById("manual-trusted-input");
  assert.equal(input.value, "manual.test");
  assert.equal(page.document.getElementById("manual-trusted-add").textContent, "Save");
  assert.equal(page.document.getElementById("manual-trusted-cancel").hidden, false);

  input.value = "renamed.test";
  await page.document.getElementById("manual-trusted-add").fire("click");
  await page.settle();

  const sent = page.lastMessageOfType("edit_manual_site");
  assert.equal(sent?.listType, "trusted");
  assert.equal(sent?.fqdn, "manual.test");
  assert.equal(sent?.hostname, "renamed.test");
  assert.equal(page.document.getElementById("manual-trusted-add").textContent, "Add");
});

test("cancelling a manual edit resets the form without sending anything", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      muted_list: [{ fqdn: "manualmute.test", etld1: "manualmute.test", protocol: "https", muted_until: "forever", user_words: [], manual_entry: true }],
    },
  });

  await page.document.getElementById("manual-muted-list").querySelector(".tag-edit").fire("click");
  await page.document.getElementById("manual-muted-cancel").fire("click");

  assert.equal(page.document.getElementById("manual-muted-input").value, "");
  assert.equal(page.document.getElementById("manual-muted-add").textContent, "Add");
  assert.equal(page.document.getElementById("manual-muted-cancel").hidden, true);
  assert.equal(page.lastMessageOfType("edit_manual_site"), undefined);
});

test("removing a manual entry confirms and sends remove_manual_site", async () => {
  const page = await loadSettings({
    stored: {
      settings: { developer_mode: true },
      trusted_list: [trustedEntry({ fqdn: "manual.test", manual_entry: true })],
    },
  });
  global.confirm = () => true;

  await page.document.getElementById("manual-trusted-list").querySelector(".tag-remove").fire("click");
  await page.settle();

  const sent = page.lastMessageOfType("remove_manual_site");
  assert.equal(sent?.listType, "trusted");
  assert.equal(sent?.fqdn, "manual.test");
});

test("a worker commit re-renders the manual lists from storage", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  assert.equal(page.document.getElementById("manual-trusted-list").querySelectorAll(".tag").length, 0);

  page.store.trusted_list = [trustedEntry({ fqdn: "manual.test", manual_entry: true })];
  await page.commit(["trusted_list"]);

  assert.equal(page.document.getElementById("manual-trusted-list").querySelectorAll(".tag").length, 1);
});

// =============================================================================
// CLICKFIX PROTECTION (issue #26)
// =============================================================================

test("strict mode is the default and hides the exclusions section", async () => {
  const page = await loadSettings();
  assert.equal(page.document.getElementById("clickfix-warn-mode-toggle").checked, false);
  assert.equal(page.document.getElementById("clickfix-exclusions").hidden, true);
});

test("enabling warn mode asks for confirmation and sends the mode change", async () => {
  // Warn mode is a Developer-mode control (issue #3): its row and the
  // exclusions section only render while developer mode is enabled.
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  page.setSendMessageBehavior("set_clickfix_mode", () => ({
    ok: true,
    clickfix: { mode: "warn", excluded_domains: [] },
  }));
  global.confirm = () => true;

  const toggle = page.document.getElementById("clickfix-warn-mode-toggle");
  toggle.checked = true;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_clickfix_mode")?.mode, "warn");
  assert.equal(page.document.getElementById("clickfix-exclusions").hidden, false);
});

test("declining the warn-mode confirmation leaves strict mode in place", async () => {
  const page = await loadSettings();
  global.confirm = () => false;

  const toggle = page.document.getElementById("clickfix-warn-mode-toggle");
  toggle.checked = true;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_clickfix_mode"), undefined);
  assert.equal(toggle.checked, false);
  assert.equal(page.document.getElementById("clickfix-exclusions").hidden, true);
});

test("switching back to strict mode does not ask for confirmation", async () => {
  const page = await loadSettings({ stored: { settings: { clickfix: { mode: "warn" } } } });
  page.setSendMessageBehavior("set_clickfix_mode", () => ({
    ok: true,
    clickfix: { mode: "strict", excluded_domains: [] },
  }));
  global.confirm = () => {
    throw new Error("confirm() must not be called when tightening protection");
  };

  const toggle = page.document.getElementById("clickfix-warn-mode-toggle");
  toggle.checked = false;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_clickfix_mode")?.mode, "strict");
});

test("adding a domain exclusion renders it and clears the input", async () => {
  const page = await loadSettings();
  page.setSendMessageBehavior("add_clickfix_domain_exclusion", () => ({
    ok: true,
    clickfix: { mode: "warn", excluded_domains: ["example.com"] },
  }));

  page.document.getElementById("clickfix-domain-input").value = "example.com";
  await page.document.getElementById("clickfix-domain-add").fire("click");

  assert.equal(page.lastMessageOfType("add_clickfix_domain_exclusion")?.domain, "example.com");
  const tags = page.document.getElementById("clickfix-domain-list").querySelectorAll(".tag");
  assert.equal(tags.length, 1);
  assert.equal(tags[0].textContent.trim(), "example.com");
  assert.equal(page.document.getElementById("clickfix-domain-error").hidden, true);
});

test("an invalid domain exclusion shows an inline error instead of clearing the input", async () => {
  const page = await loadSettings();
  page.setSendMessageBehavior("add_clickfix_domain_exclusion", () => ({ ok: false, code: "invalid_domain" }));

  page.document.getElementById("clickfix-domain-input").value = "not a domain";
  await page.document.getElementById("clickfix-domain-add").fire("click");

  assert.equal(page.document.getElementById("clickfix-domain-error").hidden, false);
  assert.equal(page.document.getElementById("clickfix-domain-input").value, "not a domain");
});

test("removing a domain exclusion sends the domain and re-renders the list", async () => {
  const page = await loadSettings({
    stored: { settings: { clickfix: { mode: "warn", excluded_domains: ["example.com"] } } },
  });
  page.setSendMessageBehavior("remove_clickfix_domain_exclusion", () => ({
    ok: true,
    clickfix: { mode: "warn", excluded_domains: [] },
  }));

  await page.document.getElementById("clickfix-domain-list").querySelector(".tag-remove").fire("click");

  assert.equal(page.lastMessageOfType("remove_clickfix_domain_exclusion")?.domain, "example.com");
  assert.equal(page.document.getElementById("clickfix-domain-list").querySelectorAll(".tag").length, 0);
});

// =============================================================================
// DEVICE CODE AUTHENTICATION (issue #75)
// =============================================================================

test("a fresh install with no stored keys still hides every developer-mode section", async () => {
  // chrome.storage.local is completely empty on first run, and the worker's
  // startup repair writes nothing when everything is already at its default,
  // so the page's initial full read must render the defaults itself (issue
  // #76) -- the static hidden attributes in settings.html are only an
  // anti-flash fallback, and these fake elements deliberately start visible.
  const page = await loadSettings({
    stored: { trusted_list: undefined, muted_list: undefined, settings: undefined, analysis_history: undefined },
  });

  [
    "manual-sites-section", "clickfix-warn-mode-row", "device-code-auth-row",
    "device-flow-section", "reset-defaults-row", "analysis-history-section",
  ].forEach((id) => {
    assert.equal(page.document.getElementById(id).hidden, true, `${id} must be hidden on a fresh install`);
  });
  assert.equal(page.document.getElementById("developer-mode-toggle").checked, false);
  assert.equal(page.document.getElementById("device-code-auth-toggle").checked, false);
});

test("device code auth defaults to blocked and stays hidden outside developer mode", async () => {
  const page = await loadSettings();
  assert.equal(page.document.getElementById("device-code-auth-row").hidden, true);
  assert.equal(page.document.getElementById("reset-defaults-row").hidden, true);
  assert.equal(page.document.getElementById("device-code-auth-toggle").checked, false);
});

test("a stored allowed mode renders while developer mode is on", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true, device_code_auth: "allowed" } } });
  assert.equal(page.document.getElementById("device-code-auth-row").hidden, false);
  assert.equal(page.document.getElementById("reset-defaults-row").hidden, false);
  assert.equal(page.document.getElementById("device-code-auth-toggle").checked, true);
});

test("allowing device code auth asks for confirmation and sends the mode", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  global.confirm = () => true;

  const toggle = page.document.getElementById("device-code-auth-toggle");
  toggle.checked = true;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_device_code_auth")?.mode, "allowed");
});

test("declining the allow confirmation keeps device code auth blocked", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  global.confirm = () => false;

  const toggle = page.document.getElementById("device-code-auth-toggle");
  toggle.checked = true;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_device_code_auth"), undefined);
  assert.equal(toggle.checked, false);
});

test("switching back to blocked does not ask for confirmation", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true, device_code_auth: "allowed" } } });
  global.confirm = () => {
    throw new Error("confirm() must not be called when tightening protection");
  };

  const toggle = page.document.getElementById("device-code-auth-toggle");
  toggle.checked = false;
  await toggle.fire("change");

  assert.equal(page.lastMessageOfType("set_device_code_auth")?.mode, "blocked");
});

test("resetting to defaults asks for confirmation and sends the reset", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  global.confirm = () => true;

  await page.document.getElementById("reset-defaults-btn").fire("click");

  assert.equal(page.lastMessageOfType("reset_advanced_settings")?.type, "reset_advanced_settings");
});

test("declining the reset confirmation sends nothing", async () => {
  const page = await loadSettings({ stored: { settings: { developer_mode: true } } });
  global.confirm = () => false;

  await page.document.getElementById("reset-defaults-btn").fire("click");

  assert.equal(page.lastMessageOfType("reset_advanced_settings"), undefined);
});

// =============================================================================
// DEVICE-CODE PHISHING PROTECTION (issue #39)
// =============================================================================

function userEndpoint(overrides = {}) {
  return { id: "endpoint-1", hostname: "sso.corp.example", path: "/device", ...overrides };
}

test("built-in device-flow endpoints render read-only", async () => {
  const page = await loadSettings({
    deviceFlowBuiltins: [{
      id: "seed-github-1",
      provider: "GitHub",
      hostname: "github.com",
      path: "/login/device",
      trustedInitiatorDomains: ["github.com"],
    }],
  });

  const container = page.document.getElementById("device-flow-builtin-list");
  const tags = container.querySelectorAll(".tag");
  assert.equal(tags.length, 1);
  assert.match(tags[0].textContent, /GitHub/);
  assert.match(tags[0].textContent, /github\.com\/login\/device/);
  assert.equal(container.querySelectorAll(".tag-remove").length, 0, "built-ins must expose no remove control");
  assert.equal(container.querySelectorAll(".tag-edit").length, 0, "built-ins must expose no edit control");

  const initiators = page.document.getElementById("device-flow-trusted-initiator-list");
  assert.match(initiators.querySelector(".tag").textContent, /GitHub: github\.com/);
  assert.equal(initiators.querySelectorAll(".tag-remove").length, 0, "trusted initiators must be read-only");
  assert.equal(initiators.querySelectorAll(".tag-edit").length, 0, "trusted initiators must be read-only");
});

test("stored user endpoints render with edit and remove controls", async () => {
  const page = await loadSettings({ stored: { settings: { device_flow_user_endpoints: [userEndpoint()] } } });

  const container = page.document.getElementById("device-flow-user-list");
  assert.match(container.querySelector(".tag").textContent, /sso\.corp\.example\/device/);
  assert.equal(container.querySelectorAll(".tag-edit").length, 1);
  assert.equal(container.querySelectorAll(".tag-remove").length, 1);
});

test("adding a user endpoint sends the raw url and renders the response", async () => {
  const page = await loadSettings();
  page.setSendMessageBehavior("add_device_flow_endpoint", () => ({
    ok: true,
    device_flow_user_endpoints: [userEndpoint()],
  }));

  page.document.getElementById("device-flow-endpoint-input").value = "sso.corp.example/device";
  await page.document.getElementById("device-flow-endpoint-add").fire("click");

  assert.equal(page.lastMessageOfType("add_device_flow_endpoint")?.endpoint, "sso.corp.example/device");
  assert.equal(page.document.getElementById("device-flow-user-list").querySelectorAll(".tag").length, 1);
  assert.equal(page.document.getElementById("device-flow-endpoint-input").value, "");
  assert.equal(page.document.getElementById("device-flow-endpoint-error").hidden, true);
});

test("an invalid endpoint shows an inline error and keeps the input", async () => {
  const page = await loadSettings();
  page.setSendMessageBehavior("add_device_flow_endpoint", () => ({ ok: false, code: "invalid_url" }));

  page.document.getElementById("device-flow-endpoint-input").value = "not an endpoint";
  await page.document.getElementById("device-flow-endpoint-add").fire("click");

  assert.equal(page.document.getElementById("device-flow-endpoint-error").hidden, false);
  assert.equal(page.document.getElementById("device-flow-endpoint-input").value, "not an endpoint");
});

test("editing a user endpoint fills the form and sends an update for the same id", async () => {
  const page = await loadSettings({ stored: { settings: { device_flow_user_endpoints: [userEndpoint()] } } });
  page.setSendMessageBehavior("update_device_flow_endpoint", () => ({
    ok: true,
    device_flow_user_endpoints: [userEndpoint({ path: "/device2" })],
  }));

  await page.document.getElementById("device-flow-user-list").querySelector(".tag-edit").fire("click");
  const input = page.document.getElementById("device-flow-endpoint-input");
  assert.equal(input.value, "sso.corp.example/device");
  assert.equal(page.document.getElementById("device-flow-endpoint-add").textContent, "Save");
  assert.equal(page.document.getElementById("device-flow-endpoint-cancel").hidden, false);

  input.value = "sso.corp.example/device2";
  await page.document.getElementById("device-flow-endpoint-add").fire("click");

  const sent = page.lastMessageOfType("update_device_flow_endpoint");
  assert.equal(sent?.id, "endpoint-1");
  assert.equal(sent?.endpoint, "sso.corp.example/device2");
  assert.equal(page.document.getElementById("device-flow-endpoint-add").textContent, "Add");
  assert.match(page.document.getElementById("device-flow-user-list").querySelector(".tag").textContent, /device2/);
});

test("cancelling an edit resets the form without sending anything", async () => {
  const page = await loadSettings({ stored: { settings: { device_flow_user_endpoints: [userEndpoint()] } } });

  await page.document.getElementById("device-flow-user-list").querySelector(".tag-edit").fire("click");
  await page.document.getElementById("device-flow-endpoint-cancel").fire("click");

  assert.equal(page.document.getElementById("device-flow-endpoint-input").value, "");
  assert.equal(page.document.getElementById("device-flow-endpoint-add").textContent, "Add");
  assert.equal(page.document.getElementById("device-flow-endpoint-cancel").hidden, true);
  assert.equal(page.lastMessageOfType("update_device_flow_endpoint"), undefined);
});

test("removing a user endpoint sends its id and re-renders the list", async () => {
  const page = await loadSettings({ stored: { settings: { device_flow_user_endpoints: [userEndpoint()] } } });
  page.setSendMessageBehavior("remove_device_flow_endpoint", () => ({ ok: true, device_flow_user_endpoints: [] }));

  await page.document.getElementById("device-flow-user-list").querySelector(".tag-remove").fire("click");

  assert.equal(page.lastMessageOfType("remove_device_flow_endpoint")?.id, "endpoint-1");
  assert.equal(page.document.getElementById("device-flow-user-list").querySelectorAll(".tag").length, 0);
});
