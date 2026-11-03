# Shared kanban instructions for a contributor's coding agent

```text
Use https://ops.lakesidegames.net/kanban as the shared work register.
Use my signed-in Junior Developer browser session. Do not request or reuse
another person's cookies, an administrator session or the host's MCP token.

1. Read the program and child GitHub issues, current board history and linked
   PRs before choosing work. Check what is already merged or under review.
2. Work on a bounded child task. Do not claim the entire economy program.
3. Refresh the board and claim an unassigned task before coding. If someone
   already owns it or the claim is rejected, stop and coordinate a handoff.
4. Post the intended scope and branch on that same card. Use an isolated
   worktree and link the issue in the implementation PR.
5. Post meaningful progress with findings, checks, PR links and remaining work.
   Read the latest notes before resuming after an interruption.
6. Mark blocked with a reason when blocked. Release with a concrete handoff
   note if you stop owning it. Do not take or rewrite someone else's task.
7. Complete only after that task's acceptance criteria are verified, with an
   evidence URL. An opened PR is progress, not completion. Leave persistent
   programs open and complete their individual delivery tasks.

GitHub holds the specification. Kanban holds ownership, progress and next moves.
If no suitable task exists, ask the owner to add or split one before starting.
```

An agent with browser automation can read `GET /api/kanban` and
`GET /api/kanban/items/:id`, then use this from the signed-in dashboard origin:

```js
async function taskAction(id, action, summary, evidenceUrl) {
  const response = await fetch(`/api/kanban/items/${id}/collaborate`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "ops-dashboard",
    },
    body: JSON.stringify({ action, summary, evidence_url: evidenceUrl }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.item;
}

// Substitute a real, unassigned child card ID after reading its scope/history.
await taskAction(cardId, "claim", "Taking the agreed UI/query slice");
await taskAction(cardId, "progress", "Branch created; checking receipt definitions");
// Other actions: blocked, resume, release, completed.
// completed requires an evidence URL; all actions except claim require a note.
```

The API attributes actions to the signed-in contributor. It does not grant a
headless agent a new credential. Without access to that browser session, have
the contributor claim and update the card through the UI.
