import { flutterwave } from "./flutterwave.js";
import { paystack } from "./paystack.js";

const PROVIDERS = { paystack, flutterwave };

// Returns the provider only if it exists and has a secret key configured.
export function getProvider(name) {
  const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
  return provider && provider.isEnabled() ? provider : null;
}

export function enabledProviders() {
  return Object.values(PROVIDERS)
    .filter((provider) => provider.isEnabled())
    .map((provider) => provider.name);
}
