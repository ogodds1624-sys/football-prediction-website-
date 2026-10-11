(function rolloverCampaign() {
  const dialog = document.querySelector("#rollover-campaign");
  const join = document.querySelector("#rollover-join");
  const error = document.querySelector("#rollover-campaign-error");
  let shown = false;
  let checking = false;

  async function invite() {
    if (shown || checking || document.hidden || location.protocol === "file:") {
      return;
    }
    checking = true;
    try {
      if (!await loadCurrentUser() || !currentUser || coversTier("weekly")) {
        return;
      }
      const response = await fetch("/api/me/warnings", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Couldn't check account notices before showing the rollover invitation.");
      }
      const { warnings } = await response.json();
      if (warnings.length || document.querySelector("dialog[open]")) {
        return;
      }
      shown = true;
      dialog.showModal();
    } catch (failure) {
      console.error("Rollover invitation failed:", failure);
      popToast("Rollover invitation unavailable", failure.message, 5000);
    } finally {
      checking = false;
    }
  }

  document.querySelector("#rollover-later").addEventListener("click", () => dialog.close());
  join.addEventListener("click", async () => {
    join.disabled = true;
    error.textContent = "";
    try {
      if (!await loadCurrentUser()) {
        error.textContent = "Couldn't check your account. Please try again.";
        return;
      }
      if (!currentUser || coversTier("weekly")) {
        dialog.close();
        return;
      }
      const options = await loadOptions();
      if (options.slots?.weekly === 0) {
        error.textContent = "Weekly Rollover slots are full. Please check back later.";
        return;
      }
      location.href = "pay.html?plan=weekly";
    } catch (failure) {
      console.error("Rollover checkout failed:", failure);
      error.textContent = failure.message;
    } finally {
      join.disabled = false;
    }
  });
  window.addEventListener("member-blocked", () => dialog.close());
  window.addEventListener("pageshow", invite);
  document.addEventListener("visibilitychange", invite);
  window.setInterval(invite, 10000);
  invite();
})();
