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


interface AIProvider {
  buildMessages(systemPrompt: string, messages: ConversationMessage[], isCompact: boolean): any[];
  callCompletion(payload: InvokePayload | CompactPayload, currentMessages: any[], maxTokens: number, useTools: boolean, systemPrompt: string): Promise<any>;
  extractTokenUsage(result: any, payload: InvokePayload | CompactPayload): Promise<TokenUsage | null>;
  extractTextBlocks(result: any): string[];
  extractToolCalls(result: any): any[];
  appendAssistantMessage(currentMessages: any[], result: any): void;
  formatToolCall(tc: any): { id: string; name: string; input: Record<string, unknown> };
  appendToolResults(currentMessages: any[], results: { tc: any; outputStr: string }[]): void;
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

const anthropicProvider: AIProvider = {
  buildMessages(systemPrompt, messages, isCompact) {
    if (isCompact) {
      return [
        ...messages,
        {
          role: 'user',
          content: 'Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context. This summary will replace the full history.',
        },
      ];
    }
    return [...messages];
  },
  async callCompletion(payload, currentMessages, maxTokens, useTools, systemPrompt) {
    if (payload.provider !== 'anthropic') throw new Error('Wrong provider config');
    const body = {
      model: payload.model,
      max_tokens: maxTokens,
      cache_control: { type: 'ephemeral' },
      system: systemPrompt,
      messages: currentMessages,
      ...(useTools ? { tools: TOOL_DEFINITIONS } : {}),
    };
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': payload.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async extractTokenUsage(result, payload) {
    if (!result.usage) return null;
    return {
      groupId: payload.groupId,
      inputTokens: result.usage.input_tokens || 0,
      outputTokens: result.usage.output_tokens || 0,
      cacheReadTokens: result.usage.cache_read_input_tokens || 0,
      cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
      contextLimit: getContextLimit(payload.model),
    };
  },
  extractTextBlocks(result) {
    if (!result.content) return [];
    return result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
  },
  extractToolCalls(result) {
    if (result.stop_reason !== 'tool_use' || !result.content) return [];
    return result.content.filter((b: any) => b.type === 'tool_use');
  },
  appendAssistantMessage(currentMessages, result) {
    currentMessages.push({ role: 'assistant', content: result.content });
  },
  formatToolCall(tc) {
    return { id: tc.id, name: tc.name, input: tc.input };
  },
  appendToolResults(currentMessages, results) {
    const toolResults = results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.tc.id,
      content: r.outputStr.slice(0, 100_000),
    }));
    currentMessages.push({ role: 'user', content: toolResults as any });
  },
};

const ollamaProvider: AIProvider = {
  buildMessages(systemPrompt, messages, isCompact) {
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
    if (isCompact) {
      currentMessages.push({
        role: 'user',
        content: 'Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context.',
      });
    }
    return currentMessages;
  },
  async callCompletion(payload, currentMessages, maxTokens, useTools) {
    if (payload.provider !== 'ollama') throw new Error('Wrong provider config');
    const body = {
      model: payload.model,
      messages: currentMessages,
      max_tokens: maxTokens,
      ...(useTools ? { tools: getOpenAITools() } : {}),
    };
    const res = await fetch(`${payload.ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async extractTokenUsage(result, payload) {
    if (!result.usage) return null;
    let contextLimit = 8192; // Conservative fallback

    try {
      if (payload.provider === 'ollama') {
        const res = await fetch(`${payload.ollamaUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: payload.model }),
        });
        if (res.ok) {
          const data = await res.json();
          // Extract context length from model info (often under num_ctx)
          const numCtx = data.model_info?.['ollama.num_ctx'] || data.model_info?.['llama.context_length'] || data.details?.num_ctx;
          if (numCtx && !isNaN(Number(numCtx))) {
            contextLimit = Number(numCtx);
          } else {
            // common fallbacks
            if (payload.model.toLowerCase().includes('llama3')) contextLimit = 128000;
            else if (payload.model.toLowerCase().includes('mistral') || payload.model.toLowerCase().includes('mixtral')) contextLimit = 32000;
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch ollama context limit', err);
    }

    return {
      groupId: payload.groupId,
      inputTokens: result.usage.prompt_tokens || 0,
      outputTokens: result.usage.completion_tokens || 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextLimit,
    };
  },
  extractTextBlocks(result) {
    const content = result.choices?.[0]?.message?.content;
    return content ? [content] : [];
  },
  extractToolCalls(result) {
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== 'tool_calls') return [];
    return choice?.message?.tool_calls || [];
  },
  appendAssistantMessage(currentMessages, result) {
    const message = result.choices?.[0]?.message;
    if (message) currentMessages.push(message);
  },
  formatToolCall(tc) {
    const fn = tc.function;
    let input = {};
    try {
      input = JSON.parse(fn.arguments || '{}');
    } catch {}
    return { id: tc.id, name: fn.name, input };
  },
  appendToolResults(currentMessages, results) {
    for (const r of results) {
      currentMessages.push({
        role: 'tool',
        tool_call_id: r.tc.id,
        name: r.tc.function.name,
        content: r.outputStr.slice(0, 100_000),
      });
    }
  },
};

