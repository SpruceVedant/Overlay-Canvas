async function ping(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "DEV_CANVAS_PING" });
    return true;
  } catch (_) {
    return false;
  }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  
  for (let i = 0; i < 10; i++) {
    if (await ping(tabId)) return;
    await new Promise(r => setTimeout(r, 60));
  }
}

async function injectOrToggle(tabId) {
  if (!(await ping(tabId))) {
    await inject(tabId);
  }
  await chrome.tabs.sendMessage(tabId, { type: "DEV_CANVAS_TOGGLE" });
}

chrome.action.onClicked.addListener((tab) => tab?.id && injectOrToggle(tab.id));

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-dev-canvas") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await injectOrToggle(tab.id);
});
