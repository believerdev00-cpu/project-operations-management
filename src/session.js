// Where the browser keeps who is signed in -- one sign-in per tab.
//
// It used to live in localStorage alone, which every tab of the site shares.
// Signed in as a manager in one tab and as the Director in another, the last
// sign-in was the one every tab found on its next reload: reloading the
// manager's tab opened the Director's account.
//
// Now each tab keeps its own copy in sessionStorage, which belongs to that tab
// and survives its reloads; localStorage keeps only the most recent sign-in,
// so a NEW tab still opens signed in, as before. A tab adopts that copy once,
// when it starts with none of its own, and is not moved by later sign-ins in
// other tabs. Signing out clears this tab, and the shared copy only when it is
// this tab's own sign-in -- another tab's account is left alone.
//
// Storage can be blocked (private windows, strict settings); every access is
// guarded, and a blocked store just means nobody is remembered.
const KEYS = ['ops-token', 'ops-user'];

const tab = {
  get: (key) => { try { return sessionStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { sessionStorage.setItem(key, value); return true; } catch { return false; } },
  remove: (key) => { try { sessionStorage.removeItem(key); } catch { /* nothing to remove */ } }
};
const shared = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
  remove: (key) => { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } }
};

// A tab opened without a sign-in of its own takes the most recent one, once.
if (tab.get('ops-token') === null) {
  const token = shared.get('ops-token');
  if (token !== null) {
    for (const key of KEYS) {
      const value = shared.get(key);
      if (value !== null) tab.set(key, value);
    }
  }
}

export function readSession(key) {
  const own = tab.get(key);
  // No sessionStorage at all (very old or locked-down browser): the shared
  // copy is the only one there is.
  return own !== null ? own : shared.get(key);
}

export function writeSession(key, value) {
  tab.set(key, value);
  shared.set(key, value);
}

// The account's details, read again from the server, written back for this tab
// -- and to the shared copy only while it is this tab's own sign-in, so a
// reload here never pairs another tab's token with this tab's account.
export function refreshSession(key, value) {
  tab.set(key, value);
  if (shared.get('ops-token') === tab.get('ops-token')) shared.set(key, value);
}

export function clearSession(key) {
  const own = tab.get(key);
  tab.remove(key);
  if (own === null || shared.get(key) === own) shared.remove(key);
}

// The token this tab is signed in with, for the few requests made outside
// useApi (a picture fetched as a blob).
export const sessionToken = () => readSession('ops-token') || '';
