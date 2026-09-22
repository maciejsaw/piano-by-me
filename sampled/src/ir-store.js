// The hall's loaded impulse response, kept across reloads.
//
// A captured IR is megabytes -- far past what localStorage holds -- so it goes
// in IndexedDB as the file's own bytes and is decoded again on load. One slot:
// there is one hall.

const DB = 'piano-sampled-ir', STORE = 'ir', KEY = 'hall';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

/** { name, bytes } or undefined. */
export const get = () => tx('readonly', (s) => s.get(KEY));
export const put = (name, bytes) => tx('readwrite', (s) => s.put({ name, bytes }, KEY));
export const clear = () => tx('readwrite', (s) => s.delete(KEY));
