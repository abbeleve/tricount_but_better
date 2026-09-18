"""Receipt parsing via claude-agent-sdk, authenticated with an OAuth token.

This is the provider that works with ``CLAUDE_CODE_OAUTH_TOKEN``. That token is
*not* accepted by ``api.anthropic.com/v1/messages`` -- only the Claude Code CLI
understands it -- so images are handed to the agent as files it reads with the
``Read`` tool rather than as base64 blocks on a Messages request.

The agent is deliberately boxed in: a single tool, a scratch directory holding
nothing but the images, no inherited settings, and hard turn/cost ceilings.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    CLINotFoundError,
    ProcessError,
    ResultMessage,
    query,
)

from ..config import Settings
from .base import ParseResult, VlmError, VlmUnavailable
from .prompt import SYSTEM_PROMPT, user_prompt
from .schema import RECEIPT_JSON_SCHEMA, ParsedReceipt

# Everything the agent must never reach for. `allowed_tools` already whitelists
# Read; this is belt-and-braces against a future default-tool change.
_BLOCKED_TOOLS = [
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
    "Glob",
    "Grep",
]


class AgentSdkReceiptParser:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _env(self) -> dict[str, str]:
        """Environment for the CLI subprocess: credentials plus egress routing."""
        s = self._settings
        env: dict[str, str] = {}
        if s.claude_code_oauth_token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = s.claude_code_oauth_token
        if s.anthropic_base_url:
            env["ANTHROPIC_BASE_URL"] = s.anthropic_base_url
        if s.anthropic_proxy_url:
            # The CLI's HTTP stack honours the standard proxy variables, so this
            # covers both an HTTP and a SOCKS5 tunnel out of a blocked region.
            env["HTTPS_PROXY"] = s.anthropic_proxy_url
            env["HTTP_PROXY"] = s.anthropic_proxy_url
        # Nothing here needs telemetry or auto-update chatter leaving the box.
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        return env

    async def parse(self, image_paths: list[Path]) -> ParseResult:
        if not image_paths:
            raise VlmError("no images to read")
        if not (self._settings.claude_code_oauth_token or self._settings.claude_use_ambient_login):
            raise VlmUnavailable(
                "CLAUDE_CODE_OAUTH_TOKEN is not set; receipt scanning is unavailable."
            )

        workdir = image_paths[0].parent
        names = [p.name for p in image_paths]

        options = ClaudeAgentOptions(
            model=self._settings.vlm_model,
            system_prompt=SYSTEM_PROMPT,
            allowed_tools=["Read"],
            disallowed_tools=_BLOCKED_TOOLS,
            permission_mode="bypassPermissions",
            cwd=str(workdir),
            # Do not inherit the host's CLAUDE.md, hooks, or MCP servers: this
            # run must behave identically on a laptop and on the server.
            setting_sources=[],
            max_turns=len(image_paths) + 4,
            max_budget_usd=self._settings.vlm_max_cost_usd,
            output_format={"type": "json_schema", "schema": RECEIPT_JSON_SCHEMA},
            env=self._env(),
            cli_path=self._settings.claude_cli_path,
        )

        try:
            result = await asyncio.wait_for(
                self._run(options, names), timeout=self._settings.vlm_timeout_seconds
            )
        except TimeoutError as exc:
            raise VlmError("the model took too long to read this receipt") from exc
        except CLINotFoundError as exc:
            raise VlmUnavailable(
                "the Claude Code CLI is not installed on this host "
                "(npm i -g @anthropic-ai/claude-code)"
            ) from exc
        except ProcessError as exc:
            raise VlmError(f"the model process failed: {exc}") from exc

        if result is None:
            raise VlmError("the model returned no result")
        if result.is_error:
            detail = "; ".join(result.errors or []) or result.result or "unknown error"
            raise VlmError(f"receipt parsing failed: {detail}")
        if result.structured_output is None:
            raise VlmError("the model did not return the expected structure")

        receipt = ParsedReceipt.model_validate(result.structured_output)
        cost = Decimal(str(result.total_cost_usd)) if result.total_cost_usd else None
        return ParseResult(receipt=receipt, cost_usd=cost, model=self._settings.vlm_model)

    async def _run(self, options: ClaudeAgentOptions, names: list[str]) -> ResultMessage | None:
        final: ResultMessage | None = None
        async for message in query(prompt=user_prompt(names), options=options):
            if isinstance(message, ResultMessage):
                final = message
        return final
