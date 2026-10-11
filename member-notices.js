(function memberNotices() {
  const dialog = document.createElement("dialog");
  dialog.className = "member-notice-dialog";
  dialog.setAttribute("aria-labelledby", "member-notice-title");
  const heading = document.createElement("h2");
  heading.id = "member-notice-title";
  const message = document.createElement("p");
  message.className = "member-notice-copy";
  const status = document.createElement("p");
  status.className = "form-message";
  status.setAttribute("role", "alert");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline-button";
  dialog.append(heading, message, status, button);
  document.body.append(dialog);
  const noticeError = document.createElement("p");
  noticeError.className = "member-notice-error";
  noticeError.setAttribute("role", "alert");
  noticeError.hidden = true;
  document.body.append(noticeError);
  let warning = null;
  let blocked = false;
  let loading = false;
  let acting = false;

  dialog.addEventListener("cancel", (event) => event.preventDefault());

  function showNotice() {
    heading.textContent = blocked ? "Account blocked" : "Warning from the administrator";
    message.textContent = blocked ? "Your account is blocked. Contact support for help. Payments and subscription expiry have not changed." : warning.message;
    button.textContent = blocked ? "Go to sign-in" : "I acknowledge this warning";
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  async function checkNotices() {
    if (loading || acting || document.hidden || location.protocol === "file:") {
      return;
    }
    loading = true;
    try {
      const response = await fetch("/api/me/warnings", { cache: "no-store" });
      const body = await response.json();
      if (response.ok || response.status === 401 || body.code === "ACCOUNT_BLOCKED") {
        noticeError.hidden = true;
      }
      if (response.status === 403 && body.code === "ACCOUNT_BLOCKED") {
        blocked = true;
        warning = null;
        window.dispatchEvent(new Event("member-blocked"));
        showNotice();
        return;
      }
      if (response.status === 401) {
        warning = null;
        if (!blocked && dialog.open) {
          dialog.close();
        }
        return;
      }
      if (!response.ok) {
        throw new Error(body.error || "Couldn't check account warnings.");
      }
      noticeError.hidden = true;
      status.textContent = "";
      blocked = false;
      warning = body.warnings[0] || null;
      if (warning) {
        showNotice();
      } else if (dialog.open) {
        dialog.close();
      }
    } catch (error) {
      console.error("Member notice check failed:", error);
      const text = `${error.message} Retrying automatically.`;
      status.textContent = text;
      noticeError.textContent = text;
      noticeError.hidden = dialog.open;
    } finally {
      loading = false;
    }
  }

  button.addEventListener("click", async () => {
    if (acting || loading) {
      return;
    }
    if (!blocked && !warning) {
      await checkNotices();
      return;
    }
    acting = true;
    button.disabled = true;
    status.textContent = "";
    try {
      const url = blocked ? "/api/auth/logout" : `/api/me/warnings/${warning.id}/acknowledge`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Couldn't save your acknowledgement.");
      }
      if (blocked) {
        location.href = "account.html";
        return;
      }
      warning = null;
      dialog.close();
    } catch (error) {
      console.error("Member notice action failed:", error);
      status.textContent = error.message;
      return;
    } finally {
      acting = false;
      button.disabled = false;
    }
    if (!blocked) {
      checkNotices();
    }
  });

  document.addEventListener("visibilitychange", checkNotices);
  window.addEventListener("pageshow", checkNotices);
  window.setInterval(checkNotices, 10000);
  checkNotices();
})();
