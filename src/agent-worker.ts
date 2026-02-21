// ---------------------------------------------------------------------------
// BrowserClaw — Agent Worker
// ---------------------------------------------------------------------------
//
// Runs in a dedicated Web Worker. Owns the Claude API tool-use loop.
// Communicates with the main thread via postMessage.
//
// This is the browser equivalent of NanoClaw's container agent runner.
// Instead of Claude Agent SDK in a Linux container, we use raw Anthropic
// API calls with a tool-use loop.

import type { WorkerInbound, WorkerOutbound, InvokePayload, ConversationMessage, ThinkingLogEntry } from './types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { ANTHROPIC_API_URL, ANTHROPIC_API_VERSION, FETCH_MAX_RESPONSE } from './config.js';
import { readGroupFile, writeGroupFile, listGroupFiles } from './storage.js';
import { executeShell } from './shell.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'invoke':
      await handleInvoke(payload);
      break;
    case 'cancel':
      // TODO: AbortController-based cancellation
      break;
  }
};

// Shell emulator needs no boot — it's pure JS over OPFS

// ---------------------------------------------------------------------------
// Agent invocation — tool-use loop
// ---------------------------------------------------------------------------

async function handleInvoke(payload: InvokePayload): Promise<void> {
  const { groupId, messages, systemPrompt, apiKey, model, maxTokens } = payload;

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Starting', `Model: ${model} · Max tokens: ${maxTokens}`);

  try {
    let currentMessages: ConversationMessage[] = [...messages];
    let iterations = 0;
    const maxIterations = 25; // Safety limit to prevent infinite loops

    while (iterations < maxIterations) {
      iterations++;

      const body = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: currentMessages,
        tools: TOOL_DEFINITIONS,
      };

      log(groupId, 'api-call', `API call #${iterations}`, `${currentMessages.length} messages in context`);

      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
      }

      const result = await res.json();

      // Log any text blocks in the response (intermediate reasoning)
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          const preview = block.text.length > 200 ? block.text.slice(0, 200) + '…' : block.text;
          log(groupId, 'text', 'Response text', preview);
        }
      }

      if (result.stop_reason === 'tool_use') {
        // Execute all tool calls
        const toolResults = [];
        for (const block of result.content) {
          if (block.type === 'tool_use') {
            const inputPreview = JSON.stringify(block.input);
            const inputShort = inputPreview.length > 300 ? inputPreview.slice(0, 300) + '…' : inputPreview;
            log(groupId, 'tool-call', `Tool: ${block.name}`, inputShort);

            post({
              type: 'tool-activity',
              payload: { groupId, tool: block.name, status: 'running' },
            });

            const output = await executeTool(block.name, block.input, groupId);

            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            const outputShort = outputStr.length > 500 ? outputStr.slice(0, 500) + '…' : outputStr;
            log(groupId, 'tool-result', `Result: ${block.name}`, outputShort);

            post({
              type: 'tool-activity',
              payload: { groupId, tool: block.name, status: 'done' },
            });

            toolResults.push({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: typeof output === 'string'
                ? output.slice(0, 100_000)
                : JSON.stringify(output).slice(0, 100_000),
            });
          }
        }

        // Continue the conversation with tool results
        currentMessages.push({ role: 'assistant', content: result.content });
        currentMessages.push({ role: 'user', content: toolResults as any });

        // Re-signal typing between tool iterations
        post({ type: 'typing', payload: { groupId } });
      } else {
        // Final response — extract text
        const text = result.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('');

        // Strip internal tags (matching NanoClaw pattern)
        const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

        post({ type: 'response', payload: { groupId, text: cleaned || '(no response)' } });
        return;
      }
    }

    // If we hit max iterations
    post({
      type: 'response',
      payload: {
        groupId,
        text: '⚠️ Reached maximum tool-use iterations (25). Stopping to avoid excessive API usage.',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', payload: { groupId, error: message } });
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  groupId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'bash': {
        const result = await executeShell(
          input.command as string,
          groupId,
          {},
          Math.min((input.timeout as number) || 30, 120),
        );
        let output = result.stdout;
        if (result.stderr) output += (output ? '\n' : '') + result.stderr;
        if (result.exitCode !== 0 && !result.stderr) {
          output += `\n[exit code: ${result.exitCode}]`;
        }
        return output || '(no output)';
      }

      case 'read_file':
        return await readGroupFile(groupId, input.path as string);

      case 'write_file':
        await writeGroupFile(groupId, input.path as string, input.content as string);
        return `Written ${(input.content as string).length} bytes to ${input.path}`;

      case 'list_files': {
        const entries = await listGroupFiles(groupId, (input.path as string) || '.');
        return entries.length > 0 ? entries.join('\n') : '(empty directory)';
      }

      case 'fetch_url': {
        const fetchRes = await fetch(input.url as string, {
          method: (input.method as string) || 'GET',
          headers: input.headers as Record<string, string> | undefined,
          body: input.body as string | undefined,
        });
        const text = await fetchRes.text();
        const status = `[HTTP ${fetchRes.status}]\n`;
        return status + text.slice(0, FETCH_MAX_RESPONSE);
      }

      case 'update_memory':
        await writeGroupFile(groupId, 'CLAUDE.md', input.content as string);
        return 'Memory updated successfully.';

      case 'create_task': {
        // Post back to main thread to create the task
        // We use a special message type that the orchestrator handles
        const taskData = {
          id: ulid(),
          groupId,
          schedule: input.schedule as string,
          prompt: input.prompt as string,
          enabled: true,
          lastRun: null,
          createdAt: Date.now(),
        };
        // We can't access IndexedDB from a worker easily for tasks,
        // so we encode the task as the result and let the orchestrator save it.
        return `__TASK_CREATED__${JSON.stringify(taskData)}`;
      }

      case 'javascript': {
        try {
          // Indirect eval: (0, eval)(...) runs in global scope and
          // naturally returns the value of the last expression —
          // no explicit `return` needed.
          const code = input.code as string;
          const result = (0, eval)(`"use strict";\n${code}`);
          if (result === undefined) return '(no return value)';
          if (result === null) return 'null';
          if (typeof result === 'object') {
            try { return JSON.stringify(result, null, 2); } catch { /* fall through */ }
          }
          return String(result);
        } catch (err: unknown) {
          return `JavaScript error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: unknown) {
    return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(message: WorkerOutbound): void {
  (self as unknown as Worker).postMessage(message);
}

function log(
  groupId: string,
  kind: ThinkingLogEntry['kind'],
  label: string,
  detail?: string,
): void {
  post({
    type: 'thinking-log',
    payload: { groupId, kind, timestamp: Date.now(), label, detail },
  });
}
