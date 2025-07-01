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
    const powerButton = document.querySelector('.power-btn');
    const openDashboardBtn = document.getElementById('openDashboardBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const statusElement = document.querySelector('.status');
    const planBtn = document.getElementById('planBtn');
    const rememberIndicator = document.getElementById('rememberIndicator');

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

    function updateUI(domain) {
        // Update Power Button and global status
        if (state.isManual) {
            powerButton.classList.add('on');
            statusElement.textContent = 'Status: Manual';
            powerButton.style.borderColor = '#6effa7';
            powerButton.style.boxShadow = '0 0 25px rgba(110, 255, 167, 0.7)';
            playPauseBtn.disabled = false;
        } else {
            powerButton.classList.remove('on');
            statusElement.textContent = 'Status: Auto';
            powerButton.style.borderColor = 'rgba(255, 255, 255, 0.8)';
            powerButton.style.boxShadow = '0 0 20px rgba(255,255,255,0.2)';
            playPauseBtn.disabled = true;
        }

        // Update Play/Pause Button based on the specific domain's state
        const isPlaying = state.domainStates[domain] === 'playing';
        const playIcon = playPauseBtn.querySelector('.play-icon');
        const pauseIcon = playPauseBtn.querySelector('.pause-icon');

        playPauseBtn.classList.toggle('playing', isPlaying);

        if (isPlaying && state.isManual) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = 'block';
            playPauseBtn.title = 'Pause Action';
        } else {
            playIcon.style.display = 'block';
            pauseIcon.style.display = 'none';
            playPauseBtn.title = 'Start Action';
        }
    }

    // 3. Event Listeners
    powerButton.addEventListener('click', () => {
        state.isManual = !state.isManual;
        
        // When switching to Auto, we don't clear the saved play state,
        // so it's remembered if the user switches back to Manual.
        // The button is simply disabled by the UI update.
        
        updateUI(domainNameElement.textContent);
        saveState();
    });

    playPauseBtn.addEventListener('click', function() {
        const domain = domainNameElement.textContent;
        const isCurrentlyPlaying = state.domainStates[domain] === 'playing';
        
        if (isCurrentlyPlaying) {
            // If it's playing, toggle to paused (by removing the state)
            delete state.domainStates[domain];
        } else {
            // If it's paused, toggle to playing
            state.domainStates[domain] = 'playing';
        }

        updateUI(domain);
        saveState();
    });

    openDashboardBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://cb-phaa.web.app/index.html' });
    });

    planBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://cb-phaa.web.app/plan.html'});
    });

    logoutBtn.addEventListener('click', async () => {
        // Sign out from Firebase Auth
        if (firebase && firebase.auth) {
            firebase.auth().signOut().then(async () => {
                // Report logout to background script first
                chrome.runtime.sendMessage({
                    action: 'reportConnectionStatus'
                }, async () => {
                    // Clear all auth/session data on logout
                    chrome.storage.local.remove([
                        'isLoggedIn', 'username', 'appState', 'rememberMe',
                        'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
                    ], async () => {
                        await handleLogoutCommand();
                        window.location.href = 'popup.html';
                    });
                });
            }).catch(async (error) => {
                // Even if signOut fails, proceed with local cleanup
                chrome.storage.local.remove([
                    'isLoggedIn', 'username', 'appState', 'rememberMe',
                    'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
                ], async () => {
                    await handleLogoutCommand();
                    window.location.href = 'popup.html';
                });
            });
        } else {
            // Fallback: just clear storage
            chrome.storage.local.remove([
                'isLoggedIn', 'username', 'appState', 'rememberMe',
                'userUid', 'firestoreUserId', 'email', 'sessionActive', 'firebaseAuthToken', 'tokenExpiry', 'loginTime'
            ], async () => {
                await handleLogoutCommand();
                window.location.href = 'popup.html';
            });
        }
    });

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
        // Check if logged in
        const loginData = await new Promise(resolve => chrome.storage.local.get('isLoggedIn', resolve));
        if (!loginData.isLoggedIn) {
            window.location.href = 'popup.html';
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

        // Show idbox if available
        const idboxDisplay = document.getElementById('idboxDisplay');
        if (stateData.formData && stateData.formData.idbox) {
            idboxDisplay.textContent = `ID: ${stateData.formData.idbox}`;
        } else {
            idboxDisplay.textContent = '';
        }

        // Get current domain and update the UI with loaded state
        const domain = await getCurrentDomain();
        domainNameElement.textContent = domain;
        domainNameElement.title = domain;
        updateUI(domain);
    }

    initialize();

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

    // Patch login and logout flows
    // In your login success (after storing userUid/email):
    // await handleLoginCommand();
    // In your logout handler (after signOut):
    // await handleLogoutCommand();

    // Now, integrate these calls in the actual login and logout logic below.

    // Patch login and logout event handlers
    // (Find the login and logout event handlers and insert the calls)
}); 