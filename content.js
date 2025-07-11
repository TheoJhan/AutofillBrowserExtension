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
  let automationStarting = false; // Flag to prevent multiple simultaneous starts
  let loginDetectionActive = false;
  let automationStatus = {
    isRunning: false,
    currentStep: 0,
    totalSteps: 0,
    lastUpdated: null,
    errors: []
  };

  // Function to notify popup about automation status changes
  function notifyPopupOfAutomationStatus(isRunning) {
    try {
      chrome.runtime.sendMessage({
        action: 'automationStatusChanged',
        isRunning: isRunning
      });
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.warn('Extension context invalidated, ignoring sendMessage.');
      } else {
        console.error('Error notifying popup:', e);
      }
    }
  }

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
  // Function to start automation
  async function startAutomation() {
    if (automationRunning || automationStarting) {
      console.warn("⚠️ Automation already running or starting");
      return;
    }
    
    automationStarting = true;
    
    // Get the current resume index before starting
    const key = getResumeIndexKey();
    const result = await chrome.storage.local.get([key]);
    const resumeIndex = result[key] || 0;
    
    console.log(`🚀 Starting automation after login detection`);
    console.log(`📍 Starting from index: ${resumeIndex} (${resumeIndex === 0 ? 'beginning' : 'resuming from previous step'})`);
    
    // Don't set automationRunning here - let runAuto() handle it
    notifyPopupOfAutomationStatus(true);
    reportAutomationStatus({ isRunning: true, currentStep: resumeIndex });
    
    // Use setTimeout to avoid race condition
    setTimeout(() => {
      runAuto(false); // Start from the stored/manual index, not always 0
    }, 100);
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
          sendResponse && sendResponse({ success: true, status: 'paused' });
          break;

        case "resume":
          state.paused = false;
          if (resumeSignal) {
            resumeSignal();
            resumeSignal = null;
          }
          reportAutomationStatus({ isRunning: true, status: 'resumed' });
          console.log("▶️ Automation resumed");
          sendResponse && sendResponse({ success: true, status: 'resumed' });
          break;

        case "abort":
          state.aborted = true;
          paused = false;
          if (resumeSignal) {
            resumeSignal();
            resumeSignal = null;
          }
          automationRunning = false;
          automationStarting = false; // Reset the starting flag
          notifyPopupOfAutomationStatus(false);
          reportAutomationStatus({ isRunning: false, status: 'aborted' });
          chrome.storage.local.remove(getResumeIndexKey(), () => {
            console.log("🛑 Automation aborted & state reset.");
          });
          sendResponse && sendResponse({ success: true, status: 'aborted' });
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
          console.log(`🔄 Setting resume index to: ${resumeIndex}`);
          
          chrome.storage.local.set({ [key]: resumeIndex }, () => {
            // If automation is running, abort and wait for it to stop, then start from new index
            if (automationRunning) {
              console.log("⚠️ Automation running, aborting first...");
              window.__AUTOMATION_STATE__.aborted = true;
              // Wait for automationRunning to become false, then start
              const waitAndStart = () => {
                if (!automationRunning) {
                  console.log("✅ Automation stopped, starting from new index");
                  runAuto(false);
                } else {
                  setTimeout(waitAndStart, 100);
                }
              };
              waitAndStart();
            } else {
              console.log("✅ Starting automation from new index");
              runAuto(false);
            }
          });
          sendResponse && sendResponse({ success: true, resumeIndex });
          break;

        // Firebase console commands (separated from UI commands)
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

        case "startFresh":
          console.log("♻️ Fresh start requested");
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
          sendResponse && sendResponse({ success: true, message: 'Fresh start initiated' });
          break;

        default:
          console.warn(`⚠️ Unknown command received: ${request.command}`);
          sendResponse && sendResponse({ success: false, error: 'Unknown command' });
          break;
      }
    });
  }

  setupControls();

  const getFilenames = () => {
    const hostname = window.location.hostname.replace(/^www\./, "");
    const path = normalize(location.pathname);
    // Prioritize general domain file first, then specific path file
    const filenames = [`${hostname}.json`, `${hostname}${path}`.replace(/\//g, "_") + ".json"];
    console.log(`📍 Current URL: ${window.location.href}`);
    console.log(`📍 Hostname: ${hostname}, Path: ${path}`);
    console.log(`📍 Looking for files: ${filenames.join(', ')}`);
    return filenames;
  };

  const loadSteps = async () => {
    const filenames = getFilenames();
    console.log(`🔍 Looking for automation files:`, filenames);
    
    for (const filename of filenames) {
      try {
        const response = await fetch(chrome.runtime.getURL(`automation/${filename}`));
        if (response.ok) {
          const steps = await response.json();
          console.log(`✅ Found automation file: ${filename} with ${steps.length} steps`);
          reportAutomationStatus({ totalSteps: steps.length });
          return steps;
        } else {
          console.warn(`⚠️ Automation file not found: ${filename} (HTTP ${response.status})`);
        }
      } catch (error) {
        console.warn(`⚠️ Error loading automation file: ${filename}`, error);
      }
    }
    console.error(`❌ No automation files found for domain. Tried:`, filenames);
    return null;
  };
  
  async function getDomainConfig(domain) {
    try {
      const res = await fetch(chrome.runtime.getURL("libs/consoSetup.json"));
      const configData = await res.json();
      
      // Find the configuration for the specific domain
      const domainConfig = configData.find(config => config.Sites === domain);
      
      if (domainConfig) {
        console.log(`✅ Found domain config for: ${domain}`);
        return domainConfig;
      } else {
        console.warn(`⚠️ No domain config found for: ${domain}`);
        return {};
      }
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
    automationStarting = false; // Reset the starting flag
    const state = window.__AUTOMATION_STATE__ || {};
    if (freshStart) {
      state.aborted = false;
      chrome.storage.local.remove(getResumeIndexKey());
    }

    const steps = await loadSteps();
    if (!steps) {
      console.warn("❌ No automation steps found.");
      automationRunning = false;
      automationStarting = false;
      reportAutomationStatus({ isRunning: false, status: 'error', error: 'No automation steps found' });
      return;
    }

    const key = getResumeIndexKey();
    const result = await chrome.storage.local.get([key, "campaignData", "pendingUpload"]);
    const resumeIndex = result[key] || 0;
    const campaignData = result.campaignData || {};
    const pendingUpload = result.pendingUpload || {};
    const startIndex = freshStart ? 0 : resumeIndex;

    console.log(`🎯 Automation execution details:`);
    console.log(`   • Fresh start: ${freshStart}`);
    console.log(`   • Resume index: ${resumeIndex}`);
    console.log(`   • Starting from step: ${startIndex}`);
    console.log(`   • Total steps available: ${steps.length}`);
    console.log(`   • Steps to execute: ${steps.length - startIndex}`);

    const fileMap = pendingUpload.files || {}; // ✅ Use key-value format

    const results = [];

    for (let i = startIndex; i < steps.length; i++) {
      if (state.aborted) break;

      while (state.paused) await new Promise((r) => setTimeout(r, 300));

      try {
        const { action, selector, valueKey, value, delay } = steps[i];

        // Delay support
        if (typeof delay === 'number' && delay > 0) {
          console.log(`⏳ Waiting for ${delay}ms before action "${action}" on selector "${selector}"`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        let el = null;
        const actionsWithoutSelector = ['tickSubcategory', 'consolidateData', 'injectToFroala', 'waitForPopup'];
        if (!actionsWithoutSelector.includes(action)) {
          el = await waitFor(selector);
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
        }

        // Update automation status
        reportAutomationStatus({ 
          isRunning: true, 
          currentStep: i + 1, 
          totalSteps: steps.length,
          currentAction: action,
          currentSelector: selector
        });

        // --- ACTION HANDLERS ---
        if (action === "fill" && el) {
          const nestedCampaign = Object.values(campaignData)[0]; // since you keyed by docId
          
          // Debug: Log the entire campaign data structure
          console.log(`🔍 Campaign data structure debug:`);
          console.log(`   • campaignData keys:`, Object.keys(campaignData));
          console.log(`   • nestedCampaign:`, nestedCampaign);
          console.log(`   • nestedCampaign.campaignData:`, nestedCampaign?.campaignData);
          console.log(`   • nestedCampaign.citations:`, nestedCampaign?.citations);
          
          const val = value !== undefined 
            ? value 
            : nestedCampaign?.campaignData?.[valueKey] || "";
          
          // Check for dynamic mode handling
          if (mode === "skipCategory1" && el.tagName === "SELECT") {
            // Get current domain for validation
            const currentDomain = window.location.hostname.replace(/^www\./, "");
            
            // Access mainCategory from the correct structure: campaignData.citations.mainCategory
            // Try multiple possible paths for citations data
            let citations = nestedCampaign?.campaignData?.citations;
            
            // Fallback: Check if citations is directly under nestedCampaign
            if (!citations) {
              citations = nestedCampaign?.citations;
              console.log(`🔄 Fallback: Found citations directly under nestedCampaign:`, citations);
            }
            
            // Handle citations as array - find the matching citation for current domain
            let mainCategory = null;
            let citationSite = null;
            
            if (Array.isArray(citations)) {
              const matchingCitation = citations.find(citation => citation.site === currentDomain);
              
              if (matchingCitation) {
                mainCategory = matchingCitation.mainCategory;
                citationSite = matchingCitation.site;
                console.log(`✅ Found matching citation for ${currentDomain}:`, matchingCitation);
              } else {
                console.warn(`⚠️ No citation found for domain: ${currentDomain}`);
                console.log(`🔍 Available citation sites:`, citations.map(c => c.site));
              }
            } else if (citations && typeof citations === 'object') {
              // Handle as single object (legacy format)
              mainCategory = citations.mainCategory;
              citationSite = citations.site;
            }
            
            console.log(`🔍 Dynamic category mode (skipCategory1):`);
            console.log(`   • Current domain: ${currentDomain}`);
            console.log(`   • Citation site: ${citationSite}`);
            console.log(`   • Main category: ${mainCategory}`);
            console.log(`   • Citations data:`, citations);
            
            // Check if domain matches
            if (citationSite && citationSite !== currentDomain) {
              console.warn(`⚠️ [${i}] Domain mismatch! Citation site "${citationSite}" doesn't match current domain "${currentDomain}"`);
              // Apply skip category logic
              if (!el.querySelector("option[value='0000']")) {
                const opt = document.createElement("option");
                opt.value = "0000";
                opt.textContent = "Skip Category";
                el.insertBefore(opt, el.firstChild);
                console.log(`✅ Added "Skip Category" option to ${selector}`);
              }
              el.value = "0000";
              console.log(`✅ [${i}] Category skipped due to domain mismatch`);
            } else if (mainCategory && mainCategory !== "") {
              // Find option by text content instead of value
              const matchingOption = Array.from(el.querySelectorAll('option')).find(option => 
                option.textContent.trim() === mainCategory
              );
              
              if (matchingOption) {
                el.value = matchingOption.value;
                console.log(`✅ [${i}] Main category filled: ${mainCategory} (value: ${matchingOption.value})`);
              } else {
                console.log(`⚠️ [${i}] No option found with text: "${mainCategory}"`);
                // Apply skip logic
                if (!el.querySelector("option[value='0000']")) {
                  const opt = document.createElement("option");
                  opt.value = "0000";
                  opt.textContent = "Skip Category";
                  el.insertBefore(opt, el.firstChild);
                  console.log(`✅ Added "Skip Category" option to ${selector}`);
                }
                el.value = "0000";
                console.log(`✅ [${i}] Category skipped - no matching option found`);
              }
            } else {
              // Debug: Check what options are available
              const allOptions = Array.from(el.querySelectorAll('option')).map(opt => ({
                value: opt.value,
                text: opt.textContent.trim()
              }));
              console.log(`🔍 Available options in ${selector}:`, allOptions);
              console.log(`🔍 Looking for mainCategory value: "${mainCategory}"`);
              console.log(`🔍 Type of mainCategory: ${typeof mainCategory}`);
              
              // Category is empty or not found - apply skip logic
              if (!el.querySelector("option[value='0000']")) {
                const opt = document.createElement("option");
                opt.value = "0000";
                opt.textContent = "Skip Category";
                el.insertBefore(opt, el.firstChild);
                console.log(`✅ Added "Skip Category" option to ${selector}`);
              }
              el.value = "0000";
              console.log(`✅ [${i}] Category skipped - mainCategory is empty or not found`);
            }
            
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            el.style.border = "2px solid #4CAF50";
            console.log(`✅ [${i}] Category field processed with skipCategory1 mode`);
            results.push({ i, action, selector, value: el.value, status: "filled", mode: "skipCategory1" });
            continue;
          }
          
          if (selector === '[name="profession_id"]' && el.tagName === "SELECT") {
            // Get current domain for validation
            const currentDomain = window.location.hostname.replace(/^www\./, "");
            
            // Access mainCategory from the correct structure: campaignData.citations.mainCategory
            // Try multiple possible paths for citations data
            let citations = nestedCampaign?.campaignData?.citations;
            
            // Fallback: Check if citations is directly under nestedCampaign
            if (!citations) {
              citations = nestedCampaign?.citations;
              console.log(`🔄 Fallback: Found citations directly under nestedCampaign:`, citations);
            }
            
            // Handle citations as array - find the matching citation for current domain
            let mainCategory = null;
            let citationSite = null;
            
            if (Array.isArray(citations)) {
              const matchingCitation = citations.find(citation => citation.site === currentDomain);
              
              if (matchingCitation) {
                mainCategory = matchingCitation.mainCategory;
                citationSite = matchingCitation.site;
                console.log(`✅ Found matching citation for ${currentDomain}:`, matchingCitation);
              } else {
                console.warn(`⚠️ No citation found for domain: ${currentDomain}`);
                console.log(`🔍 Available citation sites:`, citations.map(c => c.site));
              }
            } else if (citations && typeof citations === 'object') {
              // Handle as single object (legacy format)
              mainCategory = citations.mainCategory;
              citationSite = citations.site;
            }
            
            console.log(`🔍 Category lookup details:`);
            console.log(`   • Current domain: ${currentDomain}`);
            console.log(`   • Citation site: ${citationSite}`);
            console.log(`   • Main category: ${mainCategory}`);
            console.log(`   • Citations data:`, citations);
            
            // Check if domain matches and category exists
            if (citationSite && citationSite !== currentDomain) {
              console.warn(`⚠️ [${i}] Domain mismatch! Citation site "${citationSite}" doesn't match current domain "${currentDomain}"`);
              el.value = "";
            } else if (mainCategory && mainCategory !== "") {
              // Find option by text content instead of value
              const matchingOption = Array.from(el.querySelectorAll('option')).find(option => 
                option.textContent.trim() === mainCategory
              );
              
              if (matchingOption) {
                el.value = matchingOption.value;
                console.log(`✅ [${i}] Main category set to: ${mainCategory} (value: ${matchingOption.value}) (domain validated)`);
              } else {
                console.log(`⚠️ [${i}] No option found with text: "${mainCategory}"`);
                // Skip category - leave empty or set to empty value
                el.value = "";
                console.log(`⚠️ [${i}] Main category skipped - not found or no matching option`);
              }
            } else {
              // Debug: Check what options are available
              const allOptions = Array.from(el.querySelectorAll('option')).map(opt => ({
                value: opt.value,
                text: opt.textContent.trim()
              }));
              console.log(`🔍 Available options in ${selector}:`, allOptions);
              console.log(`🔍 Looking for mainCategory value: "${mainCategory}"`);
              console.log(`🔍 Type of mainCategory: ${typeof mainCategory}`);
              
              // Skip category - leave empty or set to empty value
              el.value = "";
              console.log(`⚠️ [${i}] Main category skipped - not found or no matching option`);
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

        else if (action === "click" && el) {
          el.click();
          if (valueKey === "NextButtonSave") {
            chrome.storage.local.set({ [getResumeIndexKey()]: i + 1 });
            console.log("⏭️ Pausing after navigation.");
            automationRunning = false;
            reportAutomationStatus({ isRunning: false, status: 'paused', message: 'Paused after navigation' });
            return;
          }
          // ✅ Update resume index after every other click
          chrome.storage.local.set({ [getResumeIndexKey()]: i + 1 });
          console.log(`🟢 [${i}] Clicked ${selector}`);
          results.push({ i, action, selector, status: "clicked" });
        }
        else if (action === "uploadImages") {
          // Fetch base64Data from storage
          const { base64Data = {} } = await chrome.storage.local.get(["base64Data"]);
          
          // Debug: Log what's in base64Data
          console.log(`🔍 Image upload debug for ${valueKey}:`);
          console.log(`   • base64Data keys:`, Object.keys(base64Data));
          console.log(`   • Looking for key: ${valueKey}`);
          console.log(`   • Available keys:`, Object.keys(base64Data));
          
          let base64String = base64Data[valueKey]; // valueKey might be 'logoBox', 'image1Box', etc.
          
          // Fallback: Check if image data is in campaign data
          if (!base64String) {
            const nestedCampaign = Object.values(campaignData)[0];
            const campaignImages = nestedCampaign?.campaignData?.images || nestedCampaign?.images;
            console.log(`🔍 Checking campaign data for images:`, campaignImages);
            
            if (campaignImages && campaignImages[valueKey]) {
              base64String = campaignImages[valueKey];
              console.log(`✅ Found image in campaign data for ${valueKey}`);
            }
          }
          
          // Additional fallback: Check for common image key variations
          if (!base64String) {
            const possibleKeys = [
              valueKey,
              valueKey.toLowerCase(),
              valueKey.replace('Box', ''),
              valueKey.replace('Box', 'Image'),
              'logo',
              'logoImage',
              'image',
              'image1'
            ];
            
            console.log(`�� Trying alternative keys:`, possibleKeys);
            
            for (const key of possibleKeys) {
              if (base64Data[key]) {
                base64String = base64Data[key];
                console.log(`✅ Found image with alternative key: ${key}`);
                break;
              }
            }
          }
          
          if (!base64String) {
            console.warn(`⚠️ [${i}] No image found for ${valueKey}`);
            console.log(`🔍 Available base64Data:`, base64Data);
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
            // ✅ Update resume index after successful upload
            chrome.storage.local.set({ [getResumeIndexKey()]: i + 1 });
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
          // Enable direct injection of consolidated data into Froala editor
          const success = await injectConsolidatedDataToFroala();
          if (success) {
            results.push({ i, action, selector, status: "froala-injection-success" });
          } else {
            results.push({ i, action, selector, status: "froala-injection-failed" });
          }
        }
        else if (action === "skipCategory") {
          const success = skipCategory(selector);
          if (success) {
            results.push({ i, action, selector, status: "category-skipped" });
          } else {
            results.push({ i, action, selector, status: "skip-category-failed" });
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
        else if (action === "delay") {
          const ms = parseInt(value) || 1000;
          console.log(`⏳ [${i}] Delaying for ${ms}ms`);
          await new Promise(resolve => setTimeout(resolve, ms));
          results.push({ i, action, status: "delayed", ms });
        }
        else {
          console.warn(`⚠️ [${i}] Unknown or unhandled action: ${action}`);
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
    automationStarting = false; // Reset the starting flag
    notifyPopupOfAutomationStatus(false);
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

    // Find the correct citation for the current domain
    const currentDomain = window.location.hostname.replace(/^www\./, "");
    let citations = nestedCampaign?.campaignData?.citations || nestedCampaign?.citations;
    let subcategory = null;

    if (Array.isArray(citations)) {
      const matchingCitation = citations.find(citation => citation.site === currentDomain);
      if (matchingCitation) {
        subcategory = matchingCitation.subCategory || matchingCitation.subcategory;
        console.log(`✅ Found matching citation for ${currentDomain}:`, matchingCitation);
      } else {
        console.warn(`⚠️ No citation found for domain: ${currentDomain}`);
      }
    } else if (citations && typeof citations === 'object') {
      // Legacy format
      subcategory = citations.subCategory || citations.subcategory;
    }

    if (!subcategory) {
      console.warn("⚠️ No subcategory found in campaign data for this domain");
      return 0;
    }

    console.log(`🎯 Looking for subcategory: "${subcategory}"`);

    let tickedCount = 0;

    // ⭐️ Only search inside the subcategory container
    const containers = document.querySelectorAll('ul.list-of-sub-categories');
    let checkboxes = [];
    containers.forEach(container => {
      checkboxes = checkboxes.concat(Array.from(container.querySelectorAll('input[type="checkbox"]')));
    });
    if (checkboxes.length === 0) {
      console.warn("⚠️ No subcategory checkboxes found in any container");
      return 0;
    }


    checkboxes.forEach(checkbox => {
      // Get the label text (the text node after the input)
      let labelText = '';
      const label = checkbox.closest('label');
      if (label) {
        labelText = label.textContent.trim();
      }

      // Also try data-name attribute if available
      const dataName = checkbox.getAttribute('data-name');
      if (dataName && !labelText) {
        labelText = dataName.trim();
      }

      // Exact match check - the label text or data-name should exactly match the subcategory
      const exactMatch = labelText.toLowerCase() === subcategory.toLowerCase() ||
                         (dataName && dataName.toLowerCase() === subcategory.toLowerCase());

      if (exactMatch && !checkbox.checked) {
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

// 6. New Startup Logic — wait for signal to start automation
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.command === "startAutomationIfReady") {
    chrome.storage.local.get(["isLoggedIn", "automationReady", "campaignData"], (data) => {
      // Check if user is logged in and campaign data exists
      // automationReady is optional - if not set, assume ready when logged in and campaign data exists
      const isReady = data.isLoggedIn && data.campaignData && (data.automationReady !== false);
      
      if (isReady) {
        console.log("✅ User is logged in and campaign data is ready — starting automation...");
        startAutomation();
        sendResponse({ success: true });
      } else {
        console.log("⏸️ Requirements not met — skipping automation start.");
        console.log("Debug info:", {
          isLoggedIn: data.isLoggedIn,
          automationReady: data.automationReady,
          hasCampaignData: !!data.campaignData
        });
        sendResponse({ success: false, reason: "Not ready" });
      }
    });
    return true; // Keep message channel open for async sendResponse
  }
  
  // Manual trigger for testing
  if (request.command === "startAutomationManual") {
    console.log("🎯 Manual automation trigger received");
    startAutomation();
    sendResponse({ success: true, message: 'Manual automation started' });
    return true;
  }
});

  
  // Missing functions that were referenced but not defined
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
        // Handle field names with colons (e.g., "Number of Employees:")
        const fieldKey = key.includes(":") ? key : `${key}:`;
        if (domainConfig[fieldKey] !== "TRUE" || !itemvalue[key]) return "";
        const labelText = removeStrongTags ? `${label}:<br/>` : `<strong>${label}:</strong><br/>`;
        return showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;${label}:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${itemvalue[key]}&lt;br/&gt;&lt;br/&gt;`
          : `${labelText}${itemvalue[key]}<br/><br/>`;
      };
      
      // Format website
      const formatWebsite = (website) => {
        if (domainConfig.Website !== "TRUE" || !website) return "";
        return showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Website:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;&lt;a href="${website}" target="_blank"&gt;${website}&lt;/a&gt;&lt;br/&gt;&lt;br/&gt;`
          : `${removeStrongTags ? "Website:<br/>" : "<strong>Website:</strong><br/>"}<a href="${website}" target="_blank">${website}</a><br/><br/>`;
      };
      
      // Format business hours
      const formatBusinessHours = (hours) => {
        if (domainConfig["Business Hours:"] !== "TRUE" || !hours) return "";
        return showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Business Hours:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${hours.replace(/\n/g, "&lt;br/&gt;")}&lt;br/&gt;&lt;br/&gt;`
          : `${removeStrongTags ? "Business Hours:<br/>" : "<strong>Business Hours:</strong><br/>"}${hours.replace(/\n/g, "<br/>")}<br/><br/>`;
      };
      
      // Format services
      const formatServices = () => {
        let servicesList = [itemvalue.service1, itemvalue.service2, itemvalue.service3, itemvalue.service4, itemvalue.service5].filter(s => s);
        if (domainConfig["List of Services"] !== "TRUE" || servicesList.length === 0) return "";
        const label = servicesList.length === 1 ? "Service" : "List of Services";
        let services = servicesList.join(showRawTags ? "&lt;br/&gt;" : "<br/>");
        return showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;${label}:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;${services}&lt;br/&gt;&lt;br/&gt;`
          : `${removeStrongTags ? `${label}:<br/>` : `<strong>${label}:</strong><br/>`}${services}<br/><br/>`;
      };
      
      // Format description
      const formatDescription = () => {
        if (domainConfig.Description !== "TRUE" || !itemvalue.description) return "";
        
        const hasOtherDetails = 
          (domainConfig.Address === "TRUE" && itemvalue.address) ||
          (domainConfig.Website === "TRUE" && itemvalue.website) ||
          (domainConfig["List of Services"] === "TRUE" && itemvalue.service1) ||
          (domainConfig["Contact Telephone:"] === "TRUE" && itemvalue.telephone && itemvalue.telephone.trim() !== "") ||
          (domainConfig["Contact Email:"] === "TRUE" && itemvalue.email && itemvalue.email.trim() !== "") ||
          (domainConfig["Mobile Number:"] === "TRUE" && itemvalue.mobile && itemvalue.mobile.trim() !== "") ||
          (domainConfig["Fax Number:"] === "TRUE" && itemvalue.fax && itemvalue.fax.trim() !== "") ||
          (domainConfig["Number of Employees:"] === "TRUE" && itemvalue.numemployee) ||
          (domainConfig["Date of Company Formation:"] === "TRUE" && itemvalue.yearestab) ||
          (domainConfig["Payment Method"] === "TRUE" && itemvalue.payment) ||
          (domainConfig.Facebook === "TRUE" && itemvalue.facebook) ||
          (domainConfig.Twitter === "TRUE" && itemvalue.twitter) ||
          (domainConfig.LinkedIn === "TRUE" && itemvalue.linkedin) ||
          (domainConfig.Pinterest === "TRUE" && itemvalue.pinterest) ||
          (domainConfig.Instagram === "TRUE" && itemvalue.instagram) ||
          (domainConfig.Tiktok === "TRUE" && itemvalue.tiktok) ||
          (domainConfig.Youtube === "TRUE" && itemvalue.youtube);

        const formatted = itemvalue.description.replace(/\n/g, showRawTags ? "&lt;br/&gt;" : "<br/>");
        return showRawTags
          ? `${hasOtherDetails ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Description:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;` : ""}${formatted}&lt;br/&gt;&lt;br/&gt;`
          : `${hasOtherDetails ? (removeStrongTags ? "Description:<br/>" : "<strong>Description:</strong><br/>") : ""}${formatted}<br/><br/>`;
      };
      
      // Build consolidated content
      let formattedContent = "";
      
      // Address logic (simplified - always show full address)
      if (domainConfig.Address === "TRUE" && itemvalue.address) {
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
      console.log('[consolidateData] Contact info check:', {
        telephone: { value: itemvalue.telephone, config: domainConfig["Contact Telephone:"] },
        email: { value: itemvalue.email, config: domainConfig["Contact Email:"] },
        mobile: { value: itemvalue.mobile, config: domainConfig["Mobile Number:"] },
        fax: { value: itemvalue.fax, config: domainConfig["Fax Number:"] }
      });
      
      function isValidContact(val) {
        return typeof val === "string" &&
          val.trim() !== "" &&
          val.trim().toLowerCase() !== "null" &&
          val.trim().toLowerCase() !== "undefined";
      }
      
      const hasContactInfo =
        (domainConfig["Contact Telephone:"] === "TRUE" && isValidContact(itemvalue.telephone)) ||
        (domainConfig["Contact Email:"] === "TRUE" && isValidContact(itemvalue.email)) ||
        (domainConfig["Mobile Number:"] === "TRUE" && isValidContact(itemvalue.mobile)) ||
        (domainConfig["Fax Number:"] === "TRUE" && isValidContact(itemvalue.fax));
        
      if (hasContactInfo) {
        formattedContent += showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;For more information, please contact us with the details below:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;&lt;br/&gt;`
          : `${removeStrongTags ? "For more information, please contact us with the details below:<br/><br/>" : "<strong>For more information, please contact us with the details below:</strong><br/><br/>"}`;
        formattedContent += formatLabel("Contact Telephone", "telephone");
        formattedContent += formatLabel("Contact Email", "email");
        formattedContent += formatLabel("Mobile Number", "mobile");
        formattedContent += formatLabel("Fax Number", "fax");
      }
      
      // Social media section
      if (["Facebook", "Twitter", "LinkedIn", "Pinterest", "Instagram", "Tiktok", "Youtube"].some(key => domainConfig[key] === "TRUE" && itemvalue[key.toLowerCase()])) {
        formattedContent += showRawTags
          ? `&lt;${removeStrongTags ? "" : "strong"}&gt;Social Media Profiles:&lt;/${removeStrongTags ? "" : "strong"}&gt;&lt;br/&gt;`
          : `${removeStrongTags ? "Social Media Profiles:<br/>" : "<strong>Social Media Profiles:</strong><br/>"}`;
        ["Facebook", "Twitter", "LinkedIn", "Pinterest", "Instagram", "Tiktok", "Youtube"].forEach(key => {
          const lowercaseKey = key.toLowerCase();
          if (domainConfig[key] === "TRUE" && itemvalue[lowercaseKey]) {
            formattedContent += showRawTags
              ? `&lt;a href="${itemvalue[lowercaseKey]}" target="_blank"&gt;${itemvalue[lowercaseKey]}&lt;/a&gt;&lt;br/&gt;`
              : `<a href="${itemvalue[lowercaseKey]}" target="_blank">${itemvalue[lowercaseKey]}</a><br/>`;
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

  async function consofunction(domainConfig) {
    console.log("🔍 Running consofunction...");
    
    try {
      // Get campaign data from Chrome storage
      const { campaignData = {} } = await chrome.storage.local.get(["campaignData"]);
      const nestedCampaign = Object.values(campaignData)[0];
      
      if (!nestedCampaign?.campaignData) {
        console.warn("⚠️ No campaign data found for consofunction");
        return null;
      }
      
      // For now, use the same logic as consolidateData
      // This can be customized based on specific domain requirements
      return await consolidateData();
      
    } catch (error) {
      console.error("❌ Error in consofunction:", error);
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
      const editorSelector = ".fr-element[contenteditable='true']";
      const editor = document.querySelector(editorSelector);
      
      if (!editor) {
        console.warn("⚠️ Froala editor not found");
        return false;
      }
      
      // Focus the editor
      editor.focus();
      
      // Try to paste the content
      try {
        await navigator.clipboard.writeText(consolidatedContent);
        console.log("✅ Content copied to clipboard");
        
        // Try execCommand("paste") if browser allows it
        try {
          const successful = document.execCommand("paste");
          if (successful) {
            console.log("✅ Content pasted successfully using execCommand");
            return true;
          } else {
            console.warn("⚠️ execCommand('paste') failed, trying alternative method");
          }
        } catch (e) {
          console.warn("⚠️ execCommand('paste') error:", e);
        }
        
        // Alternative: Set innerHTML directly
        editor.innerHTML = consolidatedContent;
        console.log("✅ Content injected directly to editor");
        return true;
        
      } catch (err) {
        console.error("❌ Clipboard error:", err);
        
        // Fallback: Set innerHTML directly
        editor.innerHTML = consolidatedContent;
        console.log("✅ Content injected directly to editor (fallback)");
        return true;
      }
      
    } catch (error) {
      console.error("❌ Error injecting data to Froala:", error);
      return false;
    }
  }
  
  // Debug function for troubleshooting automation issues
  window.debugAutomation = async () => {
    console.log("🔍 Debugging automation...");
    
    // Check storage state
    const storageData = await new Promise(r => chrome.storage.local.get(null, r));
    console.log("📦 Storage data:", storageData);
    
    // Check automation state
    console.log("🤖 Automation state:", {
      automationRunning,
      automationStatus,
      automationState: window.__AUTOMATION_STATE__
    });
    
    // Check if functions are available
    console.log("🔧 Function availability:", {
      consolidateData: typeof consolidateData,
      consofunction: typeof consofunction,
      injectConsolidatedDataToFroala: typeof injectConsolidatedDataToFroala
    });
    
    // Check automation files
    const hostname = window.location.hostname.replace(/^www\./, "");
    const path = normalize(location.pathname);
    const filenames = [`${hostname}${path}`.replace(/\//g, "_") + ".json", `${hostname}.json`];
    console.log("📁 Looking for automation files:", filenames);
    
    for (const filename of filenames) {
      try {
        const response = await fetch(chrome.runtime.getURL(`automation/${filename}`));
        if (response.ok) {
          const steps = await response.json();
          console.log(`✅ Found automation file: ${filename} with ${steps.length} steps`);
        } else {
          console.log(`❌ Automation file not found: ${filename}`);
        }
      } catch (err) {
        console.log(`❌ Error checking automation file ${filename}:`, err);
      }
    }
    
    return "Debug complete - check console for details";
  };
  
  // Function to skip category by adding a "Skip Category" option
  function skipCategory(selector) {
    const el = document.querySelector(selector);
    if (!el || el.tagName !== "SELECT") {
      console.warn(`⚠️ Skip category failed: Element not found or not a SELECT: ${selector}`);
      return false;
    }

    // Add "Skip Category" option if it doesn't exist
    if (!el.querySelector("option[value='0000']")) {
      const opt = document.createElement("option");
      opt.value = "0000";
      opt.textContent = "Skip Category";
      el.insertBefore(opt, el.firstChild);
      console.log(`✅ Added "Skip Category" option to ${selector}`);
    }

    // Set the value to skip
    el.value = "0000";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.style.border = "2px solid #4CAF50";
    
    console.log(`✅ [Skip Category] Set ${selector} to "Skip Category" (0000)`);
    return true;
  }  // Simple automation trigger for testing
  window.startAutomationTest = () => {
    console.log("🚀 Starting automation test...");
    startAutomation();
    return "Automation test started - check console for progress";
  };
  
  // Manual trigger from background script
  window.triggerAutomationFromBackground = () => {
    console.log("🎯 Triggering automation from background script...");
    chrome.runtime.sendMessage({ action: "triggerAutomation" }, (response) => {
      console.log("Background response:", response);
    });
    return "Trigger sent to background script";
  };

  // Auto-start automation when page loads
  async function checkAndStartAutomation() {
    try {
      // Check if user is logged in
      const { isLoggedIn, userUid } = await chrome.storage.local.get(['isLoggedIn', 'userUid']);
      if (!isLoggedIn || !userUid) {
        console.log("⏸️ Auto-start skipped: User not logged in");
        return;
      }

      // Check if campaign data exists
      const { campaignData } = await chrome.storage.local.get(['campaignData']);
      if (!campaignData || Object.keys(campaignData).length === 0) {
        console.log("⏸️ Auto-start skipped: No campaign data found");
        return;
      }

      // Check if automation file exists for current domain
      const steps = await loadSteps();
      if (!steps || steps.length === 0) {
        console.log("⏸️ Auto-start skipped: No automation steps found for this domain");
        console.log("💡 Make sure you have an automation file for this domain in the automation folder");
        return;
      }

      // Check if campaign data domain matches current domain
      const currentDomain = window.location.hostname.replace(/^www\./, "");
      const nestedCampaign = Object.values(campaignData)[0];
      const citations = nestedCampaign?.campaignData?.citations;
      const citationSite = citations?.site;
      
      console.log(`🌐 Auto-start domain validation:`);
      console.log(`   • Current domain: ${currentDomain}`);
      console.log(`   • Citation site: ${citationSite}`);
      console.log(`   • Citations data:`, citations);
      
      if (citationSite && citationSite !== currentDomain) {
        console.log(`⏸️ Auto-start skipped: Domain mismatch - campaign data is for "${citationSite}" but current domain is "${currentDomain}"`);
        return;
      }

      // Check if automation is not already running or starting
      if (automationRunning || automationStarting) {
        console.log("⏸️ Auto-start skipped: Automation already running or starting");
        return;
      }

      // Check if automation state is not aborted
      if (window.__AUTOMATION_STATE__ && window.__AUTOMATION_STATE__.aborted) {
        console.log("⏸️ Auto-start skipped: Automation was previously aborted");
        return;
      }

      // Wait a bit for the page to fully load
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log("🚀 Auto-starting automation...");
      startAutomation();

    } catch (error) {
      console.error("❌ Error in auto-start check:", error);
    }
  }

  // Start the auto-start check when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndStartAutomation);
  } else {
    // DOM is already loaded, run immediately
    checkAndStartAutomation();
  }

  // Also check when page becomes visible (for single-page apps)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !automationRunning) {
      // Small delay to ensure page is fully loaded
      setTimeout(checkAndStartAutomation, 1000);
    }
  });
}




