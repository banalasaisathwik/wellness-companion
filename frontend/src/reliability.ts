export type TurnLatency = {
  llmFirstToken?: number
  llmDuration?: number
  ttsFirstAudio?: number
  ttsDuration?: number
  speechEndToAgentAudio?: number
}

export type AssistantItem = {
  itemId: string
  speechId: string
  sequence: number
  text: string
  interrupted: boolean
}

export function belongsToSession(messageSessionId: unknown, roomName: string): boolean {
  return typeof messageSessionId === 'string' && messageSessionId === roomName
}

export function selectAssistantItem(
  current: AssistantItem | null,
  incoming: AssistantItem,
  latestSpeechSequence: number,
): AssistantItem | null {
  // A late item cannot become the visible answer after a newer speech exists.
  if (incoming.sequence < latestSpeechSequence || (current && incoming.sequence < current.sequence)) return current
  if (current?.speechId === incoming.speechId && current.interrupted) return current
  return incoming
}

export function mergeTurnMetrics(
  latencies: Map<string, TurnLatency>,
  latestCompleted: { itemId: string; sequence: number } | null,
  itemId: string,
  sequence: number,
  completed: boolean,
  incoming: TurnLatency,
) {
  const merged = { ...latencies.get(itemId), ...incoming }
  latencies.set(itemId, merged)
  if (completed && (!latestCompleted || sequence >= latestCompleted.sequence)) {
    return { latestCompleted: { itemId, sequence }, visibleLatency: merged }
  }
  return {
    latestCompleted,
    visibleLatency: latestCompleted?.itemId === itemId ? merged : null,
  }
}
