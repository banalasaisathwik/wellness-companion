import type { ConversationState } from './voice/types'

export type ConversationMessage = {
  id: string
  itemId?: string
  role: 'user' | 'assistant'
  text: string
  final: boolean
  interrupted?: boolean
  segments?: { id: string; text: string; final: boolean }[]
}

export function updateTranscript(
  messages: ConversationMessage[],
  messageId: string,
  role: ConversationMessage['role'],
  segment: { id: string; text: string; final: boolean },
): ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === messageId && message.role === role)
  if (index < 0) {
    return [...messages, {
      id: messageId, role, text: segment.text, final: segment.final, segments: [segment],
    }]
  }

  const message = messages[index]
  if ((message.itemId && (role === 'assistant' || !segment.final))
    || message.segments?.some((part) => part.id === segment.id && part.final)) return messages
  const segments = message.segments?.some((part) => part.id === segment.id)
    ? message.segments.map((part) => part.id === segment.id ? segment : part)
    : [...(message.segments ?? []), segment]
  const updated = {
    ...message,
    segments,
    text: segments.map((part) => part.text).filter(Boolean).join(' ').trim(),
    final: Boolean(message.itemId) || segments.every((part) => part.final),
  }
  return messages.map((item, position) => position === index ? updated : item)
}

export function readConversationState(value: unknown): ConversationState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Record<string, unknown>
  const allowed: Record<keyof ConversationState, string[]> = {
    energy: ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'],
    stress: ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'],
    frustration: ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'],
    sentiment: ['NEGATIVE', 'NEUTRAL', 'POSITIVE', 'UNKNOWN'],
  }
  if ((Object.keys(allowed) as (keyof ConversationState)[]).some((key) => !allowed[key].includes(state[key] as string))) return null
  return state as ConversationState
}
