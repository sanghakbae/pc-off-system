import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import { getAnalytics, isSupported as analyticsSupported } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-analytics.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDiiix5rlD02IWP7o6qQcPWIDxg-evHTUE',
  authDomain: 'pc-off-cf652.firebaseapp.com',
  projectId: 'pc-off-cf652',
  storageBucket: 'pc-off-cf652.firebasestorage.app',
  messagingSenderId: '1028354408505',
  appId: '1:1028354408505:web:ca8e3c8f4ef3e611a58de8',
  measurementId: 'G-GRCSJQT5T7',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

analyticsSupported()
  .then((supported) => {
    if (supported) getAnalytics(app);
  })
  .catch(() => {});

async function token() {
  return auth.currentUser ? auth.currentUser.getIdToken() : '';
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!String(url || '').startsWith('/api/')) return originalFetch(input, init);
  const idToken = await token();
  if (!idToken) return originalFetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${idToken}`);
  return originalFetch(input, { ...init, headers });
};

function ensureAuthButton() {
  const meta = document.querySelector('header .meta');
  if (!meta || document.getElementById('firebase-auth-button')) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'firebase-auth-button';
  button.className = 'tool-btn auth-btn';
  button.textContent = 'Google 로그인';
  meta.prepend(button);
  return button;
}

const button = ensureAuthButton();
if (button) {
  button.addEventListener('click', async () => {
    if (auth.currentUser) await signOut(auth);
    else await signInWithPopup(auth, provider);
  });
}

onAuthStateChanged(auth, (user) => {
  if (!button) return;
  button.textContent = user ? `${user.email || '로그인됨'} 로그아웃` : 'Google 로그인';
  document.body.classList.toggle('firebase-signed-in', Boolean(user));
});

window.pcOffFirebase = { app, auth, token };
