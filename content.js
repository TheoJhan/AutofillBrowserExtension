// Safe global guard to avoid duplicate injection
if (!window.__contentInjected) {
  window.__contentInjected = true;

  // --- Utility Functions ---
  function getResumeIndexKey() {
    const domain = window.location.hostname.replace(/^www\./, "");
    return `resumeIndex_${domain}`;
  }
  const normalize = (path) => path.replace(/\/(\d+|[A-Za-z0-9-_]{8,})/g, "/:id");
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

  // 2. State Variables
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

  // 3. Core Automation Functions
  function reportAutomationStatus(status) {
    automationStatus = { ...automationStatus, ...status, lastUpdated: new Date().toISOString() };
    try {
      chrome.runtime.sendMessage({
        action: 'updateAutomationStatus',
        status: automationStatus
      });
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        // Silently ignore or log if needed
        console.warn('Extension context invalidated, ignoring sendMessage.');
      } else {
        throw e;
      }
    }
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
    }, 5000);
  }
  
  // Function to start automation
  function startAutomation() {
    if (automationRunning) {
      console.warn("⚠️ Automation already running");
      return;
    }
    console.log("🚀 Starting automation after login detection");
    reportAutomationStatus({ isRunning: true, currentStep: 0 });
    runAuto(false); // Start from the stored/manual index, not always 0
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
          chrome.storage.local.remove(getResumeIndexKey(), () => {
            console.log("🛑 Automation aborted & state reset.");
          });
          break;

        case "startFresh":
          const restart = () => {
            chrome.storage.local.remove(getResumeIndexKey(), () => {
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

        case "manualSetResumeIndex":
          const resumeIndex = request.resumeIndex || 0;
          const key = getResumeIndexKey();
          chrome.storage.local.set({ [key]: resumeIndex }, () => {
            // If automation is running, abort and wait for it to stop, then start from new index
            if (automationRunning) {
              window.__AUTOMATION_STATE__.aborted = true;
              // Wait for automationRunning to become false, then start
              const waitAndStart = () => {
                if (!automationRunning) {
                  runAuto(false);
                } else {
                  setTimeout(waitAndStart, 100);
                }
              };
              waitAndStart();
            } else {
              runAuto(false);
            }
          });
          sendResponse && sendResponse({ success: true });
          break;
      }
    });
  }

  setupControls();

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
      chrome.storage.local.remove(getResumeIndexKey());
    }

    const steps = await loadSteps();
    if (!steps) {
      console.warn("❌ No automation steps found.");
      automationRunning = false;
      reportAutomationStatus({ isRunning: false, status: 'error', error: 'No automation steps found' });
      return;
    }

    const key = getResumeIndexKey();
    const result = await chrome.storage.local.get([key, "campaignData", "pendingUpload"]);
    const resumeIndex = result[key] || 0;
    const campaignData = result.campaignData || {};
    const pendingUpload = result.pendingUpload || {};
    const startIndex = freshStart ? 0 : resumeIndex;

    const fileMap = pendingUpload.files || {}; // ✅ Use key-value format

    const results = [];

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
        chrome.storage.local.set({ [getResumeIndexKey()]: i });
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
          const nestedCampaign = Object.values(campaignData)[0]; // since you keyed by docId
          const val = value !== undefined 
            ? value 
            : nestedCampaign?.campaignData?.[valueKey] || "";
          
          if (selector === '[name="profession_id"]' && el.tagName === "SELECT") {
            const mainCategory = nestedCampaign?.campaignData?.mainCategory;
            if (mainCategory && mainCategory !== "" && el.querySelector(`option[value="${mainCategory}"]`)) {
              el.value = mainCategory;
            } else {
              // Skip category - leave empty or set to empty value
              el.value = "";
            }
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            el.style.border = "2px solid #4CAF50";
            console.log(`✅ [${i}] Main category set to: ${el.value || "empty (skip)"}`);
            results.push({ i, action, selector, value: el.value, status: "filled" });
            continue;
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

          // Check if we should use consolidated data instead of consofunction
          const useConsolidatedData = valueKey === "consolidatedData" || value === "consolidatedData";
          
          let finalHTML;
          
          if (useConsolidatedData) {
            // Use consolidated data from campaignData
            finalHTML = await consolidateData();
            if (!finalHTML) {
              console.warn("⚠️ No consolidated data available, falling back to consofunction");
              finalHTML = await consofunction(domainConfig);
            }
          } else {
            // Use original consofunction
            finalHTML = await consofunction(domainConfig);
          }

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
            chrome.storage.local.set({ [getResumeIndexKey()]: i + 1 });
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
          // Fetch base64Data from storage
          const { base64Data = {} } = await chrome.storage.local.get(["base64Data"]);
          const base64String = base64Data[valueKey]; // valueKey might be 'logoBox', 'image1Box', etc.
          if (!base64String) {
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
            const matches = base64String.match(/^data:(.*);base64,(.*)$/);
            if (!matches) {
              console.warn("❌ Invalid base64 string for:", valueKey);
              results.push({ i, action, selector, status: "invalid-base64" });
              return;
            }
            const type = matches[1];
            const byteCharacters = atob(matches[2]);
            const byteArray = new Uint8Array([...byteCharacters].map(c => c.charCodeAt(0)));
            const blob = new Blob([byteArray], { type });
            const file = new File([blob], valueKey + ".png", { type });
            // Create a DataTransfer to simulate file selection
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            input.files = dataTransfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.style.border = "2px solid #4CAF50";
            console.log(`✅ [${i}] Uploaded image for ${valueKey}`);
            results.push({ i, action, selector, status: "uploaded" });
          }
        }
        else if (action === "initClearCheckbox") {  
          initClearCheckbox();
        }
        else if (action === "tickPaymentMethods") {
          const tickedCount = tickPaymentMethodCheckboxes();
          console.log(`✅ [${i}] Ticked ${tickedCount} payment method checkboxes`);
          results.push({ i, action, selector, status: "payment-methods-ticked", count: tickedCount });
        }
        else if (action === "tickSubcategory") {
          const tickedCount = await tickSubcategoryCheckboxes();
          console.log(`✅ [${i}] Ticked ${tickedCount} subcategory checkboxes`);
          results.push({ i, action, selector, status: "subcategory-ticked", count: tickedCount });
        }
        else if (action === "consolidateData") {
          const consolidatedContent = await consolidateData();
          if (consolidatedContent) {
            console.log(`✅ [${i}] Data consolidated successfully`);
            results.push({ i, action, selector, status: "data-consolidated", content: consolidatedContent });
          } else {
            console.warn(`⚠️ [${i}] Failed to consolidate data`);
            results.push({ i, action, selector, status: "consolidation-failed" });
          }
        }
        else if (action === "injectToFroala") {
          const success = await injectConsolidatedDataToFroala();
          if (success) {
            console.log(`✅ [${i}] Data injected to Froala editor successfully`);
            results.push({ i, action, selector, status: "froala-injected" });
          } else {
            console.warn(`⚠️ [${i}] Failed to inject data to Froala`);
            results.push({ i, action, selector, status: "froala-injection-failed" });
          }
        }
        else if (action === "waitForPopup") {
          const timeout = value ? parseInt(value) : 10000; // Use value as timeout if provided
          console.log(`⏳ [${i}] Waiting for popup: ${selector} (timeout: ${timeout}ms)`);
          
          const popup = await waitForPopup(selector, timeout);
          
          if (popup) {
            console.log(`✅ [${i}] Popup found: ${selector}`);
            results.push({ i, action, selector, status: "popup-found" });
          } else {
            console.warn(`⚠️ [${i}] Popup not found within timeout: ${selector}`);
            results.push({ i, action, selector, status: "popup-timeout" });
            
            // Optionally pause if popup doesn't appear
            if (state.aborted) break;
            try {
              await pauseOnMissing(selector);
            } catch {
              break;
            }
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

  function initClearCheckbox() {
    document.querySelectorAll('input[type="checkbox"]').forEach(el => {
      el.checked = false;
    });
  }

  function tickPaymentMethodCheckboxes() {
    console.log("🔍 Looking for payment method checkboxes...");
    
    // Common payment method keywords to look for
    const paymentMethods = [
      'credit card', 'debit card', 'credit/debit', 'credit and debit',
      'cash', 'cash payment',
      'digital wallet', 'digital wallets', 'e-wallet', 'ewallet',
      'bank transfer', 'bank transfers', 'wire transfer', 'bank deposit',
      'paypal', 'pay pal',
      'stripe', 'square',
      'apple pay', 'google pay', 'samsung pay',
      'venmo', 'zelle', 'cash app',
      'bitcoin', 'crypto', 'cryptocurrency',
      'check', 'cheque', 'money order'
    ];
    
    let tickedCount = 0;
    
    // Find all checkboxes on the page
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    
    checkboxes.forEach(checkbox => {
      // Get the associated label or nearby text
      let labelText = '';
      
      // Try to find label by 'for' attribute
      const label = document.querySelector(`label[for="${checkbox.id}"]`);
      if (label) {
        labelText = label.textContent.toLowerCase();
      }
      
      // If no label found, look for nearby text elements
      if (!labelText) {
        const parent = checkbox.parentElement;
        if (parent) {
          // Look for text in the same container
          const textElements = parent.querySelectorAll('span, div, p, label');
          textElements.forEach(el => {
            if (el.textContent && !labelText) {
              labelText += ' ' + el.textContent.toLowerCase();
            }
          });
        }
      }
      
      // Check if this checkbox is within a payment methods section
      let isInPaymentSection = false;
      let currentElement = checkbox;
      
      // Walk up the DOM tree to find payment-related containers
      while (currentElement && currentElement !== document.body) {
        const elementText = currentElement.textContent?.toLowerCase() || '';
        const elementClass = currentElement.className?.toLowerCase() || '';
        const elementId = currentElement.id?.toLowerCase() || '';
        
        if (elementText.includes('payment') || 
            elementText.includes('payment method') ||
            elementClass.includes('payment') ||
            elementId.includes('payment')) {
          isInPaymentSection = true;
          break;
        }
        
        currentElement = currentElement.parentElement;
      }
      
      // Check if checkbox text matches any payment method
      const matchesPaymentMethod = paymentMethods.some(method => 
        labelText.includes(method.toLowerCase())
      );
      
      // Tick the checkbox if it's a payment method and either:
      // 1. It's in a payment section, OR
      // 2. It directly matches a payment method keyword
      if ((isInPaymentSection || matchesPaymentMethod) && !checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('click', { bubbles: true }));
        
        // Add visual feedback
        checkbox.style.border = "2px solid #4CAF50";
        
        console.log(`✅ Ticked payment method checkbox: ${labelText.trim() || 'Unknown'}`);
        tickedCount++;
      }
    });
    
    console.log(`🎯 Total payment method checkboxes ticked: ${tickedCount}`);
    return tickedCount;
  }

  async function tickSubcategoryCheckboxes() {
    console.log("🔍 Looking for subcategory checkboxes...");
    
    // Get the subcategory from Chrome storage
    const { campaignData = {} } = await chrome.storage.local.get(["campaignData"]);
    const nestedCampaign = Object.values(campaignData)[0];
    const subcategory = nestedCampaign?.campaignData?.subcategory;
    
    if (!subcategory) {
      console.warn("⚠️ No subcategory found in campaign data");
      return 0;
    }
    
    console.log(`🎯 Looking for subcategory: "${subcategory}"`);
    
    let tickedCount = 0;
    
    // Find all checkboxes on the page
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    
    checkboxes.forEach(checkbox => {
      // Get the associated label or nearby text
      let labelText = '';
      
      // Try to find label by 'for' attribute
      const label = document.querySelector(`label[for="${checkbox.id}"]`);
      if (label) {
        labelText = label.textContent.trim();
      }
      
      // If no label found, look for nearby text elements
      if (!labelText) {
        const parent = checkbox.parentElement;
        if (parent) {
          // Look for text in the same container
          const textElements = parent.querySelectorAll('span, div, p, label');
          textElements.forEach(el => {
            if (el.textContent && !labelText) {
              labelText = el.textContent.trim();
            }
          });
        }
      }
      
      // Check if this checkbox is within a subcategory/category section
      let isInCategorySection = false;
      let currentElement = checkbox;
      
      // Walk up the DOM tree to find category-related containers
      while (currentElement && currentElement !== document.body) {
        const elementText = currentElement.textContent?.toLowerCase() || '';
        const elementClass = currentElement.className?.toLowerCase() || '';
        const elementId = currentElement.id?.toLowerCase() || '';
        
        if (elementText.includes('category') || 
            elementText.includes('subcategory') ||
            elementText.includes('business type') ||
            elementText.includes('service type') ||
            elementClass.includes('category') ||
            elementId.includes('category')) {
          isInCategorySection = true;
          break;
        }
        
        currentElement = currentElement.parentElement;
      }
      
      // Exact match check - the label text should exactly match the subcategory
      const exactMatch = labelText.toLowerCase() === subcategory.toLowerCase();
      
      // Tick the checkbox if it's an exact match and in a category section
      if (exactMatch && isInCategorySection && !checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('click', { bubbles: true }));
        
        // Add visual feedback
        checkbox.style.border = "2px solid #4CAF50";
        
        console.log(`✅ Ticked subcategory checkbox: "${labelText}" (matches "${subcategory}")`);
        tickedCount++;
      }
    });
    
    console.log(`🎯 Total subcategory checkboxes ticked: ${tickedCount}`);
    return tickedCount;
  }

  /**
   * Waits for an element to appear in the DOM (including popups/modals).
   * @param {string} selector - The CSS selector for the element.
   * @param {number} timeout - Maximum time to wait in ms (default: 10000).
   * @returns {Promise<Element|null>} Resolves with the element or null if not found in time.
   */
  function waitForPopup(selector, timeout = 10000) {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        if (window.__AUTOMATION_STATE__.aborted) return resolve(null);
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (performance.now() - start > timeout) return resolve(null);
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // 6. Startup Logic
  if (mode === "automation") {
    detectLoginSuccess();
  }
  const powerButton = document.querySelector('.power-btn');
  if (powerButton) {
    powerButton.classList.add('on');
    powerButton.style.borderColor = '#6effa7';
    powerButton.style.boxShadow = '0 0 25px rgba(110, 255, 167, 0.7)';
  }
}