function getProvider(payload: InvokePayload | CompactPayload): AIProvider {
  return payload.provider === 'ollama' ? ollamaProvider : anthropicProvider;
}

async function handleInvoke(payload: InvokePayload): Promise<void> {
  const { groupId, messages, systemPrompt, model, maxTokens } = payload;
  const provider = getProvider(payload);

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', `Starting (${payload.provider})`, `Model: ${model} · Max tokens: ${maxTokens}`);

  try {
    const currentMessages = provider.buildMessages(systemPrompt, messages, false);
    let iterations = 0;
    const maxIterations = 25;

    while (iterations < maxIterations) {
      iterations++;

      log(groupId, 'api-call', `API call #${iterations}`, `${currentMessages.length} messages in context`);

      const res = await provider.callCompletion(payload, currentMessages, maxTokens, true, systemPrompt);

      const usage = await provider.extractTokenUsage(res, payload);
      if (usage) post({ type: 'token-usage', payload: usage });

      const texts = provider.extractTextBlocks(res);
      for (const text of texts) {
        if (text) {
          const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
          log(groupId, 'text', 'Response text', preview);
        }
      }

      const toolCalls = provider.extractToolCalls(res);
      if (toolCalls.length > 0) {
        provider.appendAssistantMessage(currentMessages, res);

        const results = [];
        for (const tc of toolCalls) {
          const { id, name, input } = provider.formatToolCall(tc);
          
          const inputPreview = JSON.stringify(input);
          const inputShort = inputPreview.length > 300 ? inputPreview.slice(0, 300) + '…' : inputPreview;
          log(groupId, 'tool-call', `Tool: ${name}`, inputShort);

          post({ type: 'tool-activity', payload: { groupId, tool: name, status: 'running' } });

          const output = await executeTool(name, input, groupId);

          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          const outputShort = outputStr.length > 500 ? outputStr.slice(0, 500) + '…' : outputStr;
          log(groupId, 'tool-result', `Result: ${name}`, outputShort);

          post({ type: 'tool-activity', payload: { groupId, tool: name, status: 'done' } });

          results.push({ tc, outputStr });
        }

        provider.appendToolResults(currentMessages, results);
        post({ type: 'typing', payload: { groupId } });
      } else {
        const text = texts.join('');
        const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        post({ type: 'response', payload: { groupId, text: cleaned || '(no response)' } });
        return;
      }
    }

    post({
      type: 'response',
      payload: { groupId, text: '⚠️ Reached maximum tool-use iterations (25). Stopping to avoid excessive API usage.' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', payload: { groupId, error: message } });
  }
}

// ---------------------------------------------------------------------------
// Context compaction — ask Claude/Ollama to summarize the conversation
// ---------------------------------------------------------------------------

async function handleCompact(payload: CompactPayload): Promise<void> {
  const { groupId, messages, systemPrompt, model, maxTokens } = payload;
  const provider = getProvider(payload);

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', `Compacting context (${payload.provider})`, `Summarizing ${messages.length} messages`);

  try {
    const compactSystemPrompt = [
      systemPrompt,
      '',
      '## COMPACTION TASK',
      'The conversation context is getting large. Produce a concise summary of the conversation so far.',
      'Include key facts, decisions, user preferences, and any important context.',
      'The summary will replace the full conversation history to stay within token limits.',
      'Be thorough but concise — aim for the essential information only.',
    ].join('\n');

    const currentMessages = provider.buildMessages(compactSystemPrompt, messages, true);

    const res = await provider.callCompletion(payload, currentMessages, Math.min(maxTokens, 4096), false, compactSystemPrompt);

    const texts = provider.extractTextBlocks(res);
    const summary = texts.join('');

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
