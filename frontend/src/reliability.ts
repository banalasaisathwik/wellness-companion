export type AgentLogicMetrics = {
  turnHook?: number
  featureFinalization?: number
  jevClientSetup?: number
  jevClassification?: number
  stateParsing?: number
  stateUpdate?: number
  stateAnalysis?: number
  strategySelection?: number
}

export type TurnLatency = {
  responseLatency?: number
  responseSource?: 'native' | 'message_timestamps' | 'worker_state_fallback'
  finalTranscript?: number
  turnDetection?: number
  turnProcessing?: number
  llmFirstToken?: number
  llmRequestPreparation?: number
  llmPreRequestOverhead?: number
  llmMessageCount?: number
  llmPreviousMessageCount?: number
  llmInstructionChars?: number
  llmContextChars?: number
  llmCurrentUserChars?: number
  llmInputTokens?: number
  llmOutputTokens?: number
  llmFirstTokenSource?: 'native' | 'provider'
  firstSpeakableText?: number
  ttsFirstAudio?: number
  ttsFirstAudioSource?: 'native' | 'provider'
  audioOutputStart?: number
  agentLogicMetrics?: AgentLogicMetrics
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
    { label: 'Turn processing', seconds: latency.turnProcessing, hint: latency.agentLogicMetrics?.jevClassification !== undefined
      && latency.turnProcessing !== undefined && latency.agentLogicMetrics.jevClassification >= latency.turnProcessing * 0.7
      ? 'Check the state-analysis call before generation.' : 'Check work in the user-turn callback.' },
    { label: 'LLM first token', seconds: latency.llmFirstToken, hint: 'Model/provider startup is currently the largest measured response-stage delay.' },
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
  const previous = latencies.get(itemId)
  const merged = {
    ...previous, ...incoming,
    ...(incoming.agentLogicMetrics
      ? { agentLogicMetrics: { ...previous?.agentLogicMetrics, ...incoming.agentLogicMetrics } }
      : previous?.agentLogicMetrics ? { agentLogicMetrics: previous.agentLogicMetrics } : {}),
  }
  latencies.set(itemId, merged)
  if (completed && (!latestCompleted || sequence >= latestCompleted.sequence)) {
    return { latestCompleted: { itemId, sequence }, visibleLatency: merged }
  }
  return {
    latestCompleted,
    visibleLatency: latestCompleted?.itemId === itemId ? merged : null,
  }
}

export function readSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function formatMilliseconds(value: number | null) {
  return value === null ? '—' : value > 0 && value < 0.001 ? '<1 ms' : `${Math.round(value * 1000)} ms`
}

export function readTurnLatency(message: Record<string, unknown>): TurnLatency {
  const values: TurnLatency = {}
  for (const [source, target] of [
    ['response_latency_seconds', 'responseLatency'],
    ['final_transcript_seconds', 'finalTranscript'],
    ['turn_detection_seconds', 'turnDetection'],
    ['turn_processing_seconds', 'turnProcessing'],
    ['llm_request_preparation_seconds', 'llmRequestPreparation'],
    ['llm_pre_request_overhead_seconds', 'llmPreRequestOverhead'],
    ['llm_first_token_seconds', 'llmFirstToken'],
    ['first_speakable_text_seconds', 'firstSpeakableText'],
    ['tts_first_audio_seconds', 'ttsFirstAudio'],
    ['audio_output_start_seconds', 'audioOutputStart'],
  ] as const) {
    const value = readSeconds(message[source])
    if (value !== null) values[target] = value
  }
  for (const [source, target] of [
    ['llm_message_count', 'llmMessageCount'],
    ['llm_previous_message_count', 'llmPreviousMessageCount'],
    ['llm_instruction_chars', 'llmInstructionChars'],
    ['llm_context_chars', 'llmContextChars'],
    ['llm_current_user_chars', 'llmCurrentUserChars'],
    ['llm_input_tokens', 'llmInputTokens'],
    ['llm_output_tokens', 'llmOutputTokens'],
  ] as const) {
    const value = readSeconds(message[source])
    if (value !== null) values[target] = value
  }
  if (values.responseLatency !== undefined
    && (message.response_latency_source === 'native' || message.response_latency_source === 'message_timestamps' || message.response_latency_source === 'worker_state_fallback')) {
    values.responseSource = message.response_latency_source
  }
  if (message.llm_first_token_source === 'native' || message.llm_first_token_source === 'provider') {
    values.llmFirstTokenSource = message.llm_first_token_source
  }
  if (message.tts_first_audio_source === 'native' || message.tts_first_audio_source === 'provider') {
    values.ttsFirstAudioSource = message.tts_first_audio_source
  }
  if (Array.isArray(message.provider_request_ids)) {
    values.providerRequestIds = message.provider_request_ids.filter((value): value is string => typeof value === 'string').slice(0, 8)
  }
  return values
}

export function readAgentLogicMetrics(value: unknown): AgentLogicMetrics | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  const metrics: AgentLogicMetrics = {}
  for (const [source, target] of [
    ['turn_hook_seconds', 'turnHook'],
    ['feature_finalization_seconds', 'featureFinalization'],
    ['jev_client_setup_seconds', 'jevClientSetup'],
    ['jev_classification_seconds', 'jevClassification'],
    ['state_parsing_seconds', 'stateParsing'],
    ['state_update_seconds', 'stateUpdate'],
    ['state_analysis_seconds', 'stateAnalysis'],
    ['strategy_selection_seconds', 'strategySelection'],
  ] as const) {
    const seconds = readSeconds(message[source])
    if (seconds !== null) metrics[target] = seconds
  }
  return Object.keys(metrics).length ? metrics : null
}
