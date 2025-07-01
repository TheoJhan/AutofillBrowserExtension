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
const auth = firebase.auth();
const db = firebase.firestore();

const AUTH_CACHE_KEY = 'authStatusCache';
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAuthStatusFromCacheOrFirestore() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['userUid', AUTH_CACHE_KEY], async (result) => {
      const userUid = result.userUid;
      const cache = result[AUTH_CACHE_KEY];

      // If no userUid, not logged in
      if (!userUid) {
        resolve({ isLoggedIn: false, reason: 'No userUid' });
        return;
      }

      // Check cache
      if (cache && cache.userUid === userUid && Date.now() - cache.timestamp < AUTH_CACHE_TTL) {
        resolve(cache.status);
        return;
      }

      // Query Firestore
      try {
        const userDoc = await db.collection('userExtensions').doc(userUid).get();
        let status;
        if (userDoc.exists && userDoc.data().status === 'online') {
          status = {
            isLoggedIn: true,
            userUid: userUid,
            email: userDoc.data().email || '',
            lastSeen: userDoc.data().lastSeen || ''
          };
        } else {
          status = { isLoggedIn: false, reason: 'Not online in Firestore' };
        }
        // Cache result
        chrome.storage.local.set({
          [AUTH_CACHE_KEY]: {
            userUid,
            status,
            timestamp: Date.now()
          }
        });
        resolve(status);
      } catch (err) {
        resolve({ isLoggedIn: false, reason: 'Firestore error', error: err });
      }
    });
  });
}

// Show message helper
function showMessage(text, type = 'info') {
  const messageDiv = document.getElementById('message');
  messageDiv.textContent = text;
  messageDiv.className = `message ${type}`;
  messageDiv.style.display = 'block';
  if (type !== 'success') {
    setTimeout(() => {
      messageDiv.textContent = '';
      messageDiv.className = 'message';
      messageDiv.style.display = 'none';
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Check for active session using isLoggedIn only
  chrome.storage.local.get(['isLoggedIn'], (result) => {
    if (result.isLoggedIn) {
      window.location.href = 'main.html';
      return;
    }
  });

  const loginForm = document.getElementById('loginForm');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const loginBtn = document.getElementById('loginBtn');
  const forgotPasswordLink = document.getElementById('forgotPassword');

  // Handle form submission
  loginForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (!email) {
      showMessage('Please enter your email', 'error');
      usernameInput.focus();
      return;
    }
    if (!password) {
      showMessage('Please enter your password', 'error');
      passwordInput.focus();
      return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    try {
      const userCredential = await auth.signInWithEmailAndPassword(email, password);
      const user = userCredential.user;
      // Save auth info to local storage (isLoggedIn only)
      await chrome.storage.local.set({
        isLoggedIn: true,
        email: user.email,
        userUid: user.uid
      });
      // Fetch user doc from Firestore and save its id if exists
      try {
        const userDoc = await db.collection('userExtensions').doc(user.uid).get();
        if (userDoc.exists) {
          await chrome.storage.local.set({ firestoreUserId: userDoc.id });
        }
      } catch (firestoreErr) {
        // Ignore Firestore errors for now
      }
      showMessage(`Welcome, ${user.email}!`, 'success');
      setTimeout(() => {
        window.location.href = 'main.html';
      }, 1000);
    } catch (error) {
      let msg = error.message;
      if (error.code === 'auth/invalid-login-credentials' || error.code === 'auth/wrong-password' || (msg && msg.toLowerCase().includes('password is invalid'))) {
        msg = 'Your email or password is incorrect.';
      }
      showMessage(msg, 'error');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
      passwordInput.focus();
    }
  });

  // Handle forgot password link
  forgotPasswordLink.addEventListener('click', async function(e) {
    e.preventDefault();
    const email = usernameInput.value.trim();
    if (!email) {
      showMessage('Please enter your email above to reset password.', 'error');
      usernameInput.focus();
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      showMessage('Password reset email sent. Check your inbox.', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });
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
    
    // Handle logout
    if (area === 'local' && changes.isLoggedIn === false) {
        // No need to stop token refresh monitoring as it's handled by listenForAuthCommand
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    // No need to stop token refresh monitoring as it's handled by listenForAuthCommand
}); 

   // Password visibility toggle
   document.addEventListener('DOMContentLoaded', function() {
    const passwordInput = document.getElementById('password');
    const toggleBtn = document.getElementById('togglePassword');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    toggleBtn.addEventListener('click', function() {
        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            eyeIcon.style.display = 'none';
            eyeOffIcon.style.display = 'block';
        } else {
            passwordInput.type = 'password';
            eyeIcon.style.display = 'block';
            eyeOffIcon.style.display = 'none';
        }
    });
});