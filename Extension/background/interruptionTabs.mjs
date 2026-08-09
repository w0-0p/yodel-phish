export function createInterruptionTabs({
  tabs,
  interruptionUrl,
  store,
  removeStored,
  readyTimeoutMs,
}) {
  const readyWaiters = new Map();

  function waitUntilReady(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        readyWaiters.delete(tabId);
        resolve(false);
      }, readyTimeoutMs);
      readyWaiters.set(tabId, (ready) => {
        clearTimeout(timeout);
        readyWaiters.delete(tabId);
        resolve(ready);
      });
    });
  }

  function isWaiting(tabId) {
    return readyWaiters.has(tabId);
  }

  function acknowledgeReady(tabId) {
    const settle = readyWaiters.get(tabId);
    if (settle === undefined) return false;
    settle(true);
    return true;
  }

  function cancelWait(tabId) {
    readyWaiters.get(tabId)?.(false);
  }

  async function open({ analysedTabId, entry, isCurrent }) {
    let interruptionTabId;
    let stored = false;
    let succeeded = false;
    let result = { ok: false };

    try {
      const analysedTab = await tabs.get(analysedTabId);
      const tab = await tabs.create({
        url: "about:blank",
        active: false,
        windowId: analysedTab.windowId,
        openerTabId: analysedTabId,
      });
      interruptionTabId = tab.id;
      if (interruptionTabId === undefined || !isCurrent()) return result;

      await store({ ...entry, interruptionTabId });
      stored = true;
      const ready = waitUntilReady(interruptionTabId);
      await tabs.update(interruptionTabId, { url: interruptionUrl, active: true });
      if (!(await ready) || !isCurrent()) return result;

      succeeded = true;
      result = { ok: true, tabId: interruptionTabId };
      return result;
    } catch (error) {
      result = { ok: false, error };
      return result;
    } finally {
      if (!succeeded && interruptionTabId !== undefined) {
        cancelWait(interruptionTabId);
        if (stored) await removeStored(interruptionTabId).catch(() => {});
        await tabs.remove(interruptionTabId).catch(() => {});
      }
    }
  }

  return { acknowledgeReady, cancelWait, isWaiting, open };
}
