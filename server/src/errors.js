// An error whose message is safe to show to the user.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A payment provider rejected a request or could not be reached.
export class ProviderError extends Error {}
