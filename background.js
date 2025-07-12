// background.js
// Full integrated and optimized version for Firebase + Chrome Extension Command Controller
// 
// Supported Commands:
// 1. logout - Logs out the user and clears all storage
// 2. clearData - Clears specified data from chrome.storage.local (formData, citationsData, campaignData)
// 3. fetchData - Fetches specified data from chrome.storage.local (formData, citationsData, campaignData)
// 4. lockAutomation - Locks/unlocks automation functionality
//
// All commands are filtered by userId to ensure security and isolation

// Automation run counter for Firestore
let automationRunCounter = {
  counts: {}, // { domain: count }
  lastSave: null,
  saveTimeout: null
};

// Function to increment automation run count for a domain
function incrementAutomationCount(domain) {
  if (!automationRunCounter.counts[domain]) {
    automationRunCounter.counts[domain] = 0;
  }
  
  automationRunCounter.counts[domain]++;
  
  console.log(`📊 Automation run count for ${domain}: ${automationRunCounter.counts[domain]}`);
  
  // Schedule save to Firestore (5-minute buffer)
  scheduleFirestoreSave();
}

// Function to increment citations used in plan_subscribers
async function incrementCitationsUsed(domain) {
  try {
    console.log(`📈 Incrementing citations used for domain: ${domain}`);
    
    if (!db) {
      console.warn("⚠️ Firebase not available, skipping citation increment");
      return false;
    }
    
    const userId = await getCurrentExtensionUserId();
    if (!userId) {
      console.warn("⚠️ No user ID found, skipping citation increment");
      return false;
    }
    
    // Update the plan_subscribers document
    const userDocRef = db.collection('plan_subscribers').doc(userId);
    
    // Use FieldValue.increment to add 1 to citationsUsed
    await userDocRef.update({
      citationsUsed: firebase.firestore.FieldValue.increment(1),
      lastUpdated: firebase.firestoreFieldValue.serverTimestamp()
    });
    
    console.log(`✅ Citations used incremented for user ${userId}`);
    return true;
    
  } catch (error) {
    console.error("❌ Error incrementing citations used:", error);
    return false;
  }
}

