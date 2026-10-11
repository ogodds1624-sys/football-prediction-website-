// Vercel entry point: API and public document requests use the Express app.
// Public HTML is included in the function bundle for server-side access checks.
import { createApp } from "../server/src/app.js";

export default createApp();
