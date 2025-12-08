// firebase.js
const admin = require('firebase-admin');

function initFirebase() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("FIREBASE_CONFIG env missing");

  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || serviceAccount.databaseURL
  });
  return admin;
}

module.exports = initFirebase;