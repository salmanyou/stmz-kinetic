/* ============================================================
   STMZ KINETIC — storage layer
   Firestore when signed in, localStorage when anonymous.
   The rest of the app calls Storage.* and doesn't care which.
   ============================================================ */

import {
  doc, getDoc, setDoc, collection, getDocs,
  addDoc, updateDoc, deleteDoc, serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-config.js';

let currentUid = null;

function isCloud() { return !!(currentUid && db); }
function localKey(k) { return 'stmz_' + k; }
function readLS(k, fb) { try { return JSON.parse(localStorage.getItem(localKey(k)) || fb); } catch { return JSON.parse(fb); } }
function writeLS(k, v) { localStorage.setItem(localKey(k), JSON.stringify(v)); }
function uid() { return 'b' + Math.random().toString(36).slice(2, 11); }

export const Storage = {
  setUser(u) { currentUid = u ? u.uid : null; },
  isCloud,

  /* ----- brands (stored inline on the user doc for simplicity) ----- */
  async listBrands() {
    if (isCloud()) {
      const snap = await getDoc(doc(db, 'users', currentUid));
      const d = snap.exists() ? snap.data() : {};
      return Array.isArray(d.brands) ? d.brands : [];
    }
    return readLS('brands', '[]');
  },

  async saveBrand(brand) {
    if (!brand.id) brand.id = uid();
    if (isCloud()) {
      const ref = doc(db, 'users', currentUid);
      const snap = await getDoc(ref);
      const d = snap.exists() ? snap.data() : {};
      const list = Array.isArray(d.brands) ? d.brands : [];
      const i = list.findIndex(b => b.id === brand.id);
      if (i >= 0) list[i] = brand; else list.push(brand);
      await setDoc(ref, { brands: list, activeBrand: d.activeBrand || brand.id }, { merge: true });
    } else {
      const list = readLS('brands', '[]');
      const i = list.findIndex(b => b.id === brand.id);
      if (i >= 0) list[i] = brand; else list.push(brand);
      writeLS('brands', list);
      if (!localStorage.getItem(localKey('activeBrand'))) localStorage.setItem(localKey('activeBrand'), brand.id);
    }
    return brand;
  },

  async deleteBrand(id) {
    if (isCloud()) {
      const ref = doc(db, 'users', currentUid);
      const snap = await getDoc(ref);
      const d = snap.exists() ? snap.data() : {};
      const list = (d.brands || []).filter(b => b.id !== id);
      const active = d.activeBrand === id ? (list[0] && list[0].id) || null : d.activeBrand;
      await setDoc(ref, { brands: list, activeBrand: active }, { merge: true });
    } else {
      const list = readLS('brands', '[]').filter(b => b.id !== id);
      writeLS('brands', list);
      if (localStorage.getItem(localKey('activeBrand')) === id) {
        localStorage.setItem(localKey('activeBrand'), (list[0] && list[0].id) || '');
      }
    }
  },

  async getActiveBrandId() {
    if (isCloud()) {
      const snap = await getDoc(doc(db, 'users', currentUid));
      return snap.exists() ? (snap.data().activeBrand || null) : null;
    }
    return localStorage.getItem(localKey('activeBrand')) || null;
  },

  async setActiveBrand(id) {
    if (isCloud()) {
      await setDoc(doc(db, 'users', currentUid), { activeBrand: id }, { merge: true });
    } else {
      localStorage.setItem(localKey('activeBrand'), id || '');
    }
  },

  /* ----- posts (subcollection in cloud, keyed object locally) ----- */
  async listPosts() {
    if (isCloud()) {
      const col = collection(db, 'users', currentUid, 'posts');
      const snap = await getDocs(query(col, orderBy('createdAt', 'desc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const obj = readLS('posts', '{}');
    return Object.values(obj).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },

  async savePost(post) {
    if (isCloud()) {
      const col = collection(db, 'users', currentUid, 'posts');
      if (post.id) {
        const { id, ...data } = post;
        await updateDoc(doc(col, id), data);
        return post;
      }
      const data = { ...post, createdAt: Date.now() };
      const ref = await addDoc(col, data);
      return { id: ref.id, ...data };
    }
    const obj = readLS('posts', '{}');
    if (!post.id) post.id = uid();
    if (!post.createdAt) post.createdAt = Date.now();
    obj[post.id] = post;
    writeLS('posts', obj);
    return post;
  },

  async savePostsBulk(posts) {
    const saved = [];
    for (const p of posts) saved.push(await this.savePost(p));
    return saved;
  },

  async deletePost(id) {
    if (isCloud()) {
      await deleteDoc(doc(db, 'users', currentUid, 'posts', id));
    } else {
      const obj = readLS('posts', '{}'); delete obj[id]; writeLS('posts', obj);
    }
  },

  /* On sign-in, copy local data into the cloud account, then ALWAYS wipe
     localStorage so a different signed-out browser tab doesn't show this
     user's data. Defensive — runs regardless of whether migration found
     anything. */
  async migrateLocalToCloud() {
    if (!isCloud()) return;
    try {
      const localBrands = readLS('brands', '[]');
      const localPosts = readLS('posts', '{}');
      const localActive = localStorage.getItem(localKey('activeBrand'));
      const cloudBrands = await this.listBrands();
      if (cloudBrands.length === 0 && localBrands.length > 0) {
        await setDoc(doc(db, 'users', currentUid), { brands: localBrands, activeBrand: localActive || localBrands[0].id }, { merge: true });
      }
      const cloudPosts = await this.listPosts();
      if (cloudPosts.length === 0) {
        for (const p of Object.values(localPosts)) {
          const { id, ...rest } = p;
          await this.savePost(rest);
        }
      }
    } catch (err) { console.warn('[storage] migration partial:', err); }
    // ALWAYS clear local — privacy critical, runs whether migration succeeded or not.
    this.clearAllLocal();
  },

  /* Wipe every stmz_* key from this browser. Used on sign-in (post-migration)
     and on sign-out (so next visitor sees a fresh anonymous workspace). */
  clearAllLocal() {
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('stmz_')) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch {}
  },

  /* ----- integrations (LinkedIn token + webhook URL etc.) ----- */
  async getIntegrations() {
    if (isCloud()) {
      const snap = await getDoc(doc(db, 'users', currentUid));
      const d = snap.exists() ? snap.data() : {};
      return d.integrations || {};
    }
    return readLS('integrations', '{}');
  },

  async setIntegration(key, value) {
    if (isCloud()) {
      await setDoc(doc(db, 'users', currentUid), { integrations: { [key]: value } }, { merge: true });
    } else {
      const all = readLS('integrations', '{}');
      all[key] = value;
      writeLS('integrations', all);
    }
  },

  /* ----- AutoPilot config ----- */
  async getAutoPilot() {
    if (isCloud()) {
      const snap = await getDoc(doc(db, 'users', currentUid));
      const d = snap.exists() ? snap.data() : {};
      return d.autopilot || null;
    }
    return readLS('autopilot', 'null');
  },

  async setAutoPilot(config) {
    if (isCloud()) {
      await setDoc(doc(db, 'users', currentUid), { autopilot: config }, { merge: true });
    } else {
      writeLS('autopilot', config);
    }
  },
};
