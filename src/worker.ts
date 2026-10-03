// Worker entry: Astro's handler, plus the Cron Trigger that runs EmDash's
// scheduled publishing and maintenance. PluginBridge is exported for the
// plugin sandbox (unused today; harmless when no plugin is installed).
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
  ...handler,
  scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
