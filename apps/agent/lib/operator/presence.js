"use strict";
function createPresence({ discord, allowed = () => true, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  const channels = new Map();
  function begin(channelId) {
    // Only Discord channels have a typing indicator; the app channel shows task state.
    if (!channelId || channelId === "app") return () => {};
    let entry = channels.get(channelId);
    if (!entry) {
      entry = { users: 0, busy: false };
      const pulse = async () => {
        if (entry.busy || channels.get(channelId) !== entry || !allowed(channelId)) return;
        entry.busy = true;
        try { await discord("POST", `/channels/${channelId}/typing`); } catch { /* Presence is best effort, never task authority. */ }
        finally { entry.busy = false; }
      };
      channels.set(channelId, entry); entry.timer = setIntervalImpl(pulse, 8000); pulse();
    }
    entry.users++;
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      if (--entry.users === 0) { clearIntervalImpl(entry.timer); channels.delete(channelId); }
    };
  }
  return { begin };
}
module.exports = { createPresence };
