// background.js
// Full integrated and optimized version for Firebase + Chrome Extension Command Controller

// Firebase simulation (for local or test mode)
function createFirebaseInterface() {
  console.log("🔧 Creating simulated Firebase interface...");

  globalThis.firebase = {
    initializeApp: (config) => console.log("✅ Firebase config received:", config),
    apps: [],
    firestore: () => ({
      collection: (name) => ({
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
          const hasMatch = this._whereClauses.some(c => c.field === 'userId' && c.value === userId);
          if (hasMatch) {
            return {
              empty: false,
              size: 0,
              forEach: () => console.log("📭 No real commands in simulation")
            };
          }
          return { empty: true, forEach: () => console.log("📭 No commands found") };
        },
        doc(id) {
          return {
            update: async (data) => console.log(`📝 Firestore doc ${id} update:`, data),
            set: async (data) => console.log(`📝 Firestore doc ${id} set:`, data)
          };
        },
        add: async (data) => ({ id: `fake-command-id-${Date.now()}` }),
        onSnapshot: () => () => {}
      })
    }),
    firestoreFieldValue: {
      serverTimestamp: () => new Date().toISOString()
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
  if (!db) return;
  const userId = await getCurrentExtensionUserId();
  if (!userId) return;
  const snapshot = await db.collection('extensionCommands')
    .where('status', '==', 'pending')
    .where('target', '==', 'extension')
    .where('userId', '==', userId)
    .limit(5).get();
  if (!snapshot.empty) {
    snapshot.forEach(doc => processFirestoreCommand(doc.id, doc.data()));
  }
}

async function processFirestoreCommand(id, command) {
  await updateFirestoreCommandStatus(id, 'processing', 'Processing...');
  try {
    await executeCommand(id, command.action, command.data);
    await updateFirestoreCommandStatus(id, 'completed', 'Command complete');
  } catch (e) {
    console.error("❌ Command failed:", e);
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
    case 'clearData': return chrome.storage.local.remove(['formData', 'citationsData']);
    case 'getAuthStatus': {
      const auth = await new Promise(r => chrome.storage.local.get(['isLoggedIn', 'email', 'userUid'], r));
      return updateFirestoreCommandStatus(id, 'completed', 'Auth status', auth);
    }
    case 'getExtensionInfo': return handleGetExtensionInfo(id);
    case 'refreshAuthToken': return handleRefreshAuthToken(id);
    case 'getStorageData': return handleGetStorageData(id, data);
    case 'setStorageData': return handleSetStorageData(id, data);
    case 'testConnection': return handleTestConnection(id);
    default: throw new Error('Unknown command');
  }
}

async function handleLogout(id) {
  const { userUid, email } = await new Promise(r => chrome.storage.local.get(['userUid', 'email'], r));
  await chrome.storage.local.clear();
  const now = new Date().toISOString();
  if (db && userUid) {
    await db.collection('extensionStatus').doc(chrome.runtime.id).set({ userUid, email, logoutTime: now, status: 'offline' });
    await db.collection('userExtensions').doc(userUid).set({ extensionId: chrome.runtime.id, lastSeen: now, status: 'offline' });
  }
  return updateFirestoreCommandStatus(id, 'completed', 'Logged out');
}

async function handleGetExtensionInfo(id) {
  const info = {
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    name: chrome.runtime.getManifest().name,
    description: chrome.runtime.getManifest().description,
    timestamp: new Date().toISOString()
  };
  return updateFirestoreCommandStatus(id, 'completed', 'Extension info', info);
}

async function handleRefreshAuthToken(id) {
  const token = 'mock-token-' + Date.now();
  const result = { token, expires: new Date(Date.now() + 3600000).toISOString() };
  return updateFirestoreCommandStatus(id, 'completed', 'Token refreshed', result);
}

async function handleGetStorageData(id, data) {
  const keys = data?.keys || [];
  return new Promise(r => chrome.storage.local.get(keys, async (res) => {
    await updateFirestoreCommandStatus(id, 'completed', 'Storage data', res);
    r();
  }));
}

async function handleSetStorageData(id, data) {
  const set = data?.storageData || {};
  return new Promise(r => chrome.storage.local.set(set, async () => {
    await updateFirestoreCommandStatus(id, 'completed', 'Storage updated', set);
    r();
  }));
}

async function handleTestConnection(id) {
  const result = {
    firebaseConnected: !!db,
    extensionId: chrome.runtime.id,
    timestamp: new Date().toISOString()
  };
  return updateFirestoreCommandStatus(id, 'completed', 'Connection ok', result);
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

chrome.commands.onCommand.addListener(command => {
  if (command === 'open-debug') {
    chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
  }
});
