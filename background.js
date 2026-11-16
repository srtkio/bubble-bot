importScripts('llm.js');

// An unpacked extension serves its files straight from disk, so edits to keys.txt apply without a reload.
async function loadKeys() {
  const res = await fetch(chrome.runtime.getURL('keys.txt'), { cache: 'no-store' });
  return parseKeys(await res.text());
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // An extension API call every 25s keeps this worker alive while a slow model answers.
  const keepAlive = setInterval(chrome.runtime.getPlatformInfo, 25000);
  loadKeys()
    .then(keys => solve(keys, msg))
    .then(sendResponse, e => sendResponse({ error: e.message }))
    .finally(() => clearInterval(keepAlive));
  return true; // the reply comes later
});
