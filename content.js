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
    
    // Check automation eligibility before starting
    try {
      const eligibility = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'checkAutomationEligibility' }, (response) => {
          resolve(response);
        });
      });
      
      if (!eligibility.eligible) {
        console.error(`❌ Automation blocked: ${eligibility.reason}`);
        if (eligibility.reason === "Citations limit reached") {
          alert(`❌ Automation blocked: You have reached your citations limit (${eligibility.citationsUsed}/${eligibility.citations}). Please upgrade your plan to continue.`);
        } else {
          alert(`❌ Automation blocked: ${eligibility.reason}`);
        }
        automationStarting = false;
        return;
      }
      
      console.log(`✅ Automation eligibility check passed: ${eligibility.reason}`);
      console.log(`📊 Citations usage: ${eligibility.citationsUsed}/${eligibility.citations} (${eligibility.remaining} remaining)`);
      
    } catch (error) {
      console.error("❌ Error checking automation eligibility:", error);
      automationStarting = false;
      return;
    }
    
    // Get current domain for citation tracking
    const currentDomain = window.location.hostname.replace(/^www\./, "");
    
    // Increment citations used
    try {
      const incrementResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ 
          action: 'incrementCitationsUsed', 
          domain: currentDomain 
        }, (response) => {
          resolve(response);
        });
      });
      
      if (incrementResult.success) {
        console.log(`✅ Citations used incremented for domain: ${currentDomain}`);
      } else {
        console.warn(`⚠️ Failed to increment citations: ${incrementResult.error}`);
      }
    } catch (error) {
      console.error("❌ Error incrementing citations:", error);
    }
    
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
          if (automationRunning) {
          state.paused = true;
          reportAutomationStatus({ isRunning: false, status: 'paused' });
          console.log("⏸️ Automation paused");
          sendResponse && sendResponse({ success: true, status: 'paused' });
          } else {
            console.warn("⚠️ Cannot pause: automation not running");
            sendResponse && sendResponse({ success: false, error: 'Automation not running' });
          }
          break;

        case "resume":
          if (automationRunning && state.paused) {
          state.paused = false;
          if (resumeSignal) {
            resumeSignal();
            resumeSignal = null;
          }
          reportAutomationStatus({ isRunning: true, status: 'resumed' });
          console.log("▶️ Automation resumed");
          sendResponse && sendResponse({ success: true, status: 'resumed' });
          } else if (!automationRunning) {
            console.log("🚀 Resuming automation by starting it");
            startAutomation();
            sendResponse && sendResponse({ success: true, status: 'started' });
          } else {
            console.warn("⚠️ Cannot resume: automation not paused");
            sendResponse && sendResponse({ success: false, error: 'Automation not paused' });
          }
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
    
    // Get GitHub configuration
    const githubConfig = await getGitHubConfig();
    console.log(`🔧 Using GitHub config:`, githubConfig);
    
    // Only try to load from GitHub (no fallback to local files)
    for (const filename of filenames) {
      try {
        console.log(`🔍 Fetching from GitHub: ${filename}`);
        const startTime = performance.now();
        
        // GitHub Raw URL format
        const githubUrl = `https://raw.githubusercontent.com/${githubConfig.owner}/${githubConfig.repo}/${githubConfig.branch}/${githubConfig.path}/${filename}`;
        console.log(`🔗 GitHub URL: ${githubUrl}`);
        
        const response = await fetch(githubUrl);
        const endTime = performance.now();
        const fetchTime = endTime - startTime;
        
        console.log(`⏱️ Fetch time: ${fetchTime.toFixed(2)}ms`);
        
        if (response.ok) {
          const steps = await response.json();
          const totalTime = performance.now() - startTime;
          console.log(`✅ Found automation file on GitHub: ${filename} with ${steps.length} steps`);
          console.log(`⏱️ Total load time: ${totalTime.toFixed(2)}ms`);
          reportAutomationStatus({ totalSteps: steps.length });
          return steps;
        } else {
          console.warn(`⚠️ GitHub file not found: ${filename} (HTTP ${response.status})`);
          console.log(`🔗 Attempted URL: ${githubUrl}`);
        }
      } catch (error) {
        console.error(`❌ Error loading from GitHub: ${filename}`, error);
        console.log(`🔗 Attempted URL: https://raw.githubusercontent.com/${githubConfig.owner}/${githubConfig.repo}/${githubConfig.branch}/${githubConfig.path}/${filename}`);
      }
    }
    
    console.error(`❌ No automation files found on GitHub for domain. Tried:`, filenames);
    console.log(`💡 Make sure your automation files are uploaded to: https://github.com/${githubConfig.owner}/${githubConfig.repo}/tree/${githubConfig.branch}/${githubConfig.path}`);
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
      if (state.aborted) {
        console.log("🛑 Automation aborted during execution");
        break;
      }

      // Check if we've reached the end
      if (i >= steps.length) {
        console.log("✅ Automation completed - reached end of steps");
        state.aborted = true;
        break;
      }

      // Handle pause/resume
      while (state.paused) {
        console.log("⏸️ Automation paused, waiting for resume...");
        await new Promise((r) => setTimeout(r, 300));
        if (state.aborted) {
          console.log("🛑 Automation aborted while paused");
          break;
        }
      }

      if (state.aborted) break;

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
          
          let val = value !== undefined 
            ? value 
            : nestedCampaign?.campaignData?.[valueKey] || "";
          
          // Handle required mode - use alternative if primary value is empty
          if (mode === "required" && (!val || val.trim() === "")) {
            const alternativeKey = steps[i].alternative;
            if (alternativeKey) {
              const alternativeVal = nestedCampaign?.campaignData?.[alternativeKey] || "";
              if (alternativeVal && alternativeVal.trim() !== "") {
                val = alternativeVal;
                console.log(`🔄 [${i}] Primary value empty, using alternative: ${valueKey} → ${alternativeKey} = "${val}"`);
              } else {
                console.warn(`⚠️ [${i}] Both primary (${valueKey}) and alternative (${alternativeKey}) values are empty`);
              }
            } else {
              console.warn(`⚠️ [${i}] Required mode specified but no alternative key provided`);
            }
          }
          
          // Handle limit mode - truncate text to specified length
          if (mode === "limit" && val) {
            const limitValue = steps[i].limitvalue;
            if (limitValue && typeof limitValue === 'string') {
              const limit = parseInt(limitValue);
              if (!isNaN(limit) && limit > 0) {
                const originalVal = val;
                val = val.substring(0, limit);
                console.log(`✂️ [${i}] Limited text from ${originalVal.length} to ${limit} characters: "${originalVal}" → "${val}"`);
              } else {
                console.warn(`⚠️ [${i}] Invalid limit value: ${limitValue}`);
              }
            } else {
              console.warn(`⚠️ [${i}] Limit mode specified but no valid limitvalue provided`);
            }
          }
          
          // Handle limitBySentence mode - truncate text at nearest sentence boundary
          if (mode === "limitBySentence" && val) {
            const limitValue = steps[i].limitvalue;
            if (limitValue && typeof limitValue === 'string') {
              const limit = parseInt(limitValue);
              if (!isNaN(limit) && limit > 0) {
                const originalVal = val;
                
                // If text is already within limit, keep it as is
                if (originalVal.length <= limit) {
                  console.log(`✅ [${i}] Text already within limit (${originalVal.length} ≤ ${limit}), keeping as is`);
                } else {
                  // Find the nearest sentence boundary (period) before the limit
                  const truncatedText = originalVal.substring(0, limit);
                  const lastPeriodIndex = truncatedText.lastIndexOf('.');
                  
                  if (lastPeriodIndex > 0) {
                    // Cut at the last period + 1 (to include the period)
                    val = originalVal.substring(0, lastPeriodIndex + 1);
                    console.log(`✂️ [${i}] Limited text by sentence from ${originalVal.length} to ${val.length} characters at period position ${lastPeriodIndex}`);
                    console.log(`📝 Original: "${originalVal}"`);
                    console.log(`📝 Result: "${val}"`);
                  } else {
                    // No period found, fall back to regular truncation
                    val = truncatedText;
                    console.log(`⚠️ [${i}] No sentence boundary found, using regular truncation: ${originalVal.length} → ${val.length} characters`);
                  }
                }
              } else {
                console.warn(`⚠️ [${i}] Invalid limit value: ${limitValue}`);
              }
            } else {
              console.warn(`⚠️ [${i}] LimitBySentence mode specified but no valid limitvalue provided`);
            }
          }
          
          // Handle address mode - different address display scenarios
          if (mode === "address" && val) {
            const addressMode = steps[i]["address-mode"];
            if (addressMode) {
              console.log(`🏠 [${i}] Processing address mode: ${addressMode}`);
              
              switch (addressMode.toLowerCase()) {
                case "show address":
                  // Use full address (line1, line2, city, state, zipcode, country)
                  const line1 = nestedCampaign?.campaignData?.line1 || "";
                  const line2 = nestedCampaign?.campaignData?.line2 || "";
                  const city = nestedCampaign?.campaignData?.city || "";
                  const state = nestedCampaign?.campaignData?.state || "";
                  const zipcode = nestedCampaign?.campaignData?.zipcode || "";
                  const country = nestedCampaign?.campaignData?.country || "";
                  
                  // Build full address
                  const addressParts = [line1, line2, city, state, zipcode, country].filter(part => part && part.trim());
                  val = addressParts.join(", ");
                  
                  console.log(`🏠 [${i}] Show Address mode - Full address: "${val}"`);
                  break;
                  
                case "full hide":
                  // Empty the field completely
                  val = "";
                  console.log(`🏠 [${i}] Full Hide mode - Address field emptied`);
                  break;
                  
                case "address line 1":
                  // Use only address line 1, or service area if available
                  const serviceArea = nestedCampaign?.campaignData?.serviceArea || "";
                  const addressLine1 = nestedCampaign?.campaignData?.line1 || "";
                  
                  // Check if field is required (using required mode logic)
                  const isRequired = steps[i].required === true || steps[i].required === "true";
                  
                  if (isRequired) {
                    // If required, use service area or address line 1
                    val = serviceArea || addressLine1;
                    console.log(`🏠 [${i}] Address Line 1 mode (required) - Using: "${val}"`);
                  } else {
                    // If not required, leave empty
                    val = "";
                    console.log(`🏠 [${i}] Address Line 1 mode (not required) - Field emptied`);
                  }
                  break;
                  
                default:
                  console.warn(`⚠️ [${i}] Unknown address mode: ${addressMode}`);
                  break;
              }
            } else {
              console.warn(`⚠️ [${i}] Address mode specified but no address-mode value provided`);
            }
          }
          
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
            
            console.log(`🔍 Trying alternative keys:`, possibleKeys);
            
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
        else if (action === "selectHours") {
          console.log(`🕐 [${i}] Selecting hours for selector: ${selector}`);
          
          try {
            // Get the hours data from the specified valueKey or direct value
            let hoursData = value !== undefined ? value : nestedCampaign?.campaignData?.[valueKey] || "";
            
            if (!hoursData) {
              console.warn(`⚠️ [${i}] No hours data found for key: ${valueKey}`);
              results.push({ i, action, selector, status: "no-hours-data" });
              continue;
            }
            
            console.log(`🕐 [${i}] Hours data: ${hoursData}`);
            
            // Function to convert any time format to 24-hour format
            const convertAnyTimeTo24Hour = (timeString) => {
              if (!timeString || typeof timeString !== 'string') return null;
              
              const cleanTime = timeString.trim().toLowerCase();
              
              // Handle 24-hour format (already correct)
              if (/^\d{1,2}:\d{2}$/.test(cleanTime)) {
                return cleanTime;
              }
              
              // Handle 12-hour format with AM/PM
              const match = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
              if (match) {
                let hours = parseInt(match[1]);
                const minutes = match[2];
                const period = match[3];
                
                // Convert to 24-hour format
                if (period === 'pm' && hours !== 12) {
                  hours += 12;
                } else if (period === 'am' && hours === 12) {
                  hours = 0;
                }
                
                return `${hours.toString().padStart(2, '0')}:${minutes}`;
              }
              
              return null;
            };
            
            // Function to extract and convert times from business hours string
            const extractTimesFromBusinessHours = (businessHoursString) => {
              const times = [];
              
              // Extract all time patterns (12-hour format)
              const timeMatches = businessHoursString.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi);
              if (timeMatches) {
                timeMatches.forEach(time => {
                  const converted = convertAnyTimeTo24Hour(time);
                  if (converted) times.push(converted);
                });
              }
              
              return times;
            };
            
            // Find the dropdown element
            const dropdown = document.querySelector(selector);
            if (!dropdown || dropdown.tagName !== 'SELECT') {
              console.error(`❌ [${i}] Dropdown not found or not a SELECT element: ${selector}`);
              results.push({ i, action, selector, status: "dropdown-not-found" });
              continue;
            }
            
            // Get all available options
            const options = Array.from(dropdown.querySelectorAll('option'));
            console.log(`🔍 [${i}] Available dropdown options:`, options.map(opt => ({ value: opt.value, text: opt.textContent.trim() })));
            
            let success = false;
            let selectedValue = null;
            
            // Try different approaches to find a matching option
            
            // 1. Try direct match first
            const directMatch = options.find(option => 
              option.value === hoursData || option.textContent.trim() === hoursData
            );
            
            if (directMatch) {
              selectedValue = directMatch.value;
              success = true;
              console.log(`✅ [${i}] Direct match found: ${hoursData}`);
            } else {
              // 2. Try converting to 24-hour format
              const convertedTime = convertAnyTimeTo24Hour(hoursData);
              if (convertedTime) {
                const convertedMatch = options.find(option => 
                  option.value === convertedTime || option.textContent.trim() === convertedTime
                );
                
                if (convertedMatch) {
                  selectedValue = convertedMatch.value;
                  success = true;
                  console.log(`✅ [${i}] Converted match found: ${hoursData} → ${convertedTime}`);
                }
              }
              
              // 3. If still no match, try extracting from business hours string
              if (!success) {
                const extractedTimes = extractTimesFromBusinessHours(hoursData);
                console.log(`🔍 [${i}] Extracted times from business hours:`, extractedTimes);
                
                for (const extractedTime of extractedTimes) {
                  const extractedMatch = options.find(option => 
                    option.value === extractedTime || option.textContent.trim() === extractedTime
                  );
                  
                  if (extractedMatch) {
                    selectedValue = extractedMatch.value;
                    success = true;
                    console.log(`✅ [${i}] Extracted time match found: ${extractedTime}`);
                    break;
                  }
                }
              }
            }
            
            // Apply the selection if successful
            if (success && selectedValue) {
              dropdown.value = selectedValue;
              dropdown.dispatchEvent(new Event('change', { bubbles: true }));
              dropdown.dispatchEvent(new Event('input', { bubbles: true }));
              dropdown.dispatchEvent(new Event('blur', { bubbles: true }));
              dropdown.style.border = "2px solid #4CAF50";
              
              console.log(`✅ [${i}] Successfully selected: ${selectedValue} in ${selector}`);
              results.push({ i, action, selector, status: "hours-selected", selectedValue });
            } else {
              console.warn(`⚠️ [${i}] No matching option found for hours data: ${hoursData}`);
              console.log(`🔍 [${i}] Tried to match: ${hoursData}`);
              console.log(`🔍 [${i}] Available options:`, options.map(opt => opt.value));
              results.push({ i, action, selector, status: "no-matching-option", hoursData });
            }
            
          } catch (error) {
            console.error(`❌ [${i}] Error selecting hours:`, error);
            results.push({ i, action, selector, status: "error", error: error.message });
          }
        }
        else if (action === "formatHours") {
          console.log(`🕐 [${i}] Formatting hours for selector: ${selector}`);
          
          try {
            const format = steps[i].format || 'standard';
            const hoursData = value !== undefined ? value : nestedCampaign?.campaignData?.[valueKey] || "";
            
            if (!hoursData) {
              console.warn(`⚠️ [${i}] No hours data found for key: ${valueKey}`);
              results.push({ i, action, selector, status: "no-hours-data" });
              continue;
            }
            
            console.log(`🕐 [${i}] Formatting hours data: ${hoursData} with format: ${format}`);
            
            // Use the formatBusinessHoursTo24Hour function
            const success = window.formatBusinessHoursTo24Hour(selector, hoursData, format);
            
            if (success) {
              console.log(`✅ [${i}] Hours formatted successfully with format: ${format}`);
              results.push({ i, action, selector, status: "hours-formatted", format });
            } else {
              console.warn(`⚠️ [${i}] Failed to format hours with format: ${format}`);
              results.push({ i, action, selector, status: "hours-formatting-failed", format });
            }
            
          } catch (error) {
            console.error(`❌ [${i}] Error formatting hours:`, error);
            results.push({ i, action, selector, status: "error", error: error.message });
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

    // Check if we've reached the end of steps
    if (!state.aborted && startIndex >= steps.length) {
      console.log("✅ Automation completed - all steps executed");
      state.aborted = true;
    }

    // If we've completed all steps, clear the resume index
    if (state.aborted && startIndex >= steps.length) {
      chrome.storage.local.remove(getResumeIndexKey(), () => {
        console.log("🧹 Cleared resume index after completion");
      });
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
        const cleaned = typeof val === "string" ? val.trim().toLowerCase() : "";
        return cleaned && cleaned !== "null" && cleaned !== "undefined";
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
  
  // Test function for play/pause functionality
  window.testPlayPause = () => {
    console.log("🧪 Testing play/pause functionality...");
    
    const state = window.__AUTOMATION_STATE__;
    console.log("Current state:", {
      automationRunning,
      automationStarting,
      statePaused: state.paused,
      stateAborted: state.aborted
    });
    
    // Test pause
    if (automationRunning && !state.paused) {
      console.log("⏸️ Testing pause...");
      chrome.runtime.sendMessage({ command: "pause" }, (response) => {
        console.log("Pause response:", response);
      });
    } else if (automationRunning && state.paused) {
      console.log("▶️ Testing resume...");
      chrome.runtime.sendMessage({ command: "resume" }, (response) => {
        console.log("Resume response:", response);
      });
    } else {
      console.log("🚀 Testing start...");
      startAutomation();
    }
    
    return "Play/pause test initiated - check console for results";
  };

  // Test function for citations functionality
  window.testCitations = async () => {
    console.log("🧪 Testing citations functionality...");
    
    // Test Firebase connection debug
    console.log("🔍 Debugging Firebase connection...");
    const debugResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'debugFirebaseConnection' }, (response) => {
        resolve(response);
      });
    });
    console.log("Firebase debug result:", debugResult);
    
    // Test eligibility check
    console.log("🔍 Checking automation eligibility...");
    const eligibility = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'checkAutomationEligibility' }, (response) => {
        resolve(response);
      });
    });
    console.log("Eligibility result:", eligibility);
    
    // Test citations usage
    console.log("📊 Getting citations usage...");
    const usage = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getCitationsUsage' }, (response) => {
        resolve(response);
      });
    });
    console.log("Usage result:", usage);
    
    // Test increment (only if eligible)
    if (eligibility.eligible) {
      console.log("📈 Testing citation increment...");
      const currentDomain = window.location.hostname.replace(/^www\./, "");
      const incrementResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ 
          action: 'incrementCitationsUsed', 
          domain: currentDomain 
        }, (response) => {
          resolve(response);
        });
      });
      console.log("Increment result:", incrementResult);
    } else {
      console.log("⚠️ Skipping increment test - not eligible");
    }
    
    return "Citations test completed - check console for results";
  };

  // Test function for GitHub configuration
  window.testGitHub = async () => {
    console.log("🧪 Testing GitHub configuration...");
    
    // Test getting current config
    console.log("🔍 Getting current GitHub configuration...");
    const currentConfig = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getGitHubConfig' }, (response) => {
        resolve(response);
      });
    });
    console.log("Current GitHub config:", currentConfig);
    
    // Test GitHub connection
    console.log("🔍 Testing GitHub connection...");
    const connectionTest = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'testGitHubConnection' }, (response) => {
        resolve(response);
      });
    });
    console.log("GitHub connection test:", connectionTest);
    
    // Test loading automation files
    console.log("🔍 Testing automation file loading...");
    const steps = await loadSteps();
    console.log("Automation steps loaded:", steps ? `${steps.length} steps` : 'None');
    
    return "GitHub test completed - check console for results";
  };

  // Function to set GitHub configuration
  window.setGitHubConfig = async (config) => {
    console.log("🔧 Setting GitHub configuration:", config);
    
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ 
        action: 'setGitHubConfig', 
        config: config 
      }, (response) => {
        resolve(response);
      });
    });
    
    console.log("Set GitHub config result:", result);
    return result;
  };

  // Function to reset GitHub configuration
  window.resetGitHubConfig = async () => {
    console.log("🔧 Resetting GitHub configuration...");
    
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'resetGitHubConfig' }, (response) => {
        resolve(response);
      });
    });
    
    console.log("Reset GitHub config result:", result);
    return result;
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

      // Check automation eligibility before auto-starting
      try {
        const eligibility = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'checkAutomationEligibility' }, (response) => {
            resolve(response);
          });
        });
        
        if (!eligibility.eligible) {
          console.log(`⏸️ Auto-start skipped: ${eligibility.reason}`);
          if (eligibility.reason === "Citations limit reached") {
            console.log(`📊 Citations limit reached: ${eligibility.citationsUsed}/${eligibility.citations}`);
          }
          return;
        }
        
        console.log(`✅ Auto-start eligibility check passed: ${eligibility.reason}`);
        console.log(`📊 Citations usage: ${eligibility.citationsUsed}/${eligibility.citations} (${eligibility.remaining} remaining)`);
        
      } catch (error) {
        console.error("❌ Error checking auto-start eligibility:", error);
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

  // GitHub repository configuration
  const githubConfig = {
    owner: 'TheoJhan', // Your GitHub username
    repo: 'AutofillBrowserExtension', // Your repository name
    branch: 'main', // Your default branch
    path: 'automation' // Path to automation files in the repo
  };
  
  // Function to get GitHub configuration (can be overridden by user settings)
  async function getGitHubConfig() {
    try {
      // Try to get user-specific GitHub config from storage
      const { githubConfig: userConfig } = await chrome.storage.local.get(['githubConfig']);
      if (userConfig) {
        console.log("🔧 Using user GitHub configuration:", userConfig);
        return { ...githubConfig, ...userConfig };
      }
    } catch (error) {
      console.warn("⚠️ Error loading user GitHub config:", error);
    }
    
    console.log("🔧 Using default GitHub configuration:", githubConfig);
    return githubConfig;
  }
  
  // Function to set GitHub configuration
  async function setGitHubConfig(newConfig) {
    try {
      await chrome.storage.local.set({ githubConfig: newConfig });
      console.log("✅ GitHub configuration updated:", newConfig);
      return true;
    } catch (error) {
      console.error("❌ Error saving GitHub configuration:", error);
      return false;
    }
  }
  
  // Function to reset GitHub configuration to default
  async function resetGitHubConfig() {
    try {
      await chrome.storage.local.remove(['githubConfig']);
      console.log("✅ GitHub configuration reset to default");
      return true;
    } catch (error) {
      console.error("❌ Error resetting GitHub configuration:", error);
      return false;
    }
  }

  // Function to list available automation files on GitHub
  window.listGitHubAutomationFiles = async () => {
    console.log("🔍 Listing automation files on GitHub...");
    
    try {
      const config = await getGitHubConfig();
      const baseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
      
      const response = await fetch(baseUrl);
      if (response.ok) {
        const files = await response.json();
        const automationFiles = files.filter(file => file.name.endsWith('.json'));
        
        console.log("📁 Available automation files on GitHub:");
        automationFiles.forEach(file => {
          console.log(`   • ${file.name} (${file.size} bytes)`);
        });
        
        return automationFiles;
      } else {
        console.error("❌ Failed to fetch GitHub files:", response.status);
        return null;
      }
    } catch (error) {
      console.error("❌ Error listing GitHub files:", error);
      return null;
    }
  };

  // Function to test a specific automation file on GitHub
  window.testGitHubFile = async (filename) => {
    console.log(`🧪 Testing GitHub file: ${filename}`);
    
    try {
      const config = await getGitHubConfig();
      const githubUrl = `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${config.path}/${filename}`;
      
      console.log(`🔗 Testing URL: ${githubUrl}`);
      
      const response = await fetch(githubUrl);
      if (response.ok) {
        const steps = await response.json();
        console.log(`✅ File found on GitHub: ${filename} with ${steps.length} steps`);
        console.log("📋 Steps preview:", steps.slice(0, 3)); // Show first 3 steps
        return steps;
      } else {
        console.error(`❌ File not found on GitHub: ${filename} (HTTP ${response.status})`);
        return null;
      }
    } catch (error) {
      console.error(`❌ Error testing GitHub file ${filename}:`, error);
      return null;
    }
  };

  // Function to get the current GitHub configuration
  window.getCurrentGitHubConfig = async () => {
    console.log("🔧 Getting current GitHub configuration...");
    const config = await getGitHubConfig();
    console.log("Current config:", config);
    return config;
  };

  // Function to update GitHub configuration
  window.updateGitHubConfig = async (newConfig) => {
    console.log("🔧 Updating GitHub configuration:", newConfig);
    const result = await setGitHubConfig(newConfig);
    if (result) {
      console.log("✅ GitHub configuration updated successfully");
    } else {
      console.log("❌ Failed to update GitHub configuration");
    }
    return result;
  };

  // Function to convert 12-hour format to 24-hour format and select from dropdown
  window.selectHoursFromDropdown = (selector, time12Hour) => {
    console.log(`🕐 Converting time: ${time12Hour} for selector: ${selector}`);
    
    try {
      // Convert 12-hour format to 24-hour format
      const convertTo24Hour = (time12Hour) => {
        // Remove any extra spaces and convert to lowercase
        const cleanTime = time12Hour.trim().toLowerCase();
        
        // Parse the time (e.g., "03:00 pm" -> "15:00")
        const match = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
        
        if (!match) {
          console.warn(`⚠️ Invalid time format: ${time12Hour}. Expected format: "HH:MM AM/PM"`);
          return null;
        }
        
        let hours = parseInt(match[1]);
        const minutes = match[2];
        const period = match[3];
        
        // Convert to 24-hour format
        if (period === 'pm' && hours !== 12) {
          hours += 12;
        } else if (period === 'am' && hours === 12) {
          hours = 0;
        }
        
        // Format as HH:MM
        const time24Hour = `${hours.toString().padStart(2, '0')}:${minutes}`;
        console.log(`✅ Converted ${time12Hour} → ${time24Hour}`);
        
        return time24Hour;
      };
      
      // Convert the time
      const time24Hour = convertTo24Hour(time12Hour);
      if (!time24Hour) {
        console.error(`❌ Failed to convert time: ${time12Hour}`);
        return false;
      }
      
      // Find the dropdown element
      const dropdown = document.querySelector(selector);
      if (!dropdown) {
        console.error(`❌ Dropdown not found: ${selector}`);
        return false;
      }
      
      if (dropdown.tagName !== 'SELECT') {
        console.error(`❌ Element is not a dropdown: ${selector}`);
        return false;
      }
      
      // Find the option with matching 24-hour time
      const options = Array.from(dropdown.querySelectorAll('option'));
      const matchingOption = options.find(option => {
        const optionValue = option.value.trim();
        const optionText = option.textContent.trim();
        
        // Check both value and text content
        return optionValue === time24Hour || optionText === time24Hour;
      });
      
      if (matchingOption) {
        // Select the matching option
        dropdown.value = matchingOption.value;
        dropdown.dispatchEvent(new Event('change', { bubbles: true }));
        dropdown.dispatchEvent(new Event('input', { bubbles: true }));
        dropdown.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // Add visual feedback
        dropdown.style.border = "2px solid #4CAF50";
        
        console.log(`✅ Selected hours: ${time24Hour} in ${selector}`);
        return true;
      } else {
        // Log available options for debugging
        console.warn(`⚠️ No matching option found for ${time24Hour}`);
        console.log(`🔍 Available options in ${selector}:`, options.map(opt => ({
          value: opt.value,
          text: opt.textContent.trim()
        })));
        
        return false;
      }
      
    } catch (error) {
      console.error(`❌ Error selecting hours from dropdown:`, error);
      return false;
    }
  };

  // Function to select business hours from dropdown (handles multiple time ranges)
  window.selectBusinessHours = (selector, hoursData) => {
    console.log(`🕐 Selecting business hours: ${hoursData} for selector: ${selector}`);
    
    try {
      // Parse business hours data (could be string or object)
      let hoursString = hoursData;
      
      if (typeof hoursData === 'object') {
        // If it's an object, try to extract the hours string
        hoursString = hoursData.hours || hoursData.businessHours || hoursData.toString();
      }
      
      if (!hoursString || typeof hoursString !== 'string') {
        console.error(`❌ Invalid hours data:`, hoursData);
        return false;
      }
      
      // Handle different formats of business hours
      // Examples: "9:00 AM - 5:00 PM", "09:00-17:00", "Mon-Fri 9AM-5PM"
      
      // Extract time ranges from the string
      const timeRanges = hoursString.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi);
      
      if (timeRanges && timeRanges.length >= 2) {
        // Convert first and last times to 24-hour format
        const startTime = timeRanges[0];
        const endTime = timeRanges[timeRanges.length - 1];
        
        console.log(`🕐 Business hours range: ${startTime} - ${endTime}`);
        
        // Try to select start time first
        const startSuccess = window.selectHoursFromDropdown(selector, startTime);
        
        if (startSuccess) {
          console.log(`✅ Successfully selected start time: ${startTime}`);
          return true;
        } else {
          // If start time fails, try end time
          const endSuccess = window.selectHoursFromDropdown(selector, endTime);
          if (endSuccess) {
            console.log(`✅ Successfully selected end time: ${endTime}`);
            return true;
          }
        }
      }
      
      // If no time ranges found, try to extract single time
      const singleTime = hoursString.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
      if (singleTime) {
        return window.selectHoursFromDropdown(selector, singleTime[0]);
      }
      
      console.warn(`⚠️ Could not extract time from business hours: ${hoursString}`);
      return false;
      
    } catch (error) {
      console.error(`❌ Error selecting business hours:`, error);
      return false;
    }
  };

  // Function to format business hours to 24-hour format for textarea/input fields
  window.formatBusinessHoursTo24Hour = (selector, hoursData, format = 'standard') => {
    console.log(`🕐 Formatting business hours to 24-hour format: ${hoursData} for selector: ${selector}`);
    
    try {
      // Parse business hours data
      let hoursString = hoursData;
      
      if (typeof hoursData === 'object') {
        hoursString = hoursData.hours || hoursData.businessHours || hoursData.toString();
      }
      
      if (!hoursString || typeof hoursString !== 'string') {
        console.error(`❌ Invalid hours data:`, hoursData);
        return false;
      }
      
      // Function to convert 12-hour to 24-hour format
      const convertTo24Hour = (timeString) => {
        const cleanTime = timeString.trim().toLowerCase();
        const match = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
        
        if (!match) return timeString; // Return as-is if not 12-hour format
        
        let hours = parseInt(match[1]);
        const minutes = match[2];
        const period = match[3];
        
        // Convert to 24-hour format
        if (period === 'pm' && hours !== 12) {
          hours += 12;
        } else if (period === 'am' && hours === 12) {
          hours = 0;
        }
        
        return `${hours.toString().padStart(2, '0')}:${minutes}`;
      };
      
      // Function to format business hours based on different formats
      const formatBusinessHours = (hoursString, formatType) => {
        switch (formatType) {
          case '24hour':
            // Convert all times to 24-hour format
            return hoursString.replace(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi, (match) => {
              return convertTo24Hour(match);
            });
            
          case 'compact':
            // Compact format: "09:00-17:00"
            const timeRanges = hoursString.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi);
            if (timeRanges && timeRanges.length >= 2) {
              const startTime = convertTo24Hour(timeRanges[0]);
              const endTime = convertTo24Hour(timeRanges[timeRanges.length - 1]);
              return `${startTime}-${endTime}`;
            }
            return hoursString;
            
          case 'consolidated':
            // Use the new consolidation function
            return window.consolidateBusinessHours(hoursString);
            
          case 'detailed':
            // Detailed format with day names: "Monday: 09:00-17:00"
            return hoursString.replace(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi, (match) => {
              return convertTo24Hour(match);
            });
            
          case 'simple':
            // Simple format: just the time range
            const times = hoursString.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi);
            if (times && times.length >= 2) {
              const startTime = convertTo24Hour(times[0]);
              const endTime = convertTo24Hour(times[times.length - 1]);
              return `${startTime} - ${endTime}`;
            }
            return hoursString;
            
          default:
            // Standard format: convert all times but keep original structure
            return hoursString.replace(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi, (match) => {
              return convertTo24Hour(match);
            });
        }
      };
      
      // Find the input/textarea element
      const element = document.querySelector(selector);
      if (!element) {
        console.error(`❌ Element not found: ${selector}`);
        return false;
      }
      
      // Check if it's an input or textarea
      if (element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') {
        console.error(`❌ Element is not an input or textarea: ${selector}`);
        return false;
      }
      
      // Format the business hours
      const formattedHours = formatBusinessHours(hoursString, format);
      console.log(`✅ Formatted hours: ${hoursString} → ${formattedHours}`);
      
      // Set the value
      element.value = formattedHours;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
      
      // Add visual feedback
      element.style.border = "2px solid #4CAF50";
      
      console.log(`✅ Successfully formatted and filled business hours: ${formattedHours}`);
      return true;
      
    } catch (error) {
      console.error(`❌ Error formatting business hours:`, error);
      return false;
    }
  };

  // Function to consolidate business hours into compact format
  window.consolidateBusinessHours = (hoursString) => {
    console.log(`🕐 Consolidating business hours: ${hoursString}`);
    
    try {
      // Day mappings
      const dayMap = {
        'monday': 'Mon', 'mon': 'Mon',
        'tuesday': 'Tue', 'tue': 'Tue', 
        'wednesday': 'Wed', 'wed': 'Wed',
        'thursday': 'Thu', 'thu': 'Thu',
        'friday': 'Fri', 'fri': 'Fri',
        'saturday': 'Sat', 'sat': 'Sat',
        'sunday': 'Sun', 'sun': 'Sun'
      };
      
      // Function to convert 12-hour to 24-hour format
      const convertTo24Hour = (timeString) => {
        const cleanTime = timeString.trim().toLowerCase();
        const match = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
        
        if (!match) return timeString;
        
        let hours = parseInt(match[1]);
        const minutes = match[2];
        const period = match[3];
        
        if (period === 'pm' && hours !== 12) {
          hours += 12;
        } else if (period === 'am' && hours === 12) {
          hours = 0;
        }
        
        return `${hours.toString().padStart(2, '0')}:${minutes}`;
      };
      
      // Function to extract day ranges from text
      const extractDayRanges = (text) => {
        const dayPatterns = [
          /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi,
          /(mon|tue|wed|thu|fri|sat|sun)/gi
        ];
        
        const days = [];
        dayPatterns.forEach(pattern => {
          const matches = text.match(pattern);
          if (matches) {
            days.push(...matches.map(d => d.toLowerCase()));
          }
        });
        
        return days;
      };
      
      // Function to extract time ranges
      const extractTimeRanges = (text) => {
        const timePattern = /(\d{1,2}:\d{2}\s*(?:am|pm))/gi;
        const times = text.match(timePattern);
        return times ? times.map(t => convertTo24Hour(t)) : [];
      };
      
      // Function to check if text contains "closed" or similar
      const isClosed = (text) => {
        const closedPatterns = /closed|not open|no hours|off/i;
        return closedPatterns.test(text);
      };
      
      // Split the hours string into different sections (by commas, semicolons, or newlines)
      const sections = hoursString.split(/[,;\n]/).map(s => s.trim()).filter(s => s);
      
      const consolidated = [];
      
      sections.forEach(section => {
        const days = extractDayRanges(section);
        const times = extractTimeRanges(section);
        const closed = isClosed(section);
        
        if (days.length > 0) {
          // Group consecutive days
          const dayGroups = [];
          let currentGroup = [];
          
          days.forEach(day => {
            const dayCode = dayMap[day] || day;
            if (currentGroup.length === 0) {
              currentGroup = [dayCode];
            } else {
              const lastDay = currentGroup[currentGroup.length - 1];
              // Check if days are consecutive
              const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const lastIndex = dayOrder.indexOf(lastDay);
              const currentIndex = dayOrder.indexOf(dayCode);
              
              if (currentIndex === lastIndex + 1 || (lastIndex === 6 && currentIndex === 0)) {
                currentGroup.push(dayCode);
              } else {
                if (currentGroup.length > 0) {
                  dayGroups.push([...currentGroup]);
                }
                currentGroup = [dayCode];
              }
            }
          });
          
          if (currentGroup.length > 0) {
            dayGroups.push(currentGroup);
          }
          
          // Format day ranges
          dayGroups.forEach(group => {
            if (group.length === 1) {
              const dayRange = group[0];
              if (closed) {
                consolidated.push(`${dayRange}: Closed`);
              } else if (times.length >= 2) {
                consolidated.push(`${dayRange}: ${times[0]}-${times[1]}`);
              }
            } else {
              const dayRange = `${group[0]}-${group[group.length - 1]}`;
              if (closed) {
                consolidated.push(`${dayRange}: Closed`);
              } else if (times.length >= 2) {
                consolidated.push(`${dayRange}: ${times[0]}-${times[1]}`);
              }
            }
          });
        } else {
          // No specific days mentioned, treat as general hours
          if (closed) {
            consolidated.push('Closed');
          } else if (times.length >= 2) {
            consolidated.push(`${times[0]}-${times[1]}`);
          }
        }
      });
      
      const result = consolidated.join(', ');
      console.log(`✅ Consolidated hours: ${hoursString} → ${result}`);
      return result;
      
    } catch (error) {
      console.error(`❌ Error consolidating business hours:`, error);
      return hoursString; // Return original if consolidation fails
    }
  };
}




