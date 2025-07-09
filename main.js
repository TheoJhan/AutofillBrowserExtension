// Firebase initialization (must be at the top before any firebase usage)
const firebaseConfig = {
  apiKey: "AIzaSyBZwNTgvurQB2XZTdG0hXEhH9nhHEsSyiY",
  authDomain: "cb-phaa.firebaseapp.com",
  projectId: "cb-phaa",
  storageBucket: "cb-phaa.firebasestorage.app",
  messagingSenderId: "106646034806",
  appId: "1:106646034806:web:22f2f6777652501013c257",
  measurementId: "G-48QJ08RCB2"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

document.addEventListener('DOMContentLoaded', function () {
    // 1. Get DOM Elements
    const domainNameElement = document.getElementById('domain-name');
    const powerButton = document.querySelector('.ipod-wheel');
    const openDashboardBtn = document.getElementById('openDashboardBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const statusElement = document.querySelector('.status');
    const planBtn = document.getElementById('planBtn');
    const rememberIndicator = document.getElementById('rememberIndicator');
    const playPauseBtn2 = document.getElementById('playPauseBtn2');
    const minusBtn = document.getElementById('minusBtn');
    const plusBtn = document.getElementById('plusBtn');
    const abortBtn = document.getElementById('abortBtn');
    let currentResumeIndex = 0;
    let currentDomain = '';
    let resumeIndexKey = '';
    const indexDisplay = document.createElement('div');
    indexDisplay.id = 'indexDisplay';
    indexDisplay.style.fontWeight = 'bold';
    indexDisplay.style.margin = '8px 0';
    // Insert index display into connection-info
    const connectionInfo = document.querySelector('.connection-info');
    if (connectionInfo) {
        connectionInfo.appendChild(indexDisplay);
    }
    // Helper to get domain from a URL
    function extractDomain(url) {
        try {
            const u = new URL(url);
            return u.hostname.replace(/^www\./, "");
        } catch {
            return '';
        }
    }
    // Load and display the current resumeIndex for the active tab's domain
    function loadResumeIndexForActiveTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].url) {
                currentDomain = extractDomain(tabs[0].url);
                resumeIndexKey = `resumeIndex_${currentDomain}`;
                chrome.storage.local.get([resumeIndexKey], (result) => {
                    currentResumeIndex = result[resumeIndexKey] || 0;
                    updateIndexDisplay();
                });
            } else {
                currentDomain = '';
                resumeIndexKey = '';
                currentResumeIndex = 0;
                updateIndexDisplay();
            }
        });
    }
    function updateIndexDisplay() {
        indexDisplay.textContent = currentDomain
            ? `Automation Step Index for ${currentDomain}: ${currentResumeIndex}`
            : 'No active site detected.';
    }

    // 2. State Management
    let state = {
        isManual: false,
        domainStates: {} // e.g., { "google.com": "playing" }
    };

    function saveState() {
        chrome.storage.local.set({ appState: state });
        // Also save current formData ID if available
        chrome.storage.local.get(['formData'], (result) => {
            if (result.formData && result.formData.id) {
                chrome.storage.local.set({ currentFormId: result.formData.id });
            }
        });
    }


    function setAutomationMode(isAuto) {
        const powerButton = document.querySelector('.power-btn');
        const statusElement = document.querySelector('.status');
        if (isAuto) {
            if (powerButton) {
                powerButton.classList.add('on');
                powerButton.style.borderColor = '#6effa7';
                powerButton.style.boxShadow = '0 0 25px rgba(110, 255, 167, 0.7)';
            }
            if (statusElement) {
                statusElement.textContent = 'Status: Auto';
            }
        } else {
            if (powerButton) {
                powerButton.classList.remove('on');
                powerButton.style.borderColor = '';
                powerButton.style.boxShadow = '';
            }
            if (statusElement) {
                statusElement.textContent = 'Status: Manual';
            }
        }
    }

    // 3. Event Listeners
    if (powerButton) {
        powerButton.addEventListener('click', () => {
            const isAuto = !powerButton.classList.contains('on');
            setAutomationMode(isAuto);
        });
    }

    if (openDashboardBtn) {
        openDashboardBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://cb-phaa.web.app/index.html' });
        });
    }

    if (planBtn) {
        planBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://cb-phaa.web.app/plan.html'});
        });
    }

    // iPod play/pause toggle logic
    let isPaused = false;
    function sendAutomationCommand(command) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { command });
            }
        });
    }
    if (playPauseBtn2) {
        playPauseBtn2.addEventListener('click', function() {
            if (isPaused) {
                sendAutomationCommand('resume');
                isPaused = false;
            } else {
                sendAutomationCommand('pause');
                isPaused = true;
            }
        });
    }

    // Debounce redirect to popup.html to prevent loops
    let redirectingToPopup = false;
    function safeRedirectToPopup() {
        if (!redirectingToPopup) {
            redirectingToPopup = true;
            window.location.href = 'popup.html';
        }
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (firebase && firebase.auth) {
                firebase.auth().signOut().then(async () => {
                    chrome.runtime.sendMessage({
                        action: 'reportConnectionStatus'
                    }, async () => {
                        chrome.storage.local.remove([
                            'isLoggedIn', 'username', 'appState', 'rememberMe',
                            'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
                        ], async () => {
                            await handleLogoutCommand();
                            safeRedirectToPopup();
                        });
                    });
                }).catch(async (error) => {
                    chrome.storage.local.remove([
                        'isLoggedIn', 'username', 'appState', 'rememberMe',
                        'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
                    ], async () => {
                        await handleLogoutCommand();
                        safeRedirectToPopup();
                    });
                });
            } else {
                chrome.storage.local.remove([
                    'isLoggedIn', 'username', 'appState', 'rememberMe',
                    'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
                ], async () => {
                    await handleLogoutCommand();
                    safeRedirectToPopup();
                });
            }
        });
    }

    // 4. Initialization
    async function getCurrentDomain() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0] && tabs[0].url) {
                const url = new URL(tabs[0].url);
                if (url.protocol === 'file:') return 'Local File';
                if (url.protocol.startsWith('chrome-extension:')) return 'Extension Page';
                return url.hostname.replace('www.', '');
            }
            return 'No Tab';
        } catch (e) {
            console.error(e);
            return 'Error';
        }
    }

    async function initialize() {
        const loginData = await new Promise(resolve => chrome.storage.local.get('isLoggedIn', resolve));
        if (!loginData.isLoggedIn) {
            safeRedirectToPopup();
            return;
        }

        // Load app state from storage
        const stateData = await new Promise(resolve => chrome.storage.local.get(['appState', 'rememberMe', 'formData'], resolve));
        if (stateData.appState) {
            state = { ...state, ...stateData.appState };
        }

        // Show remember indicator if enabled
        if (stateData.rememberMe) {
            rememberIndicator.style.display = 'flex';
        }

        // Show idbox if available from Firestore
        await fetchAndDisplayIdbox();

        // Get current domain and update the UI with loaded state
        const domain = await getCurrentDomain();
        domainNameElement.textContent = domain;
        domainNameElement.title = domain;
       
    }

    // Function to fetch latest campaign data from Firestore and display only the idbox
    async function fetchAndDisplayIdbox(retryCount = 0) {
        const maxRetries = 3;
        const idboxDisplay = document.getElementById('idboxDisplay');
    
        try {
            const { userUid, isLoggedIn } = await new Promise(resolve => {
                chrome.storage.local.get(['userUid', 'isLoggedIn'], resolve);
            });
    
            if (!userUid || !isLoggedIn) {
                idboxDisplay.textContent = '';
                return;
            }
    
            const currentUser = firebase.auth().currentUser;
    
            if (!currentUser) {
                if (retryCount < maxRetries) {
                    return setTimeout(() => fetchAndDisplayIdbox(retryCount + 1), 500 * (retryCount + 1));
                }
                idboxDisplay.textContent = 'Authentication error. Please re-login.';
                return;
            }
    
            const db = firebase.firestore();
            const campaignSnapshot = await db.collection('CampaignData')
                .where('userId', '==', userUid)
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();
    
            if (campaignSnapshot.empty) {
                idboxDisplay.textContent = 'No idbox found.';
                chrome.storage.local.set({ campaignData: {} });
                return;
            }
    
            const doc = campaignSnapshot.docs[0];
            const campaign = doc.data();
            const docId = doc.id;
    
            // Save campaign to local storage using the docId as key
            chrome.storage.local.set({ campaignData: { [docId]: campaign } });
    
            // ✅ FIX: Safely access nested idBox under campaignData
            const idBoxValue = campaign?.campaignData?.idBox;
    
            idboxDisplay.textContent = idBoxValue
                ? `ID: ${idBoxValue}`
                : 'No idbox in campaign.';
    
        } catch (error) {
            console.error("📛 Error loading campaign:", error);
            if (retryCount < maxRetries) {
                return setTimeout(() => fetchAndDisplayIdbox(retryCount + 1), 500 * (retryCount + 1));
            }
            idboxDisplay.textContent = 'Error loading idbox.';
        }
    }
    
    

    firebase.auth().onAuthStateChanged(user => {
        if (user) {
          initialize();
        } else {
          chrome.storage.local.get('isLoggedIn', (data) => {
            if (!data.isLoggedIn) {
              safeRedirectToPopup();
            }
          });
        }
    });

    // Live theme sync
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.theme) {
            const theme = changes.theme.newValue || 'system';
            if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.setAttribute('data-theme', 'dark');
            } else {
                document.documentElement.removeAttribute('data-theme');
            }
        }
    });

    // Utility function to send a command to Firestore
    async function sendCommandToFirestore({ action, data = {}, message = "", source = "webapp", target = "extension", status = "pending" }) {
        // Get user info from storage
        const { userUid, email } = await new Promise(resolve => {
            chrome.storage.local.get(['userUid', 'email'], resolve);
        });
        if (!userUid || !email) {
            console.error("User not logged in or missing user info.");
            return false;
        }
        const command = {
            action,
            createdAt: new Date(),
            data,
            message,
            source,
            status,
            target,
            userEmail: email,
            userId: userUid
        };
        try {
            await firebase.firestore().collection('extensionCommands').add(command);
            console.log("✅ Command sent to Firestore:", command);
            return true;
        } catch (err) {
            console.error("❌ Failed to send command to Firestore:", err);
            return false;
        }
    }

    // Update login logic to send a login command
    async function handleLoginCommand() {
        await sendCommandToFirestore({
            action: 'login',
            message: 'User logged in from extension',
            status: 'pending',
            source: 'webapp',
            target: 'extension',
            data: {}
        });
    }

    // Update logout logic to send a logout command
    async function handleLogoutCommand() {
        await sendCommandToFirestore({
            action: 'logout',
            message: 'User logged out from extension',
            status: 'pending',
            source: 'webapp',
            target: 'extension',
            data: {}
        });
    }

    // On dashboard load, set to auto mode
    setAutomationMode(true);

    function triggerAutomationWithIndex() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    command: "manualSetResumeIndex",
                    resumeIndex: currentResumeIndex
                });
            }
        });
    }
    if (plusBtn) {
        plusBtn.addEventListener('click', () => {
            if (!resumeIndexKey) return;
            currentResumeIndex++;
            chrome.storage.local.set({ [resumeIndexKey]: currentResumeIndex }, () => {
                updateIndexDisplay();
                triggerAutomationWithIndex();
            });
        });
    }
    if (minusBtn) {
        minusBtn.addEventListener('click', () => {
            if (!resumeIndexKey) return;
            if (currentResumeIndex > 0) currentResumeIndex--;
            chrome.storage.local.set({ [resumeIndexKey]: currentResumeIndex }, () => {
                updateIndexDisplay();
                triggerAutomationWithIndex();
            });
        });
    }

    // Initial load
    loadResumeIndexForActiveTab();

    if (abortBtn) {
        abortBtn.addEventListener('click', () => {
            sendAutomationCommand('abort');
        });
    }

});     