import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const config = defineCloudflareConfig();

// Avoid recursive builds when npm "build" runs OpenNext itself.
export default {
  ...config,
  buildCommand: "npm run next:build",
};
