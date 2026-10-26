"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $("refresh-dialog"), status = $("refresh-status");
  let snapshot = "", requestedAt = 0, timer, busy = false, awaiting = false;
  const dismissalKey = "cruiser-scout-dismissed-coverage";
  window.CruiserRefresh = {
    notice(stamp, incomplete) {
      snapshot = stamp || "";
      let dismissed = "";
      try { dismissed = localStorage.getItem(dismissalKey); } catch {}
      $("collection-notice").hidden = !incomplete || !!snapshot && dismissed === snapshot;
    }
  };
  $("collection-dismiss").addEventListener("click", () => {
    $("collection-notice").hidden = true;
    try { if (snapshot) localStorage.setItem(dismissalKey, snapshot); } catch {}
  });
  async function request(action, key) {
    const response = await fetch("/api/refresh", action ? {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify({action, key})
    } : {cache:"no-store", credentials:"same-origin"});
    const data = await response.json();
    return {code:response.status, data};
  }
  function schedule() {
    clearTimeout(timer);
    if (dialog.open) timer = setTimeout(check, 30000);
  }
  async function check() {
    if (busy) return;
    busy = true;
    $("refresh-check").disabled = true;
    try {
      const {code, data} = await request();
      $("refresh-login").hidden = code !== 401;
      $("refresh-start").hidden = code !== 200;
      $("refresh-lock").hidden = code !== 200;
      if (code !== 200) { status.textContent = data.message || "Refresh status is unavailable."; return; }
      if (data.run) $("refresh-run").href = data.run.url;
      if (data.active) { awaiting = true; if (!requestedAt) requestedAt = Date.now(); }
      $("refresh-start").disabled = data.active || data.cooldown || awaiting;
      if (data.active) status.textContent = "Refresh running. You can close this window and check back later.";
      else if (awaiting) status.textContent = "Waiting for collection and publishing to finish…";
      else if (data.cooldown) status.textContent = "Next manual refresh available after " + new Date(data.nextAllowedAt).toLocaleTimeString() + ".";
      else status.textContent = "Ready. Manual refreshes are limited to once an hour.";
      if (awaiting) {
        const response = await fetch("/inventory.json", {cache:"no-store"});
        if (!response.ok) throw new Error();
        const latest = await response.json();
        if (!data.active && latest.generated_at && Date.parse(latest.generated_at) > Date.parse(snapshot)) {
          $("refresh-load").hidden = false;
          awaiting = false;
          status.textContent = (latest.source_health || []).some(s => ["partial","error"].includes(s.status))
            ? "Updated inventory is ready. Some sources were incomplete; previously verified listings were preserved."
            : "Updated inventory is ready.";
        } else if (!data.active && data.run && Date.parse(data.run.startedAt) >= requestedAt - 5000 && data.run.conclusion !== "success") {
          status.textContent = "The refresh finished with an issue. Checking for published inventory; see the GitHub run for details.";
          if (Date.now() - requestedAt > 45 * 60000) awaiting = false;
        } else if (Date.now() - requestedAt > 45 * 60000) {
          awaiting = false;
          status.textContent = "No new inventory has appeared yet. Check the GitHub run for progress; you can check again later.";
        }
      }
      if (data.active || awaiting || data.cooldown) schedule();
    } catch { status.textContent = "Could not check refresh status. Try again in a moment."; }
    finally { busy = false; $("refresh-check").disabled = false; }
  }
  $("refresh-open").addEventListener("click", () => { dialog.showModal(); check(); });
  $("refresh-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { clearTimeout(timer); $("refresh-key").value = ""; });
  $("refresh-check").addEventListener("click", check);
  $("refresh-unlock").addEventListener("click", async () => {
    $("refresh-unlock").disabled = true;
    try {
      const {code, data} = await request("login", $("refresh-key").value.trim());
      $("refresh-key").value = "";
      if (code === 200) await check(); else status.textContent = data.message;
    } catch { status.textContent = "Could not unlock owner controls. Please try again."; }
    finally { $("refresh-unlock").disabled = false; }
  });
  $("refresh-key").addEventListener("keydown", e => { if (e.key === "Enter") $("refresh-unlock").click(); });
  $("refresh-start").addEventListener("click", async () => {
    $("refresh-start").disabled = true;
    try {
      const {code, data} = await request("start");
      status.textContent = data.message;
      if (code === 202) { awaiting = true; requestedAt = Date.now(); schedule(); }
      else await check();
    } catch { status.textContent = "Request status is uncertain. Check status before trying again."; schedule(); }
  });
  $("refresh-lock").addEventListener("click", async () => {
    try { await request("logout"); await check(); } catch { status.textContent = "Could not lock owner controls. Please try again."; }
  });
  $("refresh-load").addEventListener("click", () => location.reload());
})();
