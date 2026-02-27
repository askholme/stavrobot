# TODO items

Work on these one at a time. Delete when the user confirms they're done:

- Allow scoping subagent tool permissions to specific actions (e.g.,
  "manage_interlocutors.list" but not "manage_interlocutors.create"). Currently tool
  whitelisting is tool-level only.
- Disabled-interlocutor outbound bypass via raw identifier: the send tools
  (`send_signal_message`, `send_telegram_message`) enforce the `enabled` check only when
  the recipient is resolved by display name via `resolveRecipient()`. When the LLM passes
  a raw phone number or chat ID, the fallback path at `src/agent.ts:390` (Signal) and
  `src/agent.ts:563` (Telegram) queries `interlocutor_identities` directly without
  joining to `interlocutors` to check `enabled`. A disabled interlocutor can still
  receive outbound messages if the agent uses the raw identifier. Fix: in the raw-ID
  identity check queries, join to `interlocutors` and add `AND i.enabled = true`:
  `SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON
  i.id = ii.interlocutor_id WHERE ii.service = $1 AND ii.identifier = $2 AND
  i.enabled = true`.

