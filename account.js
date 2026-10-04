const tabLogin = document.querySelector("#tab-login");
const tabRegister = document.querySelector("#tab-register");
const title = document.querySelector("#account-title");
const subtitle = document.querySelector("#account-subtitle");
const form = document.querySelector("#account-form");
const nameRow = document.querySelector("#name-row");
const nameInput = document.querySelector("#name");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const errorText = document.querySelector("#account-error");
const submitButton = document.querySelector("#account-submit");

let mode = new URLSearchParams(location.search).get("mode") === "register" ? "register" : "login";

// Only allow returning to a page on this site.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next") || "index.html";
  return /^[a-z0-9-]+\.html(\?[\w=&%-]*)?$/i.test(next) ? next : "index.html";
}

function setMode(newMode) {
  mode = newMode;
  const registering = mode === "register";
  tabLogin.setAttribute("aria-pressed", String(!registering));
  tabRegister.setAttribute("aria-pressed", String(registering));
  title.textContent = registering ? "Create account" : "Sign in";
  subtitle.textContent = registering ? "Create an account to buy VIP and VVIP plans." : "Sign in to buy VIP and VVIP plans.";
  submitButton.textContent = registering ? "CREATE ACCOUNT" : "SIGN IN";
  // Name is only asked for when creating an account.
  nameRow.hidden = !registering;
  nameInput.required = registering;
  passwordInput.autocomplete = registering ? "new-password" : "current-password";
  passwordInput.placeholder = registering ? "Password (at least 8 characters)" : "Password";
  errorText.textContent = "";
}

tabLogin.addEventListener("click", () => setMode("login"));
tabRegister.addEventListener("click", () => setMode("register"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorText.textContent = "";
  submitButton.disabled = true;
  try {
    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameInput.value, email: emailInput.value, password: passwordInput.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorText.textContent = body.error || "Something went wrong. Please try again.";
      return;
    }
    location.href = nextPage();
  } catch {
    errorText.textContent = "Can't reach the server. Check your connection and try again.";
  } finally {
    submitButton.disabled = false;
  }
});

setMode(mode);
emailInput.value = new URLSearchParams(location.search).get("email") || "";
