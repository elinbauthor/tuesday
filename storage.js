/* Tuesday — local storage layer.

   Stands in for the artifact runtime's window.storage, with the same four
   methods and the same shapes, so the app code above it is unchanged. That
   seam is the only reason this port is a swap rather than a rewrite.

   IndexedDB rather than localStorage: the thumbnails run to about 10 MB and
   localStorage caps out around 5 MB, with everything serialised as strings.

   Scope note: this is per-device. Two devices hold two separate wardrobes
   until the Drive layer lands. */

(function () {
  const DB_NAME = "tuesday";
  const DB_VERSION = 1;
  const STORE = "kv";

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("could not open database"));
      req.onblocked = () => reject(new Error("database blocked by another open tab"));
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          let result;
          try {
            result = fn(store);
          } catch (e) {
            reject(e);
            return;
          }
          t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
          t.onerror = () => reject(t.error || new Error("transaction failed"));
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
        })
    );
  }

  const wrap = (req) => ({ __req: req });

  window.storage = {
    /* Returns null for a missing key rather than throwing. The app treats a
       null and a throw identically, and null is safer for any caller that
       forgets to catch. */
    async get(key) {
      const value = await tx("readonly", (store) => wrap(store.get(key)));
      if (value === undefined) return null;
      return { key, value, shared: false };
    },

    async set(key, value) {
      await tx("readwrite", (store) => wrap(store.put(value, key)));
      return { key, value, shared: false };
    },

    async delete(key) {
      await tx("readwrite", (store) => wrap(store.delete(key)));
      return { key, deleted: true, shared: false };
    },

    async list(prefix) {
      const keys = await tx("readonly", (store) => wrap(store.getAllKeys()));
      const all = keys || [];
      const filtered = prefix ? all.filter((k) => String(k).startsWith(prefix)) : all;
      return { keys: filtered, prefix: prefix || "", shared: false };
    },

    /* Not part of the artifact API. Used by the debug panel to show how much
       is held locally, since a silent quota failure is hard to diagnose. */
    async _usage() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const est = await navigator.storage.estimate();
      return { usage: est.usage, quota: est.quota };
    },
  };
})();
