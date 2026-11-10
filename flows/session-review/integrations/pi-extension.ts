import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// When a pi session ends, queue it for review into Obsidian (see __ROOT__).
// The review runs in a detached background worker, so quitting pi is never delayed.
const CLI = "__ROOT__/bin/session-review.mjs";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload" || process.env.SESSION_REVIEW_CHILD) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			spawn("__NODE__", [CLI, "enqueue", "pi", file], { detached: true, stdio: "ignore" }).unref();
		} catch {
			// the hourly sweep will pick it up
		}
	});
}