// Function to get current citations usage
async function getCurrentCitationsUsage() {
  try {
    console.log("🔍 Getting current citations usage...");
    
    // Check if we're in simulation mode
    const isSimulation = !firebase.apps.length || firebase.apps.length === 0;
    console.log("🔍 Firebase mode:", isSimulation ? "Simulation" : "Real");
    
    if (!db) {
      console.warn("⚠️ Firebase not available, cannot check citations usage");
      return null;
    }
    
    const userId = await getCurrentExtensionUserId();
    console.log("🔍 User ID:", userId);
    
    if (!userId) {
      console.warn("⚠️ No user ID found, cannot check citations usage");
      return null;
    }
    
    console.log("🔍 Fetching user document from plan_subscribers...");
    const userDoc = await db.collection('plan_subscribers').doc(userId).get();
    
    if (!userDoc.exists) {
      console.warn("⚠️ User not found in plan_subscribers collection");
      console.log("🔍 Attempted to fetch document:", `plan_subscribers/${userId}`);
      
      // In simulation mode, return default data
      if (isSimulation) {
        console.log("🔍 Simulation mode: Returning default citations data");
        return {
          citationsUsed: 5,
          citations: 10,
          remaining: 5
        };
      }
      
      return null;
    }
    
    const userData = userDoc.data();
    console.log("🔍 User data from Firestore:", userData);
    
    const citationsUsed = userData.citationsUsed || 0;
    const citations = userData.citations || 0;
    const remaining = Math.max(0, citations - citationsUsed);
    
    console.log("📊 Citations calculation:", {
      citationsUsed,
      citations,
      remaining,
      rawData: userData
    });
    
    return {
      citationsUsed,
      citations,
      remaining
    };
    
  } catch (error) {
    console.error("❌ Error getting citations usage:", error);
    console.error("❌ Error details:", {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    
    // In simulation mode, return default data on error
    if (!firebase.apps.length || firebase.apps.length === 0) {
      console.log("🔍 Simulation mode: Returning default citations data on error");
      return {
        citationsUsed: 5,
        citations: 10,
        remaining: 5
      };
    }
    
    return null;
  }
}

// Function to schedule Firestore save with 5-minute buffer
function scheduleFirestoreSave() {
  // Clear existing timeout
  if (automationRunCounter.saveTimeout) {
    clearTimeout(automationRunCounter.saveTimeout);
  }
  
  // Set new timeout for 5 minutes
  automationRunCounter.saveTimeout = setTimeout(() => {
    saveAutomationCountsToFirestore();
  }, 5 * 60 * 1000); // 5 minutes in milliseconds
  
  console.log("⏰ Scheduled Firestore save in 5 minutes");
}

// Function to save automation counts to Firestore
async function saveAutomationCountsToFirestore() {
  try {
    console.log("🔥 Saving automation counts to Firestore...");
    
    if (!db) {
      console.warn("⚠️ Firebase not available, skipping save");
      return;
    }
    
    const userId = await getCurrentExtensionUserId();
    if (!userId) {
      console.warn("⚠️ No user ID found, skipping save");
      return;
    }
    
    const timestamp = firebase.firestoreFieldValue.serverTimestamp();
    
    // Get current date for document ID
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Save each domain count
    for (const [domain, count] of Object.entries(automationRunCounter.counts)) {
      if (count > 0) {
        const docRef = db.collection('automation_runs').doc(today);
        
        // Use update with merge to avoid overwriting other domains
        await docRef.set({
          [domain]: firebase.firestore.FieldValue.increment(count),
          lastUpdated: timestamp,
          userId: userId
        }, { merge: true });
        
        console.log(`✅ Saved ${count} runs for ${domain} to Firestore`);
      }
    }
    
    // Reset counts after successful save
    automationRunCounter.counts = {};
    automationRunCounter.lastSave = new Date().toISOString();
    
    console.log("✅ All automation counts saved to Firestore");
    
  } catch (error) {
    console.error("❌ Error saving to Firestore:", error);
    
    // Retry after 1 minute if save failed
    setTimeout(() => {
      console.log("🔄 Retrying Firestore save...");
      saveAutomationCountsToFirestore();
    }, 60 * 1000);
  }
}

// Function to force save immediately (for testing or manual trigger)
async function forceSaveAutomationCounts() {
  if (automationRunCounter.saveTimeout) {
    clearTimeout(automationRunCounter.saveTimeout);
    automationRunCounter.saveTimeout = null;
  }
  await saveAutomationCountsToFirestore();
}

// Function to check if user can run automation based on plan limits
async function checkAutomationEligibility() {
  try {
    // Check if user is logged in
    const { isLoggedIn, userUid } = await new Promise(r => chrome.storage.local.get(['isLoggedIn', 'userUid'], r));
    
    if (!isLoggedIn || !userUid) {
      console.log("❌ User not logged in, automation blocked");
      return { eligible: false, reason: "User not logged in" };
    }
    
    // Check if automation is locked
    const { automationLocked } = await new Promise(r => chrome.storage.local.get(['automationLocked'], r));
    if (automationLocked) {
      console.log("❌ Automation is locked, automation blocked");
      return { eligible: false, reason: "Automation is locked" };
    }
    
    // Get current citations usage
    const citationsUsage = await getCurrentCitationsUsage();
    
    if (!citationsUsage) {
      console.warn("⚠️ Could not get citations usage, allowing automation");
      return { eligible: true, reason: "Citations usage unavailable" };
    }
    
    console.log(`📊 Plan check - Citations used: ${citationsUsage.citationsUsed}, Limit: ${citationsUsage.citations}, Remaining: ${citationsUsage.remaining}`);
    
    if (citationsUsage.remaining <= 0) {
      console.log("❌ Citations limit reached, automation blocked");
      return { 
        eligible: false, 
        reason: "Citations limit reached",
        citationsUsed: citationsUsage.citationsUsed,
        citations: citationsUsage.citations,
        remaining: citationsUsage.remaining
      };
    }
    
    console.log("✅ User eligible for automation");
    return { 
      eligible: true, 
      reason: "User eligible",
      citationsUsed: citationsUsage.citationsUsed,
      citations: citationsUsage.citations,
      remaining: citationsUsage.remaining
    };
    
  } catch (error) {
    console.error("❌ Error checking automation eligibility:", error);
    return { eligible: false, reason: "Error checking eligibility" };
  }
}

// Firebase simulation (for local or test mode)
function createFirebaseInterface() {
  console.log("🔧 Creating simulated Firebase interface...");

  globalThis.firebase = {
    initializeApp: (config) => console.log("✅ Firebase config received:", config),
    apps: [],
    firestore: () => ({
      collection: (name) => ({
        _collectionName: name,
        _whereClauses: [],
        _limit: 10,
        where(field, op, val) {
          this._whereClauses.push({ field, op, val });
          return this;
        },
        limit(count) {
          this._limit = count;
          return this;
        },
        async get() {
          const userId = await getCurrentExtensionUserId();
          const hasUserIdMatch = this._whereClauses.some(c => c.field === 'userId' && c.op === '==' && c.val === userId);
          const hasStatusMatch = this._whereClauses.some(c => c.field === 'status' && c.op === '==' && c.val === 'pending');
          const hasTargetMatch = this._whereClauses.some(c => c.field === 'target' && c.op === '==' && c.val === 'extension');
          
          if (hasUserIdMatch && hasStatusMatch && hasTargetMatch) {
            console.log(`🔍 Simulation: Found matching query for user ${userId}`);
            return {
              empty: false,
              size: 0,
              forEach: (callback) => {
                console.log("📭 No real commands in simulation mode");
                // In simulation, we don't have real commands to process
              }
            };
          }
          console.log("📭 Simulation: No matching commands found");
          return { 
            empty: true, 
            forEach: () => console.log("📭 No commands found") 
          };
        },
        doc(id) {
          return {
            update: async (data) => console.log(`📝 Firestore doc ${id} update:`, data),
            set: async (data) => console.log(`📝 Firestore doc ${id} set:`, data),
            get: async () => {
              // Simulate plan_subscribers document
              if (this._collectionName === 'plan_subscribers') {
                const userId = await getCurrentExtensionUserId();
                if (id === userId) {
                  console.log(`🔍 Simulation: Returning plan_subscribers data for user ${userId}`);
                  return {
                    exists: true,
                    data: () => ({
                      citationsUsed: 5,  // Simulated data
                      citations: 10,     // Simulated data
                      lastUpdated: new Date().toISOString()
                    })
                  };
                }
              }
              return {
                exists: false,
                data: () => ({})
              };
            }
          };
        },
        add: async (data) => ({ id: `fake-command-id-${Date.now()}` }),
        onSnapshot: () => () => {}
      })
    }),
    firestoreFieldValue: {
      serverTimestamp: () => new Date().toISOString()
    },
    firestore: {
      FieldValue: {
        increment: (value) => ({ _increment: value })
      }
    }
  };
  firebase.apps.push(true);
}

createFirebaseInterface();

const firebaseConfig = {
  apiKey: "AIzaSyBZwNTgvurQB2XZTdG0hXEhH9nhHEsSyiY",
  authDomain: "cb-phaa.firebaseapp.com",
  projectId: "cb-phaa",
  storageBucket: "cb-phaa.firebasestorage.app",
  messagingSenderId: "106646034806",
  appId: "1:106646034806:web:22f2f6777652501013c257"
};

let db = null;
let pollingInterval = null;
let pendingCommands = new Map();

async function initializeFirebase() {
  try {
    console.log("🚀 Initializing Firebase...");
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    console.log("✅ Firebase initialized");
    startPolling();
    startAuthReporting();
  } catch (err) {
    console.error("❌ Firebase init error:", err);
    setTimeout(initializeFirebase, 5000);
  }
}

function startPolling() {
  clearInterval(pollingInterval);
  pollForCommands();
  pollingInterval = setInterval(pollForCommands, 10000);
}

function startAuthReporting() {
  chrome.storage.local.get(['rememberMe'], ({ rememberMe }) => {
    const interval = rememberMe ? 600000 : 300000;
    setInterval(reportAuthenticationStatus, interval);
    reportAuthenticationStatus();
  });
}

const getCurrentExtensionUserId = () => new Promise(r => chrome.storage.local.get(['userUid'], res => r(res.userUid)));

async function pollForCommands() {
  if (!db) {
    console.log("❌ Firebase not initialized, skipping command polling");
    return;
  }
  
  const userId = await getCurrentExtensionUserId();
  if (!userId) {
    console.log("❌ No user ID found, skipping command polling");
    // Don't return early - allow manual triggers to work
    console.log("💡 Note: Manual automation triggers will still work");
    return;
  }
  
  console.log(`🔍 Polling for commands for user: ${userId}`);
  
  try {
    const snapshot = await db.collection('extensionCommands')
      .where('status', '==', 'pending')
      .where('target', '==', 'extension')
      .where('userId', '==', userId)
      .limit(5)
      .get();
      
    if (!snapshot.empty) {
      console.log(`📋 Found ${snapshot.size} pending commands for user ${userId}`);
      snapshot.forEach(doc => {
        console.log(`⚡ Processing command: ${doc.data().action}`);
        processFirestoreCommand(doc.id, doc.data());
      });
    } else {
      console.log(`📭 No pending commands found for user ${userId}`);
    }
  } catch (error) {
    console.error("❌ Error polling for commands:", error);
  }
}

async function processFirestoreCommand(id, command) {
  console.log(`🔄 Processing command ${id}: ${command.action}`);
  console.log(`📋 Command data:`, command.data);
  
  await updateFirestoreCommandStatus(id, 'processing', 'Processing command...');
  
  try {
    await executeCommand(id, command.action, command.data);
    console.log(`✅ Command ${id} completed successfully`);
    await updateFirestoreCommandStatus(id, 'completed', 'Command executed successfully');
  } catch (e) {
    console.error(`❌ Command ${id} failed:`, e);
    await updateFirestoreCommandStatus(id, 'error', e.message);
  }
}

async function updateFirestoreCommandStatus(id, status, message, data) {
  if (!db) return;
  const update = {
    status,
    message,
    completedAt: firebase.firestoreFieldValue.serverTimestamp(),
    ...(data ? { result: data } : {})
  };
  await db.collection('extensionCommands').doc(id).update(update);
}

async function executeCommand(id, action, data) {
  switch (action) {
    case 'logout': return handleLogout(id);
    case 'clearData': return handleClearData(id, data);
    case 'fetchData': return handleFetchData(id, data);
    case 'lockAutomation': return handleLockAutomation(id, data);
    default: throw new Error(`Unknown command: ${action}`);
  }
}

async function handleLogout(id) {
  console.log("🔄 Processing logout command...");
  const { userUid, email } = await new Promise(r => chrome.storage.local.get(['userUid', 'email'], r));
  await chrome.storage.local.clear();
  const now = new Date().toISOString();
  
  if (db && userUid) {
    await db.collection('extensionStatus').doc(chrome.runtime.id).set({ 
      userUid, 
      email, 
      logoutTime: now, 
      status: 'offline' 
    });
    await db.collection('userExtensions').doc(userUid).set({ 
      extensionId: chrome.runtime.id, 
      lastSeen: now, 
      status: 'offline' 
    });
  }
  
  return updateFirestoreCommandStatus(id, 'completed', 'User logged out successfully');
}

async function handleClearData(id, data) {
  console.log("🗑️ Processing clear data command...");
  const keysToRemove = data?.keys || ['formData', 'citationsData', 'campaignData'];
  
  return new Promise(r => chrome.storage.local.remove(keysToRemove, async () => {
    const result = {
      clearedKeys: keysToRemove,
      timestamp: new Date().toISOString()
    };
    await updateFirestoreCommandStatus(id, 'completed', 'Data cleared successfully', result);
    r();
  }));
}

async function handleFetchData(id, data) {
  console.log("📥 Processing fetch data command...");
  const keysToFetch = data?.keys || ['formData', 'citationsData', 'campaignData'];
  
  return new Promise(r => chrome.storage.local.get(keysToFetch, async (result) => {
    const fetchedData = {};
    keysToFetch.forEach(key => {
      if (result[key]) {
        fetchedData[key] = result[key];
      }
    });
    
    await updateFirestoreCommandStatus(id, 'completed', 'Data fetched successfully', {
      fetchedKeys: Object.keys(fetchedData),
      dataCount: Object.keys(fetchedData).length,
      timestamp: new Date().toISOString()
    });

    // 🚀 Trigger automation after data is fetched and user is ready
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
        if (fetchedData.campaignData) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTabId = tabs[0]?.id;
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { command: "startAutomationIfReady" }, (response) => {
              if (response?.success) {
                console.log("🚀 Automation started successfully.");
              } else {
                console.log("⚠️ Automation not started:", response?.reason);
              }
            });
          }
        });
      }
    });
    r();
  }));
}

