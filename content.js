// Safe global guard to avoid duplicate injection
if (!window.__contentInjected) {
  window.__contentInjected = true;

  const mode = window.__AUTOMATION_MODE__ || "automation";
  let paused = false, resumeSignal = null;
  let automationRunning = false;
  let loginDetectionActive = false;
  let automationStatus = {
    isRunning: false,
    currentStep: 0,
    totalSteps: 0,
    lastUpdated: null,
    errors: []
  };

  // Function to report automation status to background script
  function reportAutomationStatus(status) {
    automationStatus = { ...automationStatus, ...status, lastUpdated: new Date().toISOString() };
    
    chrome.runtime.sendMessage({
      action: 'updateAutomationStatus',
      status: automationStatus
    });
  }

  // Function to detect successful login
  function detectLoginSuccess() {
    if (loginDetectionActive) return;
    loginDetectionActive = true;
    
    console.log("🔍 Starting login detection...");
    
    // Monitor for login success
    const observer = new MutationObserver((mutations) => {
      if (checkCurrentPage()) {
        observer.disconnect();
        loginDetectionActive = false;
      }
    });
    
    // Also check URL changes
    let lastUrl = window.location.href;
    const urlCheckInterval = setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (checkCurrentPage()) {
          clearInterval(urlCheckInterval);
          observer.disconnect();
          loginDetectionActive = false;
        }
      }
    }, 1000);
    
    // Start observing DOM changes
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // Timeout after 30 seconds to avoid infinite waiting
    setTimeout(() => {
      if (loginDetectionActive) {
        console.log("⏰ Login detection timeout - starting automation anyway");
        observer.disconnect();
        clearInterval(urlCheckInterval);
        loginDetectionActive = false;
        startAutomation();
      }
    }, 30000);
  }
  
  // Function to start automation
  function startAutomation() {
    if (automationRunning) {
      console.warn("⚠️ Automation already running");
      return;
    }
    
    console.log("🚀 Starting automation after login detection");
    reportAutomationStatus({ isRunning: true, currentStep: 0 });
    runAuto(true); // Start fresh
  }

  function setupControls() {
    window.__AUTOMATION_STATE__ = {
      paused: false,
      aborted: false,
    };

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const state = window.__AUTOMATION_STATE__;

      switch (request.command) {
        case "pause":
          state.paused = true;
          reportAutomationStatus({ isRunning: false, status: 'paused' });
          console.log("⏸️ Automation paused");
          break;

        case "resume":
          state.paused = false;
          if (resumeSignal) {
            resumeSignal();
            resumeSignal = null;
          }
          reportAutomationStatus({ isRunning: true, status: 'resumed' });
          console.log("▶️ Automation resumed");
          break;

        case "abort":
          state.aborted = true;
          paused = false;
          if (resumeSignal) {
            resumeSignal();
            resumeSignal = null;
          }
          automationRunning = false;
          reportAutomationStatus({ isRunning: false, status: 'aborted' });
          chrome.storage.local.remove("resumeIndex", () => {
            console.log("🛑 Automation aborted & state reset.");
          });
          break;

        case "startFresh":
          const restart = () => {
            chrome.storage.local.remove("resumeIndex", () => {
              runAuto(true);
            });
          };
          if (automationRunning) {
            state.aborted = true;
            paused = false;
            if (resumeSignal) resumeSignal();
            resumeSignal = null;
            console.warn("♻️ Automation restarting fresh...");
            setTimeout(restart, 200);
          } else {
            restart();
          }
          break;

        case "triggerAutomation":
          console.log("🎯 Automation triggered from Firebase console");
          const data = request.data || {};
          if (data.forceStart) {
            // Force start even if already running
            if (automationRunning) {
              state.aborted = true;
              setTimeout(() => runAuto(true), 200);
            } else {
              runAuto(true);
            }
          } else {
            // Normal start
            if (!automationRunning) {
              runAuto(true);
            }
          }
          sendResponse({ success: true, message: 'Automation trigger received' });
          break;

        case "getAutomationStatus":
          sendResponse({
            success: true,
            status: automationStatus,
            isRunning: automationRunning,
            isPaused: state.paused,
            isAborted: state.aborted
          });
          break;
      }
    });
  }

  setupControls();

  const waitFor = (selector, timeout = 5000) => new Promise((resolve) => {
    const start = performance.now();
    const poll = () => {
      if (window.__AUTOMATION_STATE__.aborted) return resolve(null);
      const element = document.querySelector(selector);
      if (element) return resolve(element);
      if (performance.now() - start > timeout) return resolve(null);
      requestAnimationFrame(poll);
    };
    poll();
  });

  const pauseOnMissing = async (selector) => {
    paused = true;
    console.warn(`⏸️ Paused: missing ${selector}`);
    document.title = "⏸️ Paused";
    reportAutomationStatus({ isRunning: false, status: 'paused', error: `Missing element: ${selector}` });
    await new Promise((r) => (resumeSignal = r));
    if (window.__AUTOMATION_STATE__.aborted) throw new Error("Aborted");
    paused = false;
    document.title = "▶️ Resuming";
    reportAutomationStatus({ isRunning: true, status: 'resumed' });
  };

  const normalize = (path) => path.replace(/\/(\d+|[A-Za-z0-9-_]{8,})/g, "/:id");

  const getFilenames = () => {
    const hostname = window.location.hostname.replace(/^www\./, "");
    const path = normalize(location.pathname);
    return [`${hostname}${path}`.replace(/\//g, "_") + ".json", `${hostname}.json`];
  };

  const loadSteps = async () => {
    for (const filename of getFilenames()) {
      try {
        const response = await fetch(chrome.runtime.getURL(`automation/${filename}`));
        const steps = await response.json();
        reportAutomationStatus({ totalSteps: steps.length });
        return steps;
      } catch {
        console.warn(`⚠️ Missing automation file: ${filename}`);
      }
    }
    return null;
  };
  
  // utility.js or at the top of your automation script

async function getDomainConfig(domain) {
  try {
    const res = await fetch(chrome.runtime.getURL("automation/consoSetup.json"));
    const configData = await res.json();
    return configData[domain] || {};
  } catch (err) {
    console.error("Failed to load domain config:", err);
    return {};
  }
}


  async function runAuto(freshStart = false) {
  if (automationRunning) {
    console.warn("⚠️ Automation already running");
    return;
  }

  automationRunning = true;
  const state = window.__AUTOMATION_STATE__ || {};
  if (freshStart) {
    state.aborted = false;
    chrome.storage.local.remove("resumeIndex");
  }

  const steps = await loadSteps();
  if (!steps) {
    console.warn("❌ No automation steps found.");
    automationRunning = false;
    reportAutomationStatus({ isRunning: false, status: 'error', error: 'No automation steps found' });
    return;
  }

  const { formData = {}, pendingUpload = {}, resumeIndex = 0 } =
    await chrome.storage.local.get(["formData", "pendingUpload", "resumeIndex"]);

  const fileMap = pendingUpload.files || {}; // ✅ Use key-value format

  const results = [];
  const startIndex = freshStart ? 0 : resumeIndex;

  for (let i = startIndex; i < steps.length; i++) {
    if (state.aborted) break;

    while (state.paused) await new Promise((r) => setTimeout(r, 300));

    const { action, selector, valueKey, value } = steps[i];
    let el = await waitFor(selector);

    // Update automation status
    reportAutomationStatus({ 
      isRunning: true, 
      currentStep: i + 1, 
      totalSteps: steps.length,
      currentAction: action,
      currentSelector: selector
    });

    if (!el) {
      if (state.aborted) break;
      console.warn(`❌ [${i}] Missing element: ${selector}`);
      results.push({ i, action, selector, status: "not-found" });
      chrome.storage.local.set({ resumeIndex: i });
      try {
        await pauseOnMissing(selector);
      } catch {
        break;
      }
      continue;
    }
const uploadButtonConfig = steps.find(a => a.valueKey === "UploadButtonSave");


    try {
      if (action === "fill") {
        const val = value !== undefined ? value : formData[valueKey] || "";
        if (selector === '[name="profession_id"]' && el.tagName === "SELECT") {
          if (!el.querySelector("option[value='0000']")) {
            const opt = document.createElement("option");
            opt.value = "0000";
            opt.textContent = "Skip Category";
            el.insertBefore(opt, el.firstChild);
          }
          el.value = "0000";
        } else {
          el.value = val;
        }
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		el.dispatchEvent(new Event("blur", { bubbles: true })); // ✅ optional but useful
        el.style.border = "2px solid #4CAF50";
        console.log(`✅ [${i}] Filled ${selector} → ${val}`);
        results.push({ i, action, selector, value: val, status: "filled" });

      } 
else if (action === "richFill") {
  const domain = window.location.hostname.replace(/^www\./, "");
  const domainConfig = await getDomainConfig(domain);

  const finalHTML = await consofunction(domainConfig);

  try {
    await navigator.clipboard.writeText(finalHTML);
    console.log("✅ Copied to clipboard");
  } catch (err) {
    console.error("❌ Clipboard error", err);
  }

  // Wait for user to click the editor
  console.log("🟡 Waiting for user to click editor before injecting data...");
  const editorSelector = ".fr-element[contenteditable='true']";

  const onClickOnce = async (event) => {
    const el = event.target.closest(editorSelector);
    if (!el) return;

    document.removeEventListener("click", onClickOnce);

    el.focus();

    // Try execCommand("paste") if browser allows it
    try {
      const successful = document.execCommand("paste");
      if (!successful) {
        console.warn("⚠️ execCommand('paste') failed (likely blocked)");
      }
    } catch (e) {
      console.warn("⚠️ execCommand('paste') error:", e);
    }

    console.log(`✅ contentEditable populated after user interaction for ${domain}`);
    results.push({ i, action, selector: editorSelector, status: "paste-command-attempted" });
  };

  document.addEventListener("click", onClickOnce, { once: true });
}

else if (action === "click") {
        el.click();
        if (valueKey === "NextButtonSave") {
          chrome.storage.local.set({ resumeIndex: i + 1 });
          console.log("⏭️ Pausing after navigation.");
          automationRunning = false;
          reportAutomationStatus({ isRunning: false, status: 'paused', message: 'Paused after navigation' });
          return;
        }
        console.log(`🟢 [${i}] Clicked ${selector}`);
        results.push({ i, action, selector, status: "clicked" });

		} 
	//upload image	
else if (action === "uploadImages") {
  const fileInfo = fileMap[valueKey];
  if (!fileInfo) {
    console.warn(`⚠️ [${i}] No image found for ${valueKey}`);
    results.push({ i, action, selector, status: "no-image" });
  } else {
    const input = document.querySelector(selector);
    if (!input) {
      console.warn("❌ Image input not found for:", selector);
      results.push({ i, action, selector, status: "input-not-found" });
      return;
    }

    // Convert base64 to File
    const byteCharacters = atob(fileInfo.base64);
    const byteArray = new Uint8Array([...byteCharacters].map(c => c.charCodeAt(0)));
    const blob = new Blob([byteArray], { type: fileInfo.type });
    const file = new File([blob], fileInfo.name, { type: fileInfo.type });

    // Assign file using DataTransfer
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log("📸 Image assigned to", selector);

    // ✅ Wait for preview to load or input to reflect file
    await new Promise((resolve) => {
      let timeout;
      const observer = new MutationObserver(() => {
        if (input.files.length > 0) {
          clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(input, { attributes: true, childList: true, subtree: true });

      timeout = setTimeout(() => {
        observer.disconnect();
        console.warn("⚠️ Timeout waiting for file preview/attachment.");
        resolve();
      }, 5000);
    });

    // 🔁 Use dynamic selector from JSON for the save button
    const buttonSelector = uploadButtonConfig?.selector || ".btn.btn-primary.bold.upload-logo.col-md-8";
    const button = document.querySelector(buttonSelector);

    if (button) {
      await new Promise((resolve) => {
        setTimeout(() => {
          button.click();
          console.log("💾 Save Photo button clicked.");
          resolve();
        }, 300); // Delay to allow UI update
      });
    } else {
      console.warn("❌ Upload button not found for:", buttonSelector);
    }

    console.log(`🖼️ [${i}] Uploaded image for ${selector}`);
    results.push({ i, action, selector, status: "image-uploaded" });
  }
}
 else {
        console.warn(`⚠️ [${i}] Unknown action: ${action}`);
        results.push({ i, action, selector, status: "unknown" });
      }

      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`❌ [${i}] Error during action`, err);
      results.push({ i, action, selector, status: "error" });
      
      // Report error to background script
      reportAutomationStatus({ 
        isRunning: true, 
        errors: [...automationStatus.errors, { step: i, action, error: err.message }]
      });
    }
  }

  automationRunning = false;
  console.table(results);

  // Final status report
  const finalStatus = state.aborted ? 'aborted' : 'completed';
  reportAutomationStatus({ 
    isRunning: false, 
    status: finalStatus,
    results: results,
    completedAt: new Date().toISOString()
  });

  if (state.aborted) {
    alert("🛑 Automation aborted.");
  } else {
    alert("✅ Automation completed.");
  }
}

  // Start login detection instead of immediate automation
  if (mode === "automation") {
    detectLoginSuccess();
  }
}
