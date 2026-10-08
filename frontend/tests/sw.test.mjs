import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Run the real service worker against a stand-in for its global scope.
const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://split.example";

function worker(windows = []) {
  const listeners = {};
  const record = { shown: [], opened: [], badges: [] };
  const self = {
    addEventListener: (type, listener) => (listeners[type] = listener),
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    navigator: { setAppBadge: async (count) => record.badges.push(count) },
    registration: { showNotification: async (title, options) => record.shown.push({ title, options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => record.opened.push(url),
    },
  };
  vm.runInNewContext(source, { self, URL });
  record.dispatch = async (type, event) => {
    let pending;
    listeners[type]({ ...event, waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  return record;
}

function appWindow(url) {
  const window = { url, messages: [], focused: false };
  window.postMessage = (message) => window.messages.push(message);
  window.focus = async () => (window.focused = true);
  return window;
}

// Objects made inside the worker's realm have their own prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const push = (message) => ({ data: { json: () => message, text: () => JSON.stringify(message) } });

test("A push becomes a notification, a badge, and a nudge to any open app", async () => {
  const open = appWindow(`${ORIGIN}/`);
  const sw = worker([open]);
  await sw.dispatch("push", push({
    id: "n1", title: "Flat 42", body: "Andrey added “Pizza” · RUB 1,800.00", url: "/teams/t/expenses/e?n=n1", unread: 3,
  }));

  assert.equal(sw.shown.length, 1);
  const { title, options } = sw.shown[0];
  assert.equal(title, "Flat 42");
  assert.equal(options.body, "Andrey added “Pizza” · RUB 1,800.00");
  assert.equal(options.tag, "n1"); // one entry per notification, never replaced by the next
  assert.equal(options.data.url, "/teams/t/expenses/e?n=n1");
  assert.equal(options.badge, "/badge-96.png");
  assert.deepEqual(sw.badges, [3]);
  assert.deepEqual(plain(open.messages), [{ type: "push" }]);
});

test("An unreadable payload still shows something rather than nothing", async () => {
  const sw = worker();
  await sw.dispatch("push", { data: { json: () => { throw new SyntaxError("bad"); }, text: () => "plain text" } });
  assert.equal(sw.shown[0].title, "Split");
  assert.equal(sw.shown[0].options.body, "plain text");
  assert.equal(sw.shown[0].options.data.url, "/notifications");
});

test("A tap routes the open app in place instead of opening a second copy", async () => {
  const open = appWindow(`${ORIGIN}/teams/t`);
  const sw = worker([appWindow("https://elsewhere.example/"), open]);
  let closed = false;
  await sw.dispatch("notificationclick", {
    notification: { data: { url: "/teams/t/expenses/e?n=n1" }, close: () => (closed = true) },
  });
  assert.equal(closed, true);
  assert.deepEqual(plain(open.messages), [{ type: "open", url: "/teams/t/expenses/e?n=n1" }]);
  assert.equal(open.focused, true);
  assert.deepEqual(sw.opened, []);
});

test("With the app closed, a tap opens it at the expense", async () => {
  const sw = worker([]);
  await sw.dispatch("notificationclick", {
    notification: { data: { url: "/teams/t/expenses/e?n=n1" }, close: () => {} },
  });
  assert.deepEqual(sw.opened, [`${ORIGIN}/teams/t/expenses/e?n=n1`]);
});