async function handleLockAutomation(id, data) {
  console.log("🔒 Processing lock automation command...");
  const lockStatus = data?.lockStatus || true;
  const lockReason = data?.reason || 'Manual lock';
  
  return new Promise(r => chrome.storage.local.set({
    automationLocked: lockStatus,
    lockReason: lockReason,
    lockTimestamp: new Date().toISOString()
  }, async () => {
    await updateFirestoreCommandStatus(id, 'completed', `Automation ${lockStatus ? 'locked' : 'unlocked'}`, {
      lockStatus,
      lockReason,
      timestamp: new Date().toISOString()
    });
    r();
  }));
}

// Web messages for manual triggers
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  switch (msg.action) {
    case 'testPolling': pollForCommands(); return sendResponse({ success: true });
    case 'getFirebaseStatus': return sendResponse({
      success: true,
      status: {
        firebaseInitialized: !!db,
        pollingActive: !!pollingInterval,
        heartbeatActive: false,
        isOnline: true,
        retryCount: 0,
        pendingCommandsCount: pendingCommands.size
      }
    });
    case 'debugFirebaseConnection': return sendResponse({
      success: true,
      result: {
        extensionId: chrome.runtime.id,
        timestamp: new Date().toISOString(),
        firebaseLoaded: !!db
      }
    });
    case 'testCommandProcessing': return sendResponse({ success: true, message: 'Processed' });
    case 'reportConnectionStatus': reportAuthenticationStatus(); return sendResponse({ success: true });
    
    case 'checkAutomationEligibility':
      // Check if user can run automation
      checkAutomationEligibility().then(result => {
        sendResponse(result);
      });
      return true; // Keep message channel open for async response
    
    case 'incrementCitationsUsed':
      // Increment citations used for a domain
      const domain = msg.domain;
      if (!domain) {
        sendResponse({ success: false, error: 'Domain not provided' });
        return;
      }
      
      incrementCitationsUsed(domain).then(success => {
        sendResponse({ success, domain });
      });
      return true; // Keep message channel open for async response
    
    case 'getCitationsUsage':
      // Get current citations usage
      getCurrentCitationsUsage().then(usage => {
        sendResponse({ success: true, usage });
      });
      return true; // Keep message channel open for async response
    
    case 'forceSaveAutomationCounts':
      // Force save automation counts immediately
      forceSaveAutomationCounts().then(() => {
        sendResponse({ success: true, message: 'Automation counts saved' });
      });
      return true; // Keep message channel open for async response
    
    case 'debugFirebaseConnection':
      // Debug Firebase connection and citations
      (async () => {
        try {
          const userId = await getCurrentExtensionUserId();
          const citationsUsage = await getCurrentCitationsUsage();
          const eligibility = await checkAutomationEligibility();
          
          sendResponse({
            success: true,
            debug: {
              firebaseInitialized: !!db,
              userId,
              citationsUsage,
              eligibility,
              firebaseApps: firebase.apps.length,
              isSimulation: !firebase.apps.length || firebase.apps.length === 0
            }
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: error.message,
            debug: {
              firebaseInitialized: !!db,
              firebaseApps: firebase.apps.length,
              isSimulation: !firebase.apps.length || firebase.apps.length === 0
            }
          });
        }
      })();
      return true; // Keep message channel open for async response
    
    case 'getGitHubConfig':
      // Get current GitHub configuration
      chrome.storage.local.get(['githubConfig'], (result) => {
        sendResponse({
          success: true,
          config: result.githubConfig || {
            owner: 'your-username',
            repo: 'your-repo-name',
            branch: 'main',
            path: 'automation'
          }
        });
      });
      return true; // Keep message channel open for async response
    
    case 'setGitHubConfig':
      // Set GitHub configuration
      const newConfig = msg.config;
      if (!newConfig || !newConfig.owner || !newConfig.repo) {
        sendResponse({ success: false, error: 'Invalid configuration' });
        return;
      }
      
      chrome.storage.local.set({ githubConfig: newConfig }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, config: newConfig });
        }
      });
      return true; // Keep message channel open for async response
    
    case 'resetGitHubConfig':
      // Reset GitHub configuration to default
      chrome.storage.local.remove(['githubConfig'], () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, message: 'GitHub configuration reset to default' });
        }
      });
      return true; // Keep message channel open for async response
    
    case 'testGitHubConnection':
      // Test GitHub connection with current configuration
      (async () => {
        try {
          const { githubConfig } = await new Promise(r => chrome.storage.local.get(['githubConfig'], r));
          const config = githubConfig || {
            owner: 'TheoJhan',
            repo: 'AutofillBrowserExtension',
            branch: 'main',
            path: 'automation'
          };
          
          const testUrl = `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${config.path}/test.json`;
          const response = await fetch(testUrl);
          
          sendResponse({
            success: true,
            testResult: {
              config,
              testUrl,
              status: response.status,
              ok: response.ok,
              accessible: response.ok
            }
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: error.message,
            testResult: {
              config: githubConfig || 'default',
              accessible: false
            }
          });
        }
      })();
      return true; // Keep message channel open for async response
    
    case 'triggerAutomation': 
      console.log("🎯 Manual automation trigger received from background");
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTabId = tabs[0]?.id;
        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, { command: "startAutomationManual" }, (response) => {
            if (response?.success) {
              console.log("🚀 Manual automation started successfully.");
            } else {
              console.log("⚠️ Manual automation failed:", response?.reason);
            }
          });
        } else {
          console.log("❌ No active tab found for automation trigger");
        }
      });
      return sendResponse({ success: true, message: 'Automation trigger sent to content script' });
    default: return sendResponse({ success: false, error: 'Unknown command' });
  }
});

async function reportAuthenticationStatus() {
  try {
    if (!db) return;
    const authData = await new Promise(r => chrome.storage.local.get(['isLoggedIn', 'email', 'userUid', 'tokenExpiry', 'loginTime'], r));
    if (!authData.isLoggedIn) return;
    const payload = {
      extensionId: chrome.runtime.id,
      isAuthenticated: true,
      email: authData.email,
      userUid: authData.userUid,
      loginTime: authData.loginTime,
      tokenExpiry: authData.tokenExpiry,
      lastReported: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      status: 'online'
    };
    await db.collection('extensionStatus').doc(chrome.runtime.id).set(payload);
    await db.collection('userExtensions').doc(authData.userUid).set({
      extensionId: chrome.runtime.id,
      lastSeen: new Date().toISOString(),
      status: 'online',
      version: chrome.runtime.getManifest().version,
      email: authData.email
    });
  } catch (e) {
    console.error("❌ Auth report error:", e);
  }
}

chrome.runtime.onStartup.addListener(initializeFirebase);
chrome.runtime.onInstalled.addListener(initializeFirebase);


