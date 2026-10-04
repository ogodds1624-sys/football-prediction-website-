// Vercel entry point: every /api/* request is handled by the Express app.
// The website pages themselves are served directly by Vercel.
import { createApp } from "../server/src/app.js";

export default createApp();
