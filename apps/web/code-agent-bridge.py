#!/usr/bin/env python3
"""
code-agent-bridge.py — Persistent AIAgent bridge for browser-based coding.

Reads NDJSON from stdin, writes NDJSON to stdout.
One process per session — stays alive until stdin closes or SIGTERM.

Protocol:
  Input:  {"type":"init","workdir":"...","model":"...","apiKey":"...","apiUrl":"...","provider":"...","hermesSessionId":"..."}
          {"type":"message","content":"..."}
          {"type":"cancel"}
  
  Output: {"type":"ready","sessionId":"...","hermesSessionId":"..."}
          {"type":"token","content":"..."}
          {"type":"thinking"}
          {"type":"tool_start","id":"...","tool":"...","args":{...}}
          {"type":"tool_result","id":"...","tool":"...","result":{...}}
          {"type":"answer","text":"...","hermesSessionId":"..."}
          {"type":"error","error":"..."}
          {"type":"cancelled"}
          {"type":"done"}
"""

import sys
import json
import os
import signal
import traceback
import threading

# Add hermes-agent to path
HERMES_PATH = "/usr/local/lib/hermes-agent"
if HERMES_PATH not in sys.path:
    sys.path.insert(0, HERMES_PATH)

def emit(event_type, data=None):
    """Write a JSON event line to stdout."""
    event = {"type": event_type}
    if data:
        event.update(data)
    try:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        sys.exit(0)


def load_project_context(workdir):
    """Load project context files from workdir for the system prompt."""
    sections = []
    ctx_files = ["CLAUDE.md", "AGENTS.md", "README.md", ".cursorrules"]
    for fname in ctx_files:
        fpath = os.path.join(workdir, fname)
        if os.path.isfile(fpath):
            try:
                with open(fpath, "r") as f:
                    content = f.read(8000).strip()
                if content:
                    sections.append(f"## {fname}\n{content}")
            except Exception:
                pass
    if not sections:
        return ""
    return "\n\n".join(sections)


def load_ship_protocol():
    """Load ship/CLARIFY protocol text shared with the Node UI (code-ship-protocol.txt)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "code-ship-protocol.txt")
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except Exception:
        return (
            "When you finish a coding task or reach a checkpoint, emit <!--SHIP--> "
            "alone on its own line and wait for the UI ship chooser."
        )


def build_system_prompt(permission_mode, workdir=None):
    """Build the system prompt based on permission mode and project context."""
    base = """SKILLS — USE THEM:
You have access to skills_list and skill_view tools. Skills contain project-specific knowledge, patterns, and procedures.
- Before starting any non-trivial task, call skills_list to see what's available.
- If a skill matches your task (e.g. "ahd-database-migrations", "ahd-economy-systems", "ahd-route-authoring"), call skill_view to load its instructions BEFORE writing code.
- AHD skills under the "a-house-divided" category contain critical game-specific patterns — always check them for codebase tasks.
- Skills are cheap to read and prevent mistakes. When in doubt, check.

EFFICIENCY RULES — CRITICAL:
- Before each batch of tool calls, emit one short STATUS line describing the goal
  (example: `STATUS: Exploring auth callback routes`). Keep it under ~120 chars,
  plain English, no tool names. The ops UI surfaces this instead of a raw tool tally.
- Batch related operations. Don't read files one at a time when you can search_files or read_files in parallel.
- Don't re-read files you just wrote. Trust your output.
- Use search_files with targeted patterns instead of reading entire directories.
- After finding the issue, fix it immediately — don't explain first, then fix in a separate step.
- Terminal commands should be purposeful — avoid exploratory `ls` or `cat` when you already know the structure.
- Maximum 3 tool calls per user message for simple tasks. Complex tasks should still stay under 15.

RICH RENDERING — MANDATORY FORMAT RULES:

When showing architecture, flows, data structures, or relationships, you MUST wrap mermaid in ```mermaid code fences. Example:
```mermaid
graph TD
    A[Start] --> B[Process]
    B --> C[End]
```

NEVER output bare mermaid source without ```mermaid fences. WRONG:
graph TD
    A[Start] --> B[Process]

NEVER use ASCII art box-drawing (┌─┐ │ └─► etc) for diagrams. It renders as ugly monospace text.

