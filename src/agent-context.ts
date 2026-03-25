// The agent ID currently being processed by handlePrompt. Set at the start of
// each handlePrompt call. The queue is single-threaded so there is no race
// condition. Extracted into its own module so send-tools.ts can read it without
// creating a circular dependency with agent/index.ts.
export let currentAgentId: number = 0;

export function setCurrentAgentId(id: number): void {
  currentAgentId = id;
}
