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
