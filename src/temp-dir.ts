// Ephemeral files created by the agent (e.g. manage_files writes, plugin tool output)
// are placed here so the send tools can identify them for auto-deletion without
// risking deletion of user-uploaded files that also live under /tmp.
export const TEMP_ATTACHMENTS_DIR = "/tmp/stavrobot-temp";
