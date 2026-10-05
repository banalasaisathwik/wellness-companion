export type TurnLatency = {
  responseLatency?: number
  responseSource?: 'native' | 'worker_state_fallback'
  finalTranscript?: number
  turnDetection?: number
  turnProcessing?: number
  llmFirstToken?: number
  llmFirstTokenSource?: 'native' | 'provider'
  firstSpeakableText?: number
  ttsFirstAudio?: number
  ttsFirstAudioSource?: 'native' | 'provider'
  audioOutputStart?: number
  stateAnalysis?: number
  strategySelection?: number
  providerRequestIds?: string[]
}

export type CompletedTurn = {
  itemId: string
  speechId: string
  userItemId?: string
  sequence: number
  latency: TurnLatency
  additionalUpdates?: number
}

export function updateRecentTurns(turns: CompletedTurn[], incoming: CompletedTurn): CompletedTurn[] {
  const previous = turns.find((turn) => turn.itemId === incoming.itemId)
  return [
    ...turns.filter((turn) => turn.itemId !== incoming.itemId),
    {
      ...incoming,
      userItemId: incoming.userItemId ?? previous?.userItemId,
      additionalUpdates: (previous?.additionalUpdates ?? 0) + (previous ? 1 : 0),
    },
  ].sort((first, second) => second.sequence - first.sequence).slice(0, 5)
}

export function slowestStage(latency: TurnLatency): { label: string; seconds: number; hint: string } | null {
  const stages = [
    { label: 'Turn detection', seconds: latency.turnDetection, hint: latency.finalTranscript !== undefined
      && latency.turnDetection !== undefined && latency.finalTranscript >= latency.turnDetection * 0.7
      ? 'Check STT finalization and turn detection.' : 'Check endpointing and turn-detection settings.' },
    { label: 'Turn processing', seconds: latency.turnProcessing, hint: latency.stateAnalysis !== undefined
      && latency.turnProcessing !== undefined && latency.stateAnalysis >= latency.turnProcessing * 0.7
      ? 'Check the state-analysis call before generation.' : 'Check work in the user-turn callback.' },
    { label: 'LLM first token', seconds: latency.llmFirstToken, hint: 'Check model/provider first-token time and prompt size.' },
    { label: 'TTS first audio', seconds: latency.ttsFirstAudio, hint: 'Check the TTS provider/model and streaming configuration.' },
  ]
  const available = stages.filter((stage): stage is { label: string; seconds: number; hint: string } => stage.seconds !== undefined)
  return available.length ? available.reduce((slowest, stage) => stage.seconds > slowest.seconds ? stage : slowest) : null
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
