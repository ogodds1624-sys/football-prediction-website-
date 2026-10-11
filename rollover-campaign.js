(function rolloverCampaign() {
  const campaigns = [
    { plan: "weekly", name: "Weekly Rollover", prefix: "rollover" },
    { plan: "boom", name: "Boom night games", prefix: "boom" },
  ].map((campaign) => ({
    ...campaign,
    dialog: document.querySelector(`#${campaign.prefix}-campaign`),
    join: document.querySelector(`#${campaign.prefix}-join`),
    error: document.querySelector(`#${campaign.prefix}-campaign-error`),
    shown: new Set(),
  }));
  let checking = false;

  function scheduledCampaign() {
    const now = new Date();
    const hour = now.getUTCHours();
    const campaign = campaigns[hour >= 6 && hour < 20 ? 0 : 1];
    // The after-midnight hours belong to the night campaign that started yesterday.
    if (hour < 6) {
      now.setUTCDate(now.getUTCDate() - 1);
    }
    return { campaign, date: now.toISOString().slice(0, 10) };
  }

  async function invite() {
    if (checking || document.hidden || location.protocol === "file:") {
      return;
    }
    const { campaign, date } = scheduledCampaign();
    for (const other of campaigns) {
      if (other !== campaign && other.dialog.open) {
        other.dialog.close();
      }
    }
    if (campaign.shown.has(date)) {
      return;
    }
    checking = true;
    try {
      if (!await loadCurrentUser() || !currentUser || coversTier(campaign.plan)) {
        return;
      }
      const response = await fetch("/api/me/warnings", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Couldn't check account notices before showing the campaign invitation.");
      }
      const { warnings } = await response.json();
      if (warnings.length || document.querySelector("dialog[open]")) {
        return;
      }
      const latest = scheduledCampaign();
      if (latest.campaign !== campaign || latest.date !== date || !currentUser || coversTier(campaign.plan)) {
        return;
      }
      campaign.shown.add(date);
      campaign.dialog.showModal();
    } catch (failure) {
      console.error("Campaign invitation failed:", failure);
      popToast("Campaign invitation unavailable", failure.message, 5000);
    } finally {
      checking = false;
    }
  }

  for (const campaign of campaigns) {
    const { dialog, join, error, plan, prefix, name } = campaign;
    document.querySelector(`#${prefix}-later`).addEventListener("click", () => dialog.close());
    join.addEventListener("click", async () => {
      join.disabled = true;
      error.textContent = "";
      try {
        if (!await loadCurrentUser()) {
          error.textContent = "Couldn't check your account. Please try again.";
          return;
        }
        if (!currentUser || coversTier(plan)) {
          dialog.close();
          return;
        }
        const options = await loadOptions();
        if (options.slots?.[plan] === 0) {
          error.textContent = `${name} slots are full. Please check back later.`;
          return;
        }
        location.href = `pay.html?plan=${plan}`;
      } catch (failure) {
        console.error("Campaign checkout failed:", failure);
        error.textContent = failure.message;
      } finally {
        join.disabled = false;
      }
    });
  }
  window.addEventListener("member-blocked", () => {
    for (const campaign of campaigns) {
      campaign.dialog.close();
    }
  });
  window.addEventListener("pageshow", invite);
  document.addEventListener("visibilitychange", invite);
  window.setInterval(invite, 10000);
  invite();
})();