CRITICAL mermaid syntax — any node or edge label containing special characters MUST be wrapped in double quotes, or the parser crashes. Characters that REQUIRE quoting: {{ }} ( ) [ ] / | < > and anything with <br/>. Examples:
  WRONG: B[POST /api/funds/{id}/subscribe]   (the { is parsed as a new node and the whole diagram fails to render)
  RIGHT: B["POST /api/funds/{id}/subscribe"]
  WRONG: H[handleRouteError<br/>500 Error]   RIGHT: H["handleRouteError<br/>500 Error"]
  WRONG: D -->|standalone / no replica| E    RIGHT: D -->|"standalone / no replica"| E
When in doubt, quote the label.

Supported diagram types: graph TD/LR, flowchart, sequenceDiagram, classDiagram, stateDiagram, gantt, pie, erDiagram, mindmap, timeline.

For comparisons or tabular data, use markdown tables:
| Column | Column |
|--------|--------|
| data   | data   |

The browser UI renders mermaid as polished dark-themed interactive SVGs and tables as styled HTML. Use them."""

    ship = load_ship_protocol()
    if ship:
        base += "\n\n" + ship

    if permission_mode == "auto":
        base += "\n\nPERMISSION MODE: AUTO — Execute all tools immediately. Do not ask for permission."
    elif permission_mode == "safe":
        base += "\n\nPERMISSION MODE: SAFE — You may execute read-only tools (read_file, search_files, find_files, terminal with cat/ls/grep/git-status/git-log/git-diff/pwd) without asking. For ANY write/modify operation (write_file, patch, terminal with rm/mv/cp/git-commit/git-push/npm-install or any command that changes files), you MUST first describe what you plan to do and ask the user to approve. Wait for explicit approval before executing."
    elif permission_mode == "confirm":
        base += "\n\nPERMISSION MODE: CONFIRM — You MUST ask for permission before executing ANY tool. Describe what you plan to do and wait for explicit approval. Read-only tools (read_file, search_files, find_files) are the only exception — use those freely."

    if workdir:
        ctx = load_project_context(workdir)
        if ctx:
            base += "\n\n# Project Context\nYou are working in a project directory. Read and follow these project files:\n\n" + ctx

    return base


def main():
    # Read init message
    line = sys.stdin.readline()
    if not line:
        return
    try:
        config = json.loads(line.strip())
    except json.JSONDecodeError as e:
        emit("error", {"error": f"Invalid init JSON: {e}"})
        return

    if config.get("type") != "init":
        emit("error", {"error": f"Expected init message, got: {config.get('type')}"})
        return

    workdir = config.get("workdir", "/root/a-house-divided")
    model = config.get("model", "")
    api_key = config.get("apiKey", "")
    api_url = config.get("apiUrl", "")
    provider = config.get("provider", "")

    # Strip trailing /chat/completions — AIAgent appends it internally
    if api_url.endswith("/chat/completions"):
        api_url = api_url[: -len("/chat/completions")]
    hermes_session_id = config.get("hermesSessionId")

    # Change to workdir
    try:
        os.chdir(workdir)
    except OSError as e:
        emit("error", {"error": f"Cannot chdir to {workdir}: {e}"})
        return

    # Import AIAgent
    try:
        from run_agent import AIAgent
    except ImportError as e:
        emit("error", {"error": f"Cannot import AIAgent: {e}"})
        return

    # Track state for cancellation
    agent = None
    cancel_flag = threading.Event()

    # Permission mode: auto | safe | confirm
    permission_mode = config.get("permissionMode", "auto")
    DANGEROUS_TOOLS = {"write_file", "patch", "terminal"}
    SAFE_CMD_PREFIXES = (
        "cat ", "ls ", "grep ", "rg ", "find ", "head ", "tail ", "wc ",
        "git status", "git log", "git diff", "git branch", "pwd", "echo ",
        "which ", "node --check", "python3 -c", "tsc ", "npm ls", "npx ",
    )

    def needs_approval(tool_name, args):
        if permission_mode == "auto":
            return False
        if permission_mode == "confirm":
            # read_file, search_files, find_files are always safe
            if tool_name in ("read_file", "read_files", "search_files", "find_files", "list_directory"):
                return False
            return True
        if permission_mode == "safe":
            if tool_name in DANGEROUS_TOOLS:
                if tool_name == "terminal":
                    cmd = (args.get("command", "") if isinstance(args, dict) else "").strip().lower()
                    return not any(cmd.startswith(p) for p in SAFE_CMD_PREFIXES)
                return True
            return False
        return False

    # Approval gate — shared between tool_start callback and stdin message handler
    approval_event = threading.Event()
    approval_result = {"approved": False}

    def on_stream_delta(text):
        """Called for each streaming token."""
        if not cancel_flag.is_set():
            emit("token", {"content": text or ""})

    def on_thinking(text=""):
        """Called when model starts thinking."""
        if not cancel_flag.is_set():
            emit("thinking", {"content": text or ""})

    def on_tool_start(tool_call_id, function_name, function_args):
        """Called when a tool starts executing. Blocks if approval needed."""
        if cancel_flag.is_set():
            return

        args_dict = function_args if isinstance(function_args, dict) else {}
        approval_id = tool_call_id or f"tool_{id(function_name)}"

        if needs_approval(function_name, args_dict):
            emit("approval_needed", {
                "id": approval_id,
                "tool": function_name,
                "args": args_dict,
            })
            # Block until approval or timeout
            approval_event.clear()
            approval_result["approved"] = False
            if not approval_event.wait(timeout=300):
                emit("approval_cancelled", {"id": approval_id})
                cancel_flag.set()
                if hasattr(agent, "_interrupt_event"):
                    try: agent._interrupt_event.set()
                    except: pass
                return
            if not approval_result["approved"]:
                cancel_flag.set()
                if hasattr(agent, "_interrupt_event"):
                    try: agent._interrupt_event.set()
                    except: pass
                return

        if not cancel_flag.is_set():
            emit("tool_start", {
                "id": approval_id,
                "tool": function_name,
                "args": args_dict,
            })

    def on_tool_complete(tool_call_id, function_name, function_args, function_result):
        """Called when a tool finishes."""
        if not cancel_flag.is_set():
            emit("tool_result", {
                "id": tool_call_id or f"tool_{id(function_name)}",
                "tool": function_name,
                "result": {"output": str(function_result)} if isinstance(function_result, str) else (function_result if isinstance(function_result, dict) else {"output": str(function_result)}),
            })

    # Register ALL ops platform MCPs for this cloud-code session: knowledge
    # (docs/skills/memory), community (Discord RAG), gamestate (live game), and
    # engine (simulation health). Scoped to cloud-code by registering here rather
    # than in the global hermes config. Shared read-only token; localhost URLs
    # (the bridge runs on the ops box). Failures are non-fatal.
    enabled_toolsets = ["terminal", "file", "web", "vision", "skills"]
    _mcp_token = os.environ.get("OPS_KNOWLEDGE_MCP_TOKEN")
    if _mcp_token:
        _platform_mcps = {
            "ops-knowledge": os.environ.get("OPS_KNOWLEDGE_MCP_URL", "https://mcp.lakesidegames.net/mcp"),
            "community": "https://mcp.lakesidegames.net/community/mcp",
            "gamestate": "https://mcp.lakesidegames.net/gamestate/mcp",
            "engine": "https://mcp.lakesidegames.net/engine/mcp",
            "turndiag": "https://mcp.lakesidegames.net/turndiag/mcp",
            "seed-audit": "https://mcp.lakesidegames.net/seed-audit/mcp",
            "worldsim": "https://mcp.lakesidegames.net/worldsim/mcp",
            "security": "https://mcp.lakesidegames.net/security/mcp",
            "support": "https://mcp.lakesidegames.net/support/mcp",
            "discord": "https://mcp.lakesidegames.net/discord/mcp",
        }
        try:
            from tools.mcp_tool import register_mcp_servers
            _cfg = {name: {"url": url, "headers": {"Authorization": f"Bearer {_mcp_token}"}}
                    for name, url in _platform_mcps.items()}
            _names = register_mcp_servers(_cfg)
            if _names:
                enabled_toolsets += list(_platform_mcps.keys())
                print(f"[bridge] platform MCPs: {len(_names)} tool(s) across {', '.join(_platform_mcps)}", file=sys.stderr)
        except Exception as e:
            print(f"[bridge] platform MCP registration failed: {e}", file=sys.stderr)

    # Create agent
    try:
        agent = AIAgent(
            model=model,
            api_key=api_key,
            base_url=api_url,
            provider=provider,
            session_id=hermes_session_id,
            ephemeral_system_prompt=build_system_prompt(permission_mode, workdir=workdir),
            quiet_mode=True,
            enabled_toolsets=enabled_toolsets,
            max_iterations=90,
            stream_delta_callback=on_stream_delta,
            thinking_callback=on_thinking,
            tool_start_callback=on_tool_start,
            tool_complete_callback=on_tool_complete,
            platform="code-agent",
            skip_context_files=False,
            skip_memory=False,
        )
        # Silence agent print output
        agent._print_fn = lambda *a, **k: None
    except Exception as e:
        emit("error", {"error": f"Agent init failed: {e}"})
        return

    # Send ready signal
    emit("ready", {
        "sessionId": getattr(agent, "session_id", None) or "",
        "hermesSessionId": getattr(agent, "session_id", None) or "",
    })

    # Replay history into conversation for context persistence
    conversation_history = config.get("history", [])
    if conversation_history:
        emit("info", {"message": f"Replaying {len(conversation_history)} history messages"})

    # Message loop — uses a thread for agent.chat() so cancel can interrupt
    import queue
    msg_queue = queue.Queue()

    def stdin_reader():
        """Read stdin in background thread so cancel arrives during chat."""
        try:
            for line in sys.stdin:
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg_queue.put(json.loads(line))
                except json.JSONDecodeError:
                    emit("error", {"error": "Invalid JSON message"})
        except (BrokenPipeError, OSError):
            pass
        finally:
            msg_queue.put(None)  # sentinel: stdin closed

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    # Queue for messages that arrive while agent is busy
    pending_messages = []

    while True:
        msg = msg_queue.get()
        if msg is None:
            break  # stdin closed

        msg_type = msg.get("type")

        if msg_type == "message":
            content = msg.get("content", "")
            if not content:
                emit("error", {"error": "Empty message"})
                continue

            # Sync conversation history from MongoDB if provided
            mongo_history = msg.get("history")
            if mongo_history and len(mongo_history) > len(conversation_history):
                conversation_history[:] = mongo_history
                emit("info", {"message": f"Synced {len(mongo_history)} messages from DB"})

            cancel_flag.clear()

            # Run chat in a thread so stdin reader can process cancel
            chat_result = {"response": None, "error": None}

            def run_chat():
                try:
                    # Use run_conversation with history for context persistence
                    hist_len = len(conversation_history) if conversation_history else 0
                    emit("info", {"message": f"Passing {hist_len} history messages to model"})
                    result = agent.run_conversation(
                        content,
                        conversation_history=conversation_history if conversation_history else None,
                    )
                    chat_result["response"] = result.get("final_response", "")
                    # Update local history from the full message list
                    full_messages = result.get("messages", [])
                    if full_messages:
                        conversation_history[:] = full_messages
                        # Send full history to server for MongoDB persistence
                        # (includes tool_calls, tool results — not just stripped text)
                        try:
                            emit("history", {"messages": full_messages})
                        except Exception:
                            pass
                except Exception as e:
                    chat_result["error"] = e

            chat_thread = threading.Thread(target=run_chat, daemon=True)
            chat_thread.start()

            # Wait for chat to finish, but process cancel messages in the meantime
            while chat_thread.is_alive():
                try:
                    inner = msg_queue.get(timeout=0.15)
                except queue.Empty:
                    continue
                if inner is None:
                    # stdin closed mid-chat — cancel and exit
                    cancel_flag.set()
                    if hasattr(agent, "_interrupt_event"):
                        try: agent._interrupt_event.set()
                        except: pass
                    chat_thread.join(timeout=3)
                    sys.exit(0)
                inner_type = inner.get("type")
                if inner_type == "cancel":
                    cancel_flag.set()
                    if hasattr(agent, "_interrupt_event"):
                        try: agent._interrupt_event.set()
                        except: pass
                    emit("cancelled", {})
                elif inner_type == "message":
                    # Queue user messages that arrive while agent is busy
                    pending_messages.append(inner)
                elif inner_type == "switch_model":
                    new_model = inner.get("model", "")
                    new_provider = inner.get("provider", "")
                    new_base_url = inner.get("baseUrl", "")
                    new_api_key = inner.get("apiKey", "")
                    if new_model and agent:
                        try:
                            agent.switch_model(
                                new_model,
                                new_provider or getattr(agent, "provider", ""),
                                api_key=new_api_key,
                                base_url=new_base_url,
                            )
                            emit("model_switched", {"model": agent.model, "provider": agent.provider})
                        except Exception as e:
                            emit("error", {"error": f"Model switch failed: {e}"})
                elif inner_type == "ping":
                    emit("pong", {})
                elif inner_type == "approval_response":
                    approved = inner.get("approved", False)
                    approval_result["approved"] = approved
                    approval_event.set()
                elif inner_type == "set_permissions":
                    new_mode = inner.get("mode", "auto")
                    if new_mode in ("auto", "safe", "confirm"):
                        permission_mode = new_mode

            chat_thread.join()

            if not cancel_flag.is_set():
                if chat_result["error"]:
                    emit("error", {"error": f"Agent error: {chat_result['error']}"})
                    emit("done", {})
                else:
                    # Emit context window usage
                    try:
                        ctx_len = 0
                        if hasattr(agent, "context_compressor") and agent.context_compressor:
                            ctx_len = getattr(agent.context_compressor, "context_length", 0)
                        if not ctx_len:
                            from agent.model_metadata import get_model_context_length
                            ctx_len = get_model_context_length(
                                getattr(agent, "model", "") or model,
                                provider=getattr(agent, "provider", "") or provider
                            )
                        emit("usage", {
                            "inputTokens": getattr(agent, "session_input_tokens", 0),
                            "outputTokens": getattr(agent, "session_output_tokens", 0),
                            "totalTokens": getattr(agent, "session_total_tokens", 0),
                            "contextLength": ctx_len,
                        })
                    except Exception:
                        pass
                    emit("answer", {
                        "text": chat_result["response"] or "",
                        "hermesSessionId": getattr(agent, "session_id", None) or "",
                    })
                    # Emit file change summary
                    try:
                        import subprocess
                        diff_out = subprocess.check_output(
                            ["git", "diff", "--stat", "HEAD"],
                            cwd=workdir, stderr=subprocess.DEVNULL, timeout=5
                        ).decode("utf-8", errors="replace").strip()
                        if diff_out:
                            emit("file_changes", {"summary": diff_out})
                    except Exception:
                        pass
                    emit("done", {})

            # Drain any queued messages back into the main queue
            for pm in pending_messages:
                msg_queue.put(pm)
            pending_messages.clear()

        elif msg_type == "cancel":
            # Cancel outside of a chat — just set the flag
            cancel_flag.set()
            if hasattr(agent, "_interrupt_event"):
                try: agent._interrupt_event.set()
                except: pass
            emit("cancelled", {})

        elif msg_type == "switch_model":
            new_model = msg.get("model", "")
            new_provider = msg.get("provider", "")
            new_base_url = msg.get("baseUrl", "")
            new_api_key = msg.get("apiKey", "")
            if new_model and agent:
                try:
                    agent.switch_model(
                        new_model,
                        new_provider or getattr(agent, "provider", ""),
                        api_key=new_api_key,
                        base_url=new_base_url,
                    )
                    emit("model_switched", {"model": agent.model, "provider": agent.provider})
                except Exception as e:
                    emit("error", {"error": f"Model switch failed: {e}"})

        elif msg_type == "ping":
            emit("pong", {})

        elif msg_type == "approval_response":
            approved = msg.get("approved", False)
            approval_result["approved"] = approved
            approval_event.set()

        elif msg_type == "set_permissions":
            new_mode = msg.get("mode", "auto")
            if new_mode in ("auto", "safe", "confirm"):
                permission_mode = new_mode
                emit("info", {"message": f"Permission mode: {new_mode}"})

        else:
            emit("error", {"error": f"Unknown message type: {msg_type}"})


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, OSError):
        pass
    except Exception as e:
        try:
            emit("error", {"error": f"Bridge fatal: {e}"})
        except Exception:
            pass
