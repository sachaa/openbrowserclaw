// ---------------------------------------------------------------------------
// OpenBrowserClaw — Agent Worker
// ---------------------------------------------------------------------------
//
// Runs in a dedicated Web Worker. Owns the Claude API tool-use loop.
// Communicates with the main thread via postMessage.
//
// This is the browser equivalent of NanoClaw's container agent runner.
// Instead of Claude Agent SDK in a Linux container, we use raw Anthropic
// API calls with a tool-use loop.

import type { WorkerInbound, WorkerOutbound, InvokePayload, CompactPayload, ConversationMessage, ThinkingLogEntry, TokenUsage } from './types.js';
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
      await handleInvoke(payload as InvokePayload);
      break;
    case 'compact':
      await handleCompact(payload as CompactPayload);
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
  if (payload.provider === 'ollama') {
    return invokeOllama(payload);
  }
  return invokeAnthropic(payload);
}

function getOpenAITools() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

async function invokeOllama(payload: InvokePayload): Promise<void> {
  const { groupId, messages, systemPrompt, ollamaUrl, model, maxTokens } = payload;
  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Starting (Ollama)', `Model: ${model}`);

  try {
    const currentMessages: any[] = [];
    if (systemPrompt) {
      currentMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      currentMessages.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }

    let iterations = 0;
    const maxIterations = 25;

    while (iterations < maxIterations) {
      iterations++;

      const body = {
        model,
        messages: currentMessages,
        tools: getOpenAITools(),
        max_tokens: maxTokens,
      };

      log(
        groupId,
        'api-call',
        `Ollama API call #${iterations}`,
        `${currentMessages.length} messages in context`,
      );

      const res = await fetch(`${ollamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
      }

      const result = await res.json();
      const choice = result.choices[0];
      const message = choice.message;

      if (result.usage) {
        post({
          type: 'token-usage',
          payload: {
            groupId,
            inputTokens: result.usage.prompt_tokens || 0,
            outputTokens: result.usage.completion_tokens || 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextLimit: 8192,
          },
        });
      }

      if (message.content) {
        const preview =
          message.content.length > 200
            ? message.content.slice(0, 200) + '…'
            : message.content;
        log(groupId, 'text', 'Response text', preview);
      }

      currentMessages.push(message);

      if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
        for (const tc of message.tool_calls) {
          const fn = tc.function;
          const inputStr = fn.arguments || '{}';
          log(groupId, 'tool-call', `Tool: ${fn.name}`, inputStr);

          post({
            type: 'tool-activity',
            payload: { groupId, tool: fn.name, status: 'running' },
          });

          let inputCode = {};
          try {
            inputCode = JSON.parse(inputStr);
          } catch {
            // ignore JSON parse errors and pass empty object
          }

          const output = await executeTool(fn.name, inputCode, groupId);
          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

          log(
            groupId,
            'tool-result',
            `Result: ${fn.name}`,
            outputStr.length > 500 ? outputStr.slice(0, 500) + '…' : outputStr,
          );
          post({
            type: 'tool-activity',
            payload: { groupId, tool: fn.name, status: 'done' },
          });

          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: fn.name,
            content: outputStr.slice(0, 100_000),
          });
        }
        post({ type: 'typing', payload: { groupId } });
      } else {
        const text = message.content || '(no response)';
        const cleaned = text
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        post({
          type: 'response',
          payload: { groupId, text: cleaned || '(no response)' },
        });
        return;
      }
    }

    post({
      type: 'response',
      payload: {
        groupId,
        text: '⚠️ Reached maximum tool-use iterations. Stopping to avoid infinite loops.',
      },
    });
  } catch (err: unknown) {
    post({
      type: 'error',
      payload: {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function invokeAnthropic(payload: InvokePayload): Promise<void> {
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
        cache_control: { type: 'ephemeral' },
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

      // Emit token usage
      if (result.usage) {
        post({
          type: 'token-usage',
          payload: {
            groupId,
            inputTokens: result.usage.input_tokens || 0,
            outputTokens: result.usage.output_tokens || 0,
            cacheReadTokens: result.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
            contextLimit: getContextLimit(model),
          },
        });
      }

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
// Context compaction — ask Claude to summarize the conversation
// ---------------------------------------------------------------------------

async function handleCompact(payload: CompactPayload): Promise<void> {
  if (payload.provider === 'ollama') {
    return compactOllama(payload);
  }
  return compactAnthropic(payload);
}

async function compactOllama(payload: CompactPayload): Promise<void> {
  const { groupId, messages, systemPrompt, ollamaUrl, model, maxTokens } = payload;
  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Compacting context', `Summarizing ${messages.length} messages`);

  try {
    const compactSystemPrompt = [
      systemPrompt,
      '',
      '## COMPACTION TASK',
      'Produce a concise summary of the conversation so far.',
      'The summary will replace the full conversation history to stay within token limits.',
    ].join('\n');

    const currentMessages: any[] = [{ role: 'system', content: compactSystemPrompt }];
    for (const m of messages) {
      currentMessages.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }
    currentMessages.push({
      role: 'user',
      content:
        'Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context.',
    });

    const res = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: currentMessages,
        max_tokens: Math.min(maxTokens, 4096),
      }),
    });

    if (!res.ok) throw new Error(`Ollama API error: ${await res.text()}`);

    const result = await res.json();
    const summary = result.choices[0]?.message?.content || '';

    log(groupId, 'info', 'Compaction complete', `Summary: ${summary.length} chars`);
    post({ type: 'compact-done', payload: { groupId, summary } });
  } catch (err: unknown) {
    post({
      type: 'error',
      payload: {
        groupId,
        error: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
}

async function compactAnthropic(payload: CompactPayload): Promise<void> {
  const { groupId, messages, systemPrompt, apiKey, model, maxTokens } = payload;

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Compacting context', `Summarizing ${messages.length} messages`);

  try {
    const compactSystemPrompt = [
      systemPrompt,
      '',
      '## COMPACTION TASK',
      '',
      'The conversation context is getting large. Produce a concise summary of the conversation so far.',
      'Include key facts, decisions, user preferences, and any important context.',
      'The summary will replace the full conversation history to stay within token limits.',
      'Be thorough but concise — aim for the essential information only.',
    ].join('\n');

    const compactMessages: ConversationMessage[] = [
      ...messages,
      {
        role: 'user' as const,
        content: 'Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context. This summary will replace the full history.',
      },
    ];

    const body = {
      model,
      max_tokens: Math.min(maxTokens, 4096),
      cache_control: { type: 'ephemeral' },
      system: compactSystemPrompt,
      messages: compactMessages,
    };

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
    const summary = result.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');

    log(groupId, 'info', 'Compaction complete', `Summary: ${summary.length} chars`);
    post({ type: 'compact-done', payload: { groupId, summary } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', payload: { groupId, error: `Compaction failed: ${message}` } });
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
        const rawText = await fetchRes.text();
        const contentType = fetchRes.headers.get('content-type') || '';
        const status = `[HTTP ${fetchRes.status}]\n`;

        // Strip HTML to reduce token usage
        let body = rawText;
        if (contentType.includes('html') || rawText.trimStart().startsWith('<')) {
          body = stripHtml(rawText);
        }

        return status + body.slice(0, FETCH_MAX_RESPONSE);
      }

      case 'update_memory':
        await writeGroupFile(groupId, 'CLAUDE.md', input.content as string);
        return 'Memory updated successfully.';

      case 'create_task': {
        // Post a dedicated message to the main thread to persist the task
        const taskData = {
          id: ulid(),
          groupId,
          schedule: input.schedule as string,
          prompt: input.prompt as string,
          enabled: true,
          lastRun: null,
          createdAt: Date.now(),
        };
        post({ type: 'task-created', payload: { task: taskData } });
        return `Task created successfully.\nSchedule: ${taskData.schedule}\nPrompt: ${taskData.prompt}`;
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

/**
 * Extract readable text from HTML, stripping tags, scripts, styles, and
 * collapsing whitespace.  Runs in the worker (no DOM), so we use regex.
 */
function stripHtml(html: string): string {
  let text = html;
  // Remove script/style/noscript blocks entirely
  text = text.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Remove all tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  return text;
}

/** Map model names to their context window limits (tokens). */
function getContextLimit(_model: string): number {
  // The actual session context window — 200k tokens for Claude Sonnet/Opus.
  return 200_000;
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
