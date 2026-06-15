'use strict';

let adminApp = null;
let firestore = null;

function getServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

function getAdmin() {
  if (adminApp) return adminApp;
  const serviceAccount = getServiceAccount();
  if (!serviceAccount) return null;
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  adminApp = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
  return adminApp;
}

function getFirestore() {
  if (firestore) return firestore;
  const app = getAdmin();
  if (!app) return null;
  firestore = require('firebase-admin/firestore').getFirestore(app);
  return firestore;
}

function authRequired() {
  return String(process.env.PMON_AUTH_REQUIRED || '').toLowerCase() === 'true';
}

function allowedEmailSet() {
  return new Set(
    String(process.env.PMON_ALLOWED_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function allowedDomainSet() {
  return new Set(
    String(process.env.PMON_ALLOWED_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
  );
}

function userAllowed(user) {
  if (!user) return false;
  const email = String(user.email || '').toLowerCase();
  const emailDomain = email.includes('@') ? email.split('@').pop() : '';
  const emails = allowedEmailSet();
  const domains = allowedDomainSet();
  if (!emails.size && !domains.size) return true;
  return emails.has(email) || domains.has(emailDomain);
}

async function verifyBearer(req) {
  const auth = String(req.get('authorization') || '');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const app = getAdmin();
  if (!app) return null;
  const { getAuth } = require('firebase-admin/auth');
  return getAuth(app).verifyIdToken(match[1]);
}

function requireFirebaseAuth(req, res, next) {
  if (!authRequired()) return next();
  verifyBearer(req)
    .then((user) => {
      if (!user) return res.status(401).json({ ok: false, error: 'login required' });
      if (!userAllowed(user)) return res.status(403).json({ ok: false, error: 'not allowed' });
      req.user = user;
      next();
    })
    .catch(() => res.status(401).json({ ok: false, error: 'invalid token' }));
}

async function writeFirestore(collection, id, data) {
  const db = getFirestore();
  if (!db || !collection || !id) return false;
  await db.collection(collection).doc(String(id)).set({
    ...data,
    updatedAt: require('firebase-admin/firestore').FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
}

async function addFirestore(collection, data) {
  const db = getFirestore();
  if (!db || !collection) return false;
  await db.collection(collection).add({
    ...data,
    createdAt: require('firebase-admin/firestore').FieldValue.serverTimestamp(),
  });
  return true;
}

module.exports = {
  authRequired,
  getAdmin,
  getFirestore,
  requireFirebaseAuth,
  verifyBearer,
  writeFirestore,
  addFirestore,
};
