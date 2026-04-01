import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { safeParseJSON } from 'src/utils/json.js'
import { createAssistantMessage } from 'src/utils/messages.js'
import type { Tool, Tools } from 'src/Tool.js'
import type { SystemPrompt } from 'src/utils/systemPromptType.js'
import { toolToAPISchema } from 'src/utils/api.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { AgentId } from 'src/types/ids.js'
import { getOpenAICompatConfigOrThrow } from './providerConfig.js'

type OpenAICompatChatMessage =
  | {
      role: 'system' | 'user' | 'assistant'
      content: string
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAICompatTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

function systemPromptToString(systemPrompt: SystemPrompt): string {
  return [...systemPrompt].join('\n\n').trim()
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function normalizeOpenAICompatMessages({
  messages,
  systemPrompt,
}: {
  // Using `unknown` to avoid importing the missing src/types/message.js runtime module.
  // Runtime objects still follow the expected shape.
  messages: unknown[]
  systemPrompt: SystemPrompt
}): OpenAICompatChatMessage[] {
  const out: OpenAICompatChatMessage[] = []
  const sys = systemPromptToString(systemPrompt)
  if (sys) out.push({ role: 'system', content: sys })

  for (const m of messages as any[]) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'user') {
      const content = m.message?.content
      if (typeof content === 'string') {
        out.push({ role: 'user', content })
        continue
      }
      if (Array.isArray(content)) {
        // Split tool_results into tool-role messages; everything else becomes text.
        const textParts: string[] = []
        for (const block of content) {
          if (block?.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: String(block.tool_use_id ?? ''),
              content: stringifyToolResultContent(block.content),
            })
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text)
          } else if (typeof block?.type === 'string') {
            // Best-effort fallback for non-text blocks (images, etc.)
            textParts.push(`[${block.type}]`)
          }
        }
        if (textParts.length > 0) {
          out.push({ role: 'user', content: textParts.join('') })
        }
      }
      continue
    }

    if (m.type === 'assistant') {
      const blocks = m.message?.content
      if (typeof blocks === 'string') {
        out.push({ role: 'assistant', content: blocks })
        continue
      }
      if (Array.isArray(blocks)) {
        const textParts: string[] = []
        const toolCalls: OpenAICompatChatMessage['tool_calls'] = []
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text)
          } else if (block?.type === 'tool_use') {
            const args = JSON.stringify(block.input ?? {})
            toolCalls.push({
              id: String(block.id ?? ''),
              type: 'function',
              function: { name: String(block.name ?? ''), arguments: args },
            })
          }
        }
        out.push({
          role: 'assistant',
          content: textParts.join(''),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
      }
    }
  }
  return out
}

async function toolsToOpenAICompatTools({
  tools,
  model,
  getToolPermissionContext,
  agents,
  allowedAgentTypes,
}: {
  tools: Tools
  model: string
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
}): Promise<OpenAICompatTool[]> {
  const out: OpenAICompatTool[] = []
  for (const tool of tools) {
    const schema = await toolToAPISchema(tool as Tool, {
      tools,
      agents,
      allowedAgentTypes,
      getToolPermissionContext,
      model,
    })
    out.push({
      type: 'function',
      function: {
        name: schema.name,
        description: schema.description,
        parameters: schema.input_schema as unknown as Record<string, unknown>,
      },
    })
  }
  return out
}

function openaiUsageToAnthropicUsage(usage: any) {
  const input = Number(usage?.prompt_tokens ?? 0)
  const output = Number(usage?.completion_tokens ?? 0)
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: null,
    iterations: null,
    speed: null,
  }
}

export async function queryOpenAICompatOnce({
  messages,
  systemPrompt,
  tools,
  model,
  toolChoice,
  temperature,
  maxTokens,
  signal,
  getToolPermissionContext,
  agents,
  allowedAgentTypes,
  agentId,
}: {
  messages: unknown[]
  systemPrompt: SystemPrompt
  tools: Tools
  model: string
  toolChoice?: { name?: string } | 'auto' | 'none'
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  agentId?: AgentId
}) {
  const { baseUrl, apiKey, extraHeaders } = getOpenAICompatConfigOrThrow()

  const openaiMessages = normalizeOpenAICompatMessages({ messages, systemPrompt })
  const openaiTools = await toolsToOpenAICompatTools({
    tools,
    model,
    getToolPermissionContext,
    agents,
    allowedAgentTypes,
  })

  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    stream: false,
    ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
  }
  if (toolChoice && toolChoice !== 'auto') {
    if (toolChoice === 'none') body.tool_choice = 'none'
    else if (toolChoice.name) {
      body.tool_choice = {
        type: 'function',
        function: { name: toolChoice.name },
      }
    }
  }
  if (temperature !== undefined) body.temperature = temperature
  if (maxTokens !== undefined) body.max_tokens = maxTokens

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
    ...getProxyFetchOptions(),
  } as any)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `OpenAI-compatible request failed (${res.status}): ${text.slice(0, 500)}`,
    )
  }

  const data = (await res.json()) as any
  const choice = data?.choices?.[0]?.message
  const contentText = typeof choice?.content === 'string' ? choice.content : ''
  const toolCalls = Array.isArray(choice?.tool_calls) ? choice.tool_calls : []

  const blocks: any[] = []
  if (contentText) blocks.push({ type: 'text', text: contentText })

  for (const tc of toolCalls) {
    const id = String(tc?.id ?? '')
    const name = String(tc?.function?.name ?? '')
    const argsStr = String(tc?.function?.arguments ?? '')
    const parsed = safeParseJSON(argsStr, false)
    const input =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { __unparsed_arguments: argsStr }
    blocks.push({ type: 'tool_use', id, name, input })
  }

  const assistant = createAssistantMessage({
    content: blocks.length > 0 ? (blocks as any) : '',
    usage: openaiUsageToAnthropicUsage(data?.usage),
  })

  // Help downstream tooling correlate tool calls in subagents (optional).
  if (agentId) {
    ;(assistant as any).agentId = agentId
  }

  return assistant
}

