// localStorage throws (SecurityError / QuotaExceededError) in some private
// modes and when site data is blocked — a UI preference must never crash the
// page over it, so reads fall back to null and writes are dropped.
export function readPref(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* preference just isn't remembered */ }
}
