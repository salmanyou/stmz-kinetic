/* ============================================================
   STMZ KINETIC — Firebase client config
   ------------------------------------------------------------
   THIS IS THE ONLY FRONTEND FILE YOU NEED TO EDIT.

   1. Go to https://console.firebase.google.com  → your project
      → Project settings (gear icon) → "Your apps" → Web app.
   2. Copy the firebaseConfig values and paste them below.
   3. In Firebase console → Authentication → Sign-in method →
      enable "Google".
   4. In Firebase console → Firestore Database → create a database
      (production mode is fine).

   These web keys are PUBLIC by design — they are safe to ship in
   the browser. Your real secrets live only on the server (.env).
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: "AIzaSyBISq5Oh9GP1oDXJK_ABSfY81Uf1hVQmbk",
  authDomain: "mysaas-app-24552.firebaseapp.com",
  projectId: "mysaas-app-24552",
  storageBucket: "mysaas-app-24552.firebasestorage.app",
  messagingSenderId: "986224390524",
  appId: "1:986224390524:web:81b84a01518d245b33b4f9"
};
// Paddle: paste your three-tier prices. Create one product per tier in
// Paddle Catalog, each with the monthly price below, then paste each price ID.
export const paddleConfig = {
  environment: "production",                              // change to "production" when you go live
  clientToken: "live_fb910cd09be5bdb44bfb07a821b",            // Paddle → Developer tools → Authentication
  // Single legacy price (kept for backwards compatibility — points to Pro):
  priceId:       "pri_01kvemxen3f4jnnp9x8n5g6zh5",
  // Three-tier prices:
  priceStarter:  "pri_01kvem7zbb52pybttqqwend7gw",      // $9/mo  — 1 brand, 50 posts/mo
  pricePro:      "pri_01kvemxen3f4jnnp9x8n5g6zh5",          // $19/mo — 5 brands, unlimited, LinkedIn + webhook
  priceAgency:   "pri_01kven1t706d1h75cm3vjzp4vq",       // $49/mo — unlimited brands, priority AI
};

// Tier definitions used by the UI. Server enforces these limits via the
// subscription.tier field stored in Firestore.
export const TIERS = [
  { id:'starter', name:'Starter', price:9,  brands:1,        postsPerMonth:50,    linkedin:true,  webhook:false, priority:false, maxVideoSec:30  },
  { id:'pro',     name:'Pro',     price:19, brands:5,        postsPerMonth:null,  linkedin:true,  webhook:true,  priority:false, maxVideoSec:90  },
  { id:'agency',  name:'Agency',  price:49, brands:Infinity, postsPerMonth:null,  linkedin:true,  webhook:true,  priority:true,  maxVideoSec:120 },
];

export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");

let app = null, auth = null, provider = null, db = null;
if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  provider = new GoogleAuthProvider();
  db = getFirestore(app);
}
export { app, auth, provider, db };
