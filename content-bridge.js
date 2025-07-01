// content-bridge.js
// Relay messages between the web page and the extension

window.addEventListener('message', (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;
  if (event.data && event.data.type === 'CBPHAA_COMMAND') {
    chrome.runtime.sendMessage(event.data.command, (response) => {
      window.postMessage({
        type: 'CBPHAA_RESPONSE',
        response: response,
        requestId: event.data.requestId
      }, '*');
    });
  }
}); 