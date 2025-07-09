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

  const { campaignData = {}, pendingUpload = {}, resumeIndex = 0 } =
    await chrome.storage.local.get(["campaignData", "pendingUpload", "resumeIndex"]);

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

  // Start login detection instead of immediate automation
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

async function consolidateData() {
  console.log("🔍 Consolidating data from campaignData...");
  
  try {
    // Get campaign data from Chrome storage
    const { campaignData = {} } = await chrome.storage.local.get(["campaignData"]);
    const nestedCampaign = Object.values(campaignData)[0];
    
    if (!nestedCampaign?.campaignData) {
      console.warn("⚠️ No campaign data found");
      return null;
    }
    
    // Get domain configuration from consoSetup.json
    const domain = window.location.hostname.replace(/^www\./, "");
    const domainConfig = await getDomainConfig(domain);
    
    if (!domainConfig || Object.keys(domainConfig).length === 0) {
      console.warn(`⚠️ No configuration found for domain: ${domain}`);
      return null;
    }
    
    console.log(`🎯 Consolidating data for domain: ${domain}`);
    
    // Extract data from campaignData
    const itemvalue = {
      address: nestedCampaign.campaignData.addressBox || "",
      website: nestedCampaign.campaignData.websiteBox || "",
      description: nestedCampaign.campaignData.longDescriptionBox || "",
      service1: nestedCampaign.campaignData.service1Box || "",
      service2: nestedCampaign.campaignData.service2Box || "",
      service3: nestedCampaign.campaignData.service3Box || "",
      service4: nestedCampaign.campaignData.service4Box || "",
      service5: nestedCampaign.campaignData.service5Box || "",
      numemployee: nestedCampaign.campaignData.employeesBox || "",
      yearestab: nestedCampaign.campaignData.yearFormationBox || "",
      payment: nestedCampaign.campaignData.paymentMethodsBox || "",
      hours: nestedCampaign.campaignData.businessHoursBox || "",
      telephone: nestedCampaign.campaignData.contactTelephoneBox || "",
      mobile: nestedCampaign.campaignData.mobileNumberBox || "",
      fax: nestedCampaign.campaignData.faxNumberBox || "",
      email: nestedCampaign.campaignData.contactEmailBox || "",
      facebook: nestedCampaign.campaignData.facebookBox || "",
      twitter: nestedCampaign.campaignData.twitterBox || "",
      linkedin: nestedCampaign.campaignData.linkedinBox || "",
      pinterest: nestedCampaign.campaignData.pinterestBox || "",
      instagram: nestedCampaign.campaignData.instagramBox || "",
      tiktok: nestedCampaign.campaignData.tiktokBox || "",
      youtube: nestedCampaign.campaignData.youtubeBox || "",
      city: nestedCampaign.campaignData.city || "",
      state: nestedCampaign.campaignData.state || "",
      zipcode: nestedCampaign.campaignData.zipcode || ""
    };
    
    // Check if this is a special site
    const isSpecialSite = ["agreatertown.com", "yenino.com", "bpublic.com", "bizmakersamerica.org", "wegotaguy.net"].includes(domain);
    const removeStrongTags = domain === "bestincom.com";
    const showRawTags = isSpecialSite;
    
    // Helper function to format labels
    const formatLabel = (label, key) => {
      if (domainConfig[key] !== "TRUE" || !itemvalue[key]) return "";
      const labelText = removeStrongTags ? `${label}:<br/>` : `<strong>${label}:</strong><br/>`;
      return showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;${label}:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${itemvalue[key]}&lt;br/&gt;&lt;br/&gt;`
        : `${labelText}${itemvalue[key]}<br/><br/>`;
    };
    
    // Format website
    const formatWebsite = (website) => {
      if (domainConfig.website !== "TRUE" || !website) return "";
      return showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Website:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;&lt;a href="${website}" target="_blank"&gt;${website}&lt;/a&gt;&lt;br/&gt;&lt;br/&gt;`
        : `${removeStrongTags ? "Website:<br/>" : "<strong>Website:</strong><br/>"}<a href="${website}" target="_blank">${website}</a><br/><br/>`;
    };
    
    // Format business hours
    const formatBusinessHours = (hours) => {
      if (domainConfig.hours !== "TRUE" || !hours) return "";
      return showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Business Hours:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${hours.replace(/\n/g, "&lt;br/&gt;")}&lt;br/&gt;&lt;br/&gt;`
        : `${removeStrongTags ? "Business Hours:<br/>" : "<strong>Business Hours:</strong><br/>"}${hours.replace(/\n/g, "<br/>")}<br/><br/>`;
    };
    
    // Format services
    const formatServices = () => {
      let servicesList = [itemvalue.service1, itemvalue.service2, itemvalue.service3, itemvalue.service4, itemvalue.service5].filter(s => s);
      if (domainConfig.listofservices !== "TRUE" || servicesList.length === 0) return "";
      const label = servicesList.length === 1 ? "Service" : "List of Services";
      let services = servicesList.join(showRawTags ? "&lt;br/&gt;" : "<br/>");
      return showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;${label}:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${services}&lt;br/&gt;&lt;br/&gt;`
        : `${removeStrongTags ? `${label}:<br/>` : `<strong>${label}:</strong><br/>`}${services}<br/><br/>`;
    };
    
    // Format description
    const formatDescription = () => {
      if (domainConfig.description !== "TRUE" || !itemvalue.description) return "";
      
      const hasOtherDetails = 
        (domainConfig.address === "TRUE" && itemvalue.address) ||
        (domainConfig.website === "TRUE" && itemvalue.website) ||
        (domainConfig.listofservices === "TRUE" && itemvalue.service1) ||
        (domainConfig.telephone === "TRUE" && itemvalue.telephone) ||
        (domainConfig.hours === "TRUE" && itemvalue.hours) ||
        (domainConfig.email === "TRUE" && itemvalue.email) ||
        (domainConfig.mobile === "TRUE" && itemvalue.mobile) ||
        (domainConfig.fax === "TRUE" && itemvalue.fax) ||
        (domainConfig.numemployee === "TRUE" && itemvalue.numemployee) ||
        (domainConfig.yearestab === "TRUE" && itemvalue.yearestab) ||
        (domainConfig.payment === "TRUE" && itemvalue.payment) ||
        (domainConfig.facebook === "TRUE" && itemvalue.facebook) ||
        (domainConfig.twitter === "TRUE" && itemvalue.twitter) ||
        (domainConfig.linkedin === "TRUE" && itemvalue.linkedin) ||
        (domainConfig.pinterest === "TRUE" && itemvalue.pinterest) ||
        (domainConfig.instagram === "TRUE" && itemvalue.instagram) ||
        (domainConfig.tiktok === "TRUE" && itemvalue.tiktok) ||
        (domainConfig.youtube === "TRUE" && itemvalue.youtube);

      const formatted = itemvalue.description.replace(/\n/g, showRawTags ? "&lt;br/&gt;" : "<br/>");
      return showRawTags
        ? `${hasOtherDetails ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Description:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;` : ""}${formatted}&lt;br/&gt;&lt;br/&gt;`
        : `${hasOtherDetails ? (removeStrongTags ? "Description:<br/>" : "<strong>Description:</strong><br/>") : ""}${formatted}<br/><br/>`;
    };
    
    // Build consolidated content
    let formattedContent = "";
    
    // Address logic (simplified - always show full address)
    if (domainConfig.address === "TRUE" && itemvalue.address) {
      formattedContent += formatLabel("Address", "address");
    }
    
    formattedContent += formatWebsite(itemvalue.website);
    formattedContent += formatDescription();
    formattedContent += formatServices();
    formattedContent += formatLabel("Number of Employees", "numemployee");
    formattedContent += formatLabel("Date of Company Formation", "yearestab");
    formattedContent += formatLabel("Payment Method", "payment");
    formattedContent += formatBusinessHours(itemvalue.hours);
    
    // Contact information section
    if ((domainConfig.telephone === "TRUE" && itemvalue.telephone) || 
        (domainConfig.email === "TRUE" && itemvalue.email) || 
        (domainConfig.mobile === "TRUE" && itemvalue.mobile) || 
        (domainConfig.fax === "TRUE" && itemvalue.fax)) {
      formattedContent += showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;For more information, please contact us with the details below:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;&lt;br/&gt;`
        : `${removeStrongTags ? "For more information, please contact us with the details below:<br/><br/>" : "<strong>For more information, please contact us with the details below:</strong><br/><br/>"}`;
      formattedContent += formatLabel("Contact Telephone", "telephone");
      formattedContent += formatLabel("Contact Email", "email");
      formattedContent += formatLabel("Mobile Number", "mobile");
      formattedContent += formatLabel("Fax Number", "fax");
    }
    
    // Social media section
    if (["facebook", "twitter", "linkedin", "pinterest", "instagram", "tiktok", "youtube"].some(key => domainConfig[key] === "TRUE" && itemvalue[key])) {
      formattedContent += showRawTags
        ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Social Media Profiles:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;`
        : `${removeStrongTags ? "Social Media Profiles:<br/>" : "<strong>Social Media Profiles:</strong><br/>"}`;
      ["facebook", "twitter", "linkedin", "pinterest", "instagram", "tiktok", "youtube"].forEach(key => {
        if (domainConfig[key] === "TRUE" && itemvalue[key]) {
          formattedContent += showRawTags
            ? `&lt;a href="${itemvalue[key]}" target="_blank"&gt;${itemvalue[key]}&lt;/a&gt;&lt;br/&gt;`
            : `<a href="${itemvalue[key]}" target="_blank">${itemvalue[key]}</a><br/>`;
        }
      });
    }
    
    console.log("✅ Data consolidated successfully");
    return formattedContent;
    
  } catch (error) {
    console.error("❌ Error consolidating data:", error);
    return null;
  }
}

async function injectConsolidatedDataToFroala() {
  console.log("🔍 Injecting consolidated data to Froala editor...");
  
  try {
    // Get consolidated content
    const consolidatedContent = await consolidateData();
    
    if (!consolidatedContent) {
      console.warn("⚠️ No consolidated content available");
      return false;
    }
    
    // Find Froala editor
    const froalaEditor = document.querySelector('.fr-element[contenteditable="true"]') || 
                        document.querySelector('[data-froala-editor]') ||
                        document.querySelector('.fr-box .fr-element');
    
    if (!froalaEditor) {
      console.warn("⚠️ Froala editor not found");
      return false;
    }
    
    console.log("✅ Found Froala editor, injecting content...");
    
    // Focus the editor first
    froalaEditor.focus();
    
    // Clear existing content
    froalaEditor.innerHTML = '';
    
    // Inject the consolidated content
    froalaEditor.innerHTML = consolidatedContent;
    
    // Trigger Froala events to ensure proper rendering
    froalaEditor.dispatchEvent(new Event('input', { bubbles: true }));
    froalaEditor.dispatchEvent(new Event('change', { bubbles: true }));
    
    // If Froala API is available, use it
    if (window.FroalaEditor && froalaEditor.closest('.fr-box')) {
      const editorInstance = window.FroalaEditor.instances.find(instance => 
        instance.el === froalaEditor || instance.el.contains(froalaEditor)
      );
      
      if (editorInstance) {
        editorInstance.html.set(consolidatedContent);
        console.log("✅ Content injected via Froala API");
      }
    }
    
    // Add visual feedback
    froalaEditor.style.border = "2px solid #4CAF50";
    
    console.log("✅ Consolidated data injected to Froala editor successfully");
    return true;
    
  } catch (error) {
    console.error("❌ Error injecting to Froala:", error);
    return false;
  }
}