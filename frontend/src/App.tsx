import { useEffect, useRef, useState } from 'react'
import {
  ConnectionState,
  createAudioAnalyser,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from 'livekit-client'
import { belongsToSession, mergeTurnMetrics, selectAssistantItem, type AssistantItem, type TurnLatency } from './reliability'
import './App.css'

type Transcript = { id: string; text: string }
type TimelineEvent = {
  id: number
  type: string
  timestamp: string
  sessionElapsedSeconds: number | null
  message: string
  details?: string
}
type AudioPlaybackState = {
  status: string
  error: string
}
type CurrentTurnDiagnostics = {
  speechSpan: number | null
  speechEndToTurnDecision: number | null
  speechEndToFinalTranscript: number | null
  turnCommitToAgentThinking: number | null
}
type TurnConfiguration = {
  vad: string
  vadMinSilence: number | null
  turnDetection: string
  turnDetectionModel: string
  endpointingMode: string
  endpointingModeSource: string
  minEndpointingDelay: number | null
  minEndpointingDelaySource: string
  maxEndpointingDelay: number | null
  maxEndpointingDelaySource: string
  preemptiveGenerationEnabled: boolean
}
type LatestProviderMetric = {
  metricType: string
  speechId: string | null
  values: string
}
type InterruptionDiagnostics = {
  overlap: string
  detectionDelay: number | null
  predictionDuration: number | null
  totalDuration: number | null
  probability: number | null
  requestCount: number | null
  assistantResponse: string
  falseInterruptionResumed: string
  userSpeechToAgentStopped: number | null
}
const emptyInterruptionDiagnostics: InterruptionDiagnostics = {
  overlap: 'Unavailable',
  detectionDelay: null,
  predictionDuration: null,
  totalDuration: null,
  probability: null,
  requestCount: null,
  assistantResponse: 'Unavailable',
  falseInterruptionResumed: 'Unavailable',
  userSpeechToAgentStopped: null,
}

function isDiagnostic(message: unknown): message is Record<string, unknown> & { type: string } {
  return typeof message === 'object' && message !== null && typeof (message as Record<string, unknown>).type === 'string'
}

function formatMilliseconds(value: number | null) {
  return value === null ? '—' : `${(value * 1000).toFixed(0)} ms`
}

function readNonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function formatClockTimestamp(date: Date) {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`
}

function readTurnConfiguration(value: unknown): TurnConfiguration | null {
  if (typeof value !== 'object' || value === null) return null
  const configuration = value as Record<string, unknown>
  if (
    typeof configuration.vad !== 'string'
    || typeof configuration.turn_detection !== 'string'
    || typeof configuration.turn_detection_model !== 'string'
    || typeof configuration.endpointing_mode !== 'string'
    || typeof configuration.preemptive_generation_enabled !== 'boolean'
  ) return null

  return {
    vad: configuration.vad,
    vadMinSilence: readNonNegativeNumber(configuration.vad_min_silence_seconds),
    turnDetection: configuration.turn_detection,
    turnDetectionModel: configuration.turn_detection_model,
    endpointingMode: configuration.endpointing_mode,
    endpointingModeSource: typeof configuration.endpointing_mode_source === 'string' ? configuration.endpointing_mode_source : 'unknown',
    minEndpointingDelay: readNonNegativeNumber(configuration.min_endpointing_delay_seconds),
    minEndpointingDelaySource: typeof configuration.min_endpointing_delay_source === 'string' ? configuration.min_endpointing_delay_source : 'unknown',
    maxEndpointingDelay: readNonNegativeNumber(configuration.max_endpointing_delay_seconds),
    maxEndpointingDelaySource: typeof configuration.max_endpointing_delay_source === 'string' ? configuration.max_endpointing_delay_source : 'unknown',
    preemptiveGenerationEnabled: configuration.preemptive_generation_enabled,
  }
}

function readTurnLatency(message: Record<string, unknown>): TurnLatency | null {
  const latency: TurnLatency = {}
  const fields = [
    ['llm_first_token_seconds', 'llmFirstToken'],
    ['llm_duration_seconds', 'llmDuration'],
    ['tts_first_audio_seconds', 'ttsFirstAudio'],
    ['tts_duration_seconds', 'ttsDuration'],
    ['speech_end_to_agent_audio_seconds', 'speechEndToAgentAudio'],
  ] as const

  for (const [source, target] of fields) {
    const value = readNonNegativeNumber(message[source])
    if (value !== null) latency[target] = value
  }
  return Object.keys(latency).length ? latency : null
}

function readLatestProviderMetric(message: Record<string, unknown>): LatestProviderMetric | null {
  if (typeof message.metric_type !== 'string') return null
  const values = [
    ['llm_duration_seconds', 'LLM duration'],
    ['tts_duration_seconds', 'TTS duration'],
    ['llm_first_token_seconds', 'LLM first token'],
    ['tts_first_audio_seconds', 'TTS first audio'],
  ]
    .flatMap(([key, label]) => {
      const value = readNonNegativeNumber(message[key])
      return value === null ? [] : [`${label} ${formatMilliseconds(value)}`]
    })
  if (!values.length) return null
  return {
    metricType: message.metric_type,
    speechId: typeof message.speech_id === 'string' ? message.speech_id : null,
    values: values.join(', '),
  }
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('No session created')
  const [serverUrl, setServerUrl] = useState('')
  const [token, setToken] = useState('')
  const [roomName, setRoomName] = useState('')
  const [participantIdentity, setParticipantIdentity] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Disconnected')
  const [connectionError, setConnectionError] = useState('')
  const [microphoneStatus, setMicrophoneStatus] = useState('Microphone off')
  const [microphoneError, setMicrophoneError] = useState('')
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0)
  const [partialTranscript, setPartialTranscript] = useState('')
  const [finalTranscripts, setFinalTranscripts] = useState<Transcript[]>([])
  const [agentResponse, setAgentResponse] = useState('')
  const [agentSpeechText, setAgentSpeechText] = useState('')
  const [userActivity, setUserActivity] = useState('Waiting for session')
  const [agentActivity, setAgentActivity] = useState('Waiting for session')
  const [llmModel, setLlmModel] = useState('Unavailable')
  const [turnLatency, setTurnLatency] = useState<TurnLatency | null>(null)
  const [activeSpeechId, setActiveSpeechId] = useState<string | null>(null)
  const [interruptedResponseCount, setInterruptedResponseCount] = useState(0)
  const [latestProviderMetric, setLatestProviderMetric] = useState<LatestProviderMetric | null>(null)
  const [currentTurnDiagnostics, setCurrentTurnDiagnostics] = useState<CurrentTurnDiagnostics>({
    speechSpan: null,
    speechEndToTurnDecision: null,
    speechEndToFinalTranscript: null,
    turnCommitToAgentThinking: null,
  })
  const [turnConfiguration, setTurnConfiguration] = useState<TurnConfiguration | null>(null)
  const [interruptionMode, setInterruptionMode] = useState('Unavailable')
  const [interruptionDiagnostics, setInterruptionDiagnostics] = useState<InterruptionDiagnostics>(emptyInterruptionDiagnostics)
  const [usage, setUsage] = useState('Unavailable')
  const [audioPlayback, setAudioPlayback] = useState<AudioPlaybackState>({
    status: 'Remote audio track unavailable',
    error: '',
  })
  const [microphoneLevel, setMicrophoneLevel] = useState<number | null>(null)
  const [diagnosticTimeline, setDiagnosticTimeline] = useState<TimelineEvent[]>([])
  const [sessionDiagnosticError, setSessionDiagnosticError] = useState('')
  const roomRef = useRef<Room | null>(null)
  const connectionAttemptRef = useRef<Room | null>(null)
  const microphoneRequestRoomRef = useRef<Room | null>(null)
  const audioContainerRef = useRef<HTMLDivElement | null>(null)
  const remoteAudioElementsRef = useRef(new Map<string, HTMLMediaElement>())
  const audioPlaybackErrorRef = useRef('')
  const finalTranscriptIdsRef = useRef(new Set<string>())
  const completedTurnLatenciesRef = useRef(new Map<string, TurnLatency>())
  const latestCompletedTurnRef = useRef<{ itemId: string; sequence: number } | null>(null)
  const latestSpeechSequenceRef = useRef(0)
  const latestAssistantItemRef = useRef<AssistantItem | null>(null)
  const finishedSpeechIdsRef = useRef(new Set<string>())
  const interruptedItemIdsRef = useRef(new Set<string>())
  const timelineIdRef = useRef(0)
  const microphoneAnalyserTimerRef = useRef<number | null>(null)
  const microphoneAnalyserRef = useRef<ReturnType<typeof createAudioAnalyser> | null>(null)
  const roomEventHandlersRef = useRef<{
    connectionStateChanged: (state: ConnectionState) => void
    participantChanged: () => void
    microphonePublicationChanged: () => void
    trackSubscribed: (track: RemoteTrack, publication: RemoteTrackPublication) => void
    trackUnsubscribed: (track: RemoteTrack) => void
    transcriptionReceived: (segments: TranscriptionSegment[], participant?: Participant) => void
    audioPlaybackStatusChanged: (playing: boolean) => void
    dataReceived: (payload: Uint8Array, participant?: unknown, kind?: unknown, topic?: string) => void
  } | null>(null)

  const hasSessionConnectionDetails = Boolean(serverUrl && token)
  const roomIsActive = ['Connecting', 'Connected', 'Reconnecting'].includes(connectionStatus)

  function sanitizeConnectionErrorMessage(message: string) {
    return message
      .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[redacted URL]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b((?:token|api[ _-]?secret)\s*[=:]\s*)\S+/gi, '$1[redacted]')
  }

  function addDiagnosticTimelineEvent(type: string, message: string, diagnostic: Record<string, unknown>, details?: string) {
    const event: TimelineEvent = {
      id: timelineIdRef.current,
      type,
      timestamp: formatClockTimestamp(new Date()),
      sessionElapsedSeconds: readNonNegativeNumber(diagnostic.session_elapsed_seconds),
      message,
      details,
    }
    timelineIdRef.current += 1
    setDiagnosticTimeline((events) => [...events.slice(-29), event])
  }

  function resetConversationState() {
    finalTranscriptIdsRef.current.clear()
    timelineIdRef.current = 0
    setPartialTranscript('')
    setFinalTranscripts([])
    setAgentResponse('')
    setAgentSpeechText('')
    setUserActivity('Waiting for session')
    setAgentActivity('Waiting for session')
    setLlmModel('Unavailable')
    setTurnLatency(null)
    setActiveSpeechId(null)
    setInterruptedResponseCount(0)
    setLatestProviderMetric(null)
    setCurrentTurnDiagnostics({
      speechSpan: null,
      speechEndToTurnDecision: null,
      speechEndToFinalTranscript: null,
      turnCommitToAgentThinking: null,
    })
    setTurnConfiguration(null)
    setInterruptionMode('Unavailable')
    setInterruptionDiagnostics(emptyInterruptionDiagnostics)
    setUsage('Unavailable')
    setAudioPlayback({
      status: 'Remote audio track unavailable',
      error: '',
    })
    audioPlaybackErrorRef.current = ''
    completedTurnLatenciesRef.current.clear()
    latestCompletedTurnRef.current = null
    latestSpeechSequenceRef.current = 0
    latestAssistantItemRef.current = null
    finishedSpeechIdsRef.current.clear()
    interruptedItemIdsRef.current.clear()
    setDiagnosticTimeline([])
    setSessionDiagnosticError('')
    setMicrophoneLevel(null)
  }

  function stopMicrophoneAnalyser() {
    if (microphoneAnalyserTimerRef.current !== null) {
      window.clearInterval(microphoneAnalyserTimerRef.current)
      microphoneAnalyserTimerRef.current = null
    }
    const microphoneAnalyser = microphoneAnalyserRef.current
    microphoneAnalyserRef.current = null
    if (microphoneAnalyser) void microphoneAnalyser.cleanup().catch(() => undefined)
    setMicrophoneLevel(null)
  }

  function startMicrophoneAnalyser(room: Room) {
    stopMicrophoneAnalyser()
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (!track) return

    try {
      const microphoneAnalyser = createAudioAnalyser(track, {
        fftSize: 2048,
        smoothingTimeConstant: 0.2,
        minDecibels: -100,
        maxDecibels: -30,
      })
      microphoneAnalyserRef.current = microphoneAnalyser
      const audioContext = microphoneAnalyser.analyser.context
      if (audioContext instanceof AudioContext) void audioContext.resume().catch(() => undefined)
      microphoneAnalyserTimerRef.current = window.setInterval(() => {
        if (roomRef.current !== room || microphoneAnalyserRef.current !== microphoneAnalyser) return
        setMicrophoneLevel(microphoneAnalyser.calculateVolume())
      }, 250)
    } catch {
      microphoneAnalyserRef.current = null
    }
  }

  function updateAudioPlayback(room: Room) {
    const elements = [...remoteAudioElementsRef.current.values()]
    let status = 'Remote audio track unavailable'
    if (elements.length > 0 && audioPlaybackErrorRef.current) {
      status = 'Playback blocked'
    } else if (elements.some((element) => !element.paused)) {
      status = 'Playback enabled'
    } else if (elements.length > 0) {
      status = room.canPlaybackAudio ? 'Audio attached' : 'Enable audio playback'
    }

    setAudioPlayback({
      status,
      error: audioPlaybackErrorRef.current,
    })
  }

  function removeRemoteAudio(room: Room, trackSid: string) {
    const element = remoteAudioElementsRef.current.get(trackSid)
    if (!element) return
    element.remove()
    remoteAudioElementsRef.current.delete(trackSid)
    updateAudioPlayback(room)
  }

  function removeAllRemoteAudio() {
    for (const element of remoteAudioElementsRef.current.values()) element.remove()
    remoteAudioElementsRef.current.clear()
  }

  function attachRemoteAudio(room: Room, track: RemoteTrack) {
    const trackSid = track.sid
    if (track.kind !== Track.Kind.Audio || !trackSid || remoteAudioElementsRef.current.has(trackSid)) return
    const element = document.createElement('audio')
    element.autoplay = true
    element.muted = false
    element.volume = 1
    element.dataset.trackSid = trackSid
    remoteAudioElementsRef.current.set(trackSid, element)
    element.addEventListener('playing', () => {
      audioPlaybackErrorRef.current = ''
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('pause', () => {
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('error', () => {
      audioPlaybackErrorRef.current = element.error?.message || 'The audio element reported a playback error.'
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    audioContainerRef.current?.append(element)
    track.attach(element)
    updateAudioPlayback(room)
  }

  function removeRoomEventListeners(room: Room) {
    const handlers = roomEventHandlersRef.current
    if (!handlers) return
    room.off(RoomEvent.ConnectionStateChanged, handlers.connectionStateChanged)
    room.off(RoomEvent.ParticipantConnected, handlers.participantChanged)
    room.off(RoomEvent.ParticipantDisconnected, handlers.participantChanged)
    room.off(RoomEvent.TrackMuted, handlers.microphonePublicationChanged)
    room.off(RoomEvent.TrackUnmuted, handlers.microphonePublicationChanged)
    room.off(RoomEvent.LocalTrackPublished, handlers.microphonePublicationChanged)
    room.off(RoomEvent.LocalTrackUnpublished, handlers.microphonePublicationChanged)
    room.off(RoomEvent.TrackSubscribed, handlers.trackSubscribed)
    room.off(RoomEvent.TrackUnsubscribed, handlers.trackUnsubscribed)
    room.off(RoomEvent.TranscriptionReceived, handlers.transcriptionReceived)
    room.off(RoomEvent.AudioPlaybackStatusChanged, handlers.audioPlaybackStatusChanged)
    room.off(RoomEvent.DataReceived, handlers.dataReceived)
    roomEventHandlersRef.current = null
  }

  function syncMicrophoneState(room: Room) {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (!publication?.track) {
      stopMicrophoneAnalyser()
      setMicrophoneStatus('Microphone off')
      setMicrophoneError('')
      return
    }
    setMicrophoneStatus(publication.isMuted ? 'Muted' : 'Publishing microphone')
    setMicrophoneError('')
    if (!microphoneAnalyserRef.current) startMicrophoneAnalyser(room)
  }

  function formatMicrophoneError(error: unknown) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied.'
    if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone device was found.'
    return error instanceof Error ? error.message : 'The microphone could not be enabled.'
  }

  useEffect(() => {
    const abortController = new AbortController()
    async function checkBackend() {
      setBackendStatus('Checking backend...')
      try {
        const response = await fetch('/api/health', { signal: abortController.signal })
        const health = (await response.json()) as { status?: string }
        setBackendStatus(response.ok && health.status === 'ok' ? 'Backend connected' : 'Backend unavailable')
      } catch {
        if (!abortController.signal.aborted) setBackendStatus('Backend unavailable')
      }
    }
    void checkBackend()
    return () => abortController.abort()
  }, [retryAttempt])

  useEffect(() => () => {
    const room = roomRef.current
    if (room) removeRoomEventListeners(room)
    removeAllRemoteAudio()
    stopMicrophoneAnalyser()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    if (room) void room.disconnect()
  }, [])

  async function createSession() {
    setSessionStatus('Creating session...')
    setConnectionError('')
    setServerUrl('')
    setToken('')
    setRoomName('')
    setParticipantIdentity('')
    resetConversationState()
    try {
      const response = await fetch('/api/session', { method: 'POST' })
      if (!response.ok) throw new Error('The session could not be created.')
      const session = (await response.json()) as { server_url: string; token: string; room_name: string; participant_identity: string }
      setServerUrl(session.server_url)
      setToken(session.token)
      setRoomName(session.room_name)
      setParticipantIdentity(session.participant_identity)
      setSessionStatus('Session created')
    } catch {
      setSessionStatus('Unable to create a session. Check that the backend is available and configured.')
    }
  }

  async function connectRoom() {
    if (roomRef.current || !serverUrl || !token) return
    const room = new Room()
    roomRef.current = room
    connectionAttemptRef.current = room
    setConnectionStatus('Connecting')
    setConnectionError('')

    const connectionStateChanged = (state: ConnectionState) => {
      if (roomRef.current !== room) return
      if (state === ConnectionState.Connecting) setConnectionStatus('Connecting')
      if (state === ConnectionState.Connected) {
        setConnectionStatus('Connected')
        setRemoteParticipantCount(room.remoteParticipants.size)
        syncMicrophoneState(room)
      }
      if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) setConnectionStatus('Reconnecting')
      if (state === ConnectionState.Disconnected && connectionAttemptRef.current !== room) disconnectRoom()
    }
    const participantChanged = () => {
      if (roomRef.current !== room) return
      setRemoteParticipantCount(room.remoteParticipants.size)
    }
    const microphonePublicationChanged = () => roomRef.current === room && syncMicrophoneState(room)
    const trackSubscribed = (track: RemoteTrack) => {
      if (roomRef.current === room) attachRemoteAudio(room, track)
    }
    const trackUnsubscribed = (track: RemoteTrack) => {
      if (roomRef.current !== room) return
      track.detach()
      if (track.sid) removeRemoteAudio(room, track.sid)
    }
    const transcriptionReceived = (segments: TranscriptionSegment[], participant?: Participant) => {
      if (roomRef.current !== room) return
      const fromUser = participant?.identity === room.localParticipant.identity
      for (const segment of segments) {
        if (fromUser) {
          if (segment.final) {
            if (!finalTranscriptIdsRef.current.has(segment.id)) {
              finalTranscriptIdsRef.current.add(segment.id)
              setFinalTranscripts((transcripts) => [...transcripts, { id: segment.id, text: segment.text }])
            }
            setPartialTranscript('')
          } else setPartialTranscript(segment.text)
        } else {
          setAgentSpeechText(segment.text)
        }
      }
    }
    const audioPlaybackStatusChanged = (playing: boolean) => {
      if (roomRef.current !== room) return
      audioPlaybackErrorRef.current = playing ? '' : 'Browser autoplay policy blocked remote audio playback.'
      updateAudioPlayback(room)
    }
    const dataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (roomRef.current !== room || topic !== 'session_diagnostics') return
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as unknown
        if (!isDiagnostic(message)) return
        if (!belongsToSession(message.session_id, roomName)) return
        if (message.type === 'user_state_changed' && typeof message.state === 'string') {
          setUserActivity(message.state)
          if (message.state === 'speaking') {
            setCurrentTurnDiagnostics({
              speechSpan: null,
              speechEndToTurnDecision: null,
              speechEndToFinalTranscript: null,
              turnCommitToAgentThinking: null,
            })
            addDiagnosticTimelineEvent('USER_SPEECH_STARTED', 'User speech started', message)
          } else if (message.state === 'listening') {
            addDiagnosticTimelineEvent('USER_SPEECH_ENDED', 'User speech ended (VAD activity only)', message)
          } else {
            addDiagnosticTimelineEvent('USER_STATE_CHANGED', `User is ${message.state}`, message)
          }
        } else if (message.type === 'agent_state_changed' && typeof message.state === 'string') {
          setAgentActivity(message.state)
          const userSpeechToAgentStopped = readNonNegativeNumber(message.user_speech_to_agent_stopped_seconds)
          if (userSpeechToAgentStopped !== null) {
            setInterruptionDiagnostics((diagnostics) => ({ ...diagnostics, userSpeechToAgentStopped }))
          }
          if (message.state === 'thinking') {
            const turnCommitToAgentThinking = readNonNegativeNumber(message.turn_commit_to_agent_thinking_seconds)
            if (turnCommitToAgentThinking !== null) {
              setCurrentTurnDiagnostics((diagnostics) => ({ ...diagnostics, turnCommitToAgentThinking }))
            }
            addDiagnosticTimelineEvent('AGENT_THINKING', 'Agent started processing', message)
          } else if (message.state === 'speaking') {
            addDiagnosticTimelineEvent('AGENT_SPEAKING', 'Agent started speaking', message)
          } else {
            addDiagnosticTimelineEvent('AGENT_STATE_CHANGED', `Agent is ${message.state}`, message,
              userSpeechToAgentStopped === null ? undefined : `User speech → agent stopped speaking (worker): ${formatMilliseconds(userSpeechToAgentStopped)}`)
          }
        } else if (message.type === 'conversation_item_added' && typeof message.role === 'string') {
          if (message.role === 'assistant') {
            const sequence = readNonNegativeNumber(message.turn_sequence)
            if (typeof message.item_id === 'string' && typeof message.speech_id === 'string' && sequence !== null) {
              const incoming: AssistantItem = {
                itemId: message.item_id,
                speechId: message.speech_id,
                sequence,
                text: typeof message.text === 'string' ? message.text : '',
                interrupted: message.interrupted === true,
              }
              if (incoming.interrupted && !interruptedItemIdsRef.current.has(incoming.itemId)) {
                interruptedItemIdsRef.current.add(incoming.itemId)
                setInterruptedResponseCount(interruptedItemIdsRef.current.size)
              }
              const selected = selectAssistantItem(latestAssistantItemRef.current, incoming, latestSpeechSequenceRef.current)
              const applied = selected === incoming
              if (applied) {
                latestSpeechSequenceRef.current = Math.max(latestSpeechSequenceRef.current, sequence)
                latestAssistantItemRef.current = incoming
                setAgentResponse(incoming.interrupted ? '' : incoming.text)
                setInterruptionDiagnostics((diagnostics) => ({ ...diagnostics, assistantResponse: incoming.interrupted ? 'Interrupted' : 'Completed' }))
              }
              addDiagnosticTimelineEvent(
                incoming.interrupted ? 'ASSISTANT_RESPONSE_INTERRUPTED' : 'ASSISTANT_RESPONSE_COMPLETED',
                `Turn ${sequence} assistant item ${applied ? 'applied' : 'observed after newer speech'}`,
                message,
                `Speech ${incoming.speechId} · item ${incoming.itemId}`,
              )
            }
          } else if (message.role === 'user') {
            const speechSpan = readNonNegativeNumber(message.speech_span_seconds)
            const speechEndToTurnDecision = readNonNegativeNumber(message.speech_end_to_turn_decision_seconds)
            const speechEndToFinalTranscript = readNonNegativeNumber(message.speech_end_to_final_transcript_seconds)
            setCurrentTurnDiagnostics((diagnostics) => ({
              ...diagnostics,
              speechSpan,
              speechEndToTurnDecision,
              speechEndToFinalTranscript,
            }))
            addDiagnosticTimelineEvent(
              'USER_TURN_COMMITTED',
              'User conversation item committed and available to the agent',
              message,
              `Item ${typeof message.item_id === 'string' ? message.item_id : 'unknown'}${speechEndToTurnDecision === null ? '' : ` · end-of-turn decision ${formatMilliseconds(speechEndToTurnDecision)}`}`,
            )
          } else {
            addDiagnosticTimelineEvent('CONVERSATION_ITEM_COMMITTED', `Committed ${message.role} conversation item`, message)
          }
        } else if (message.type === 'overlapping_speech' && typeof message.is_interruption === 'boolean') {
          const result = message.agent_ended === true ? 'Inconclusive (agent ended)' : message.is_interruption ? 'Interruption' : 'Backchannel'
          const detectionDelay = readNonNegativeNumber(message.detection_delay_seconds)
          const predictionDuration = readNonNegativeNumber(message.prediction_duration_seconds)
          const totalDuration = readNonNegativeNumber(message.total_duration_seconds)
          const probability = readNonNegativeNumber(message.probability)
          const requestCount = readNonNegativeNumber(message.num_requests)
          setInterruptionDiagnostics((diagnostics) => ({ ...diagnostics, overlap: result, detectionDelay, predictionDuration, totalDuration, probability, requestCount }))
          addDiagnosticTimelineEvent('OVERLAPPING_SPEECH', `LiveKit classified overlap: ${result.toLowerCase()}`, message,
            `Detection ${formatMilliseconds(detectionDelay)} · prediction ${formatMilliseconds(predictionDuration)} · RTT ${formatMilliseconds(totalDuration)}${requestCount === null ? '' : ` · ${requestCount} requests`}`)
        } else if (message.type === 'agent_false_interruption' && typeof message.resumed === 'boolean') {
          setInterruptionDiagnostics((diagnostics) => ({ ...diagnostics, falseInterruptionResumed: message.resumed ? 'Yes' : 'No' }))
          addDiagnosticTimelineEvent('AGENT_FALSE_INTERRUPTION', 'LiveKit detected a false interruption', message,
            `Speech resumed automatically: ${message.resumed ? 'yes' : 'no'}`)
        } else if (message.type === 'speech_created' && typeof message.speech_id === 'string') {
          const sequence = readNonNegativeNumber(message.turn_sequence)
          if (sequence !== null) {
            if (sequence > latestSpeechSequenceRef.current) {
              latestSpeechSequenceRef.current = sequence
              if (!finishedSpeechIdsRef.current.has(message.speech_id)) {
                setActiveSpeechId(message.speech_id)
                setAgentResponse('')
                setInterruptionDiagnostics((diagnostics) => ({ ...diagnostics, assistantResponse: 'In progress' }))
              }
            }
            addDiagnosticTimelineEvent('SPEECH_CREATED', `Turn ${sequence} response created`, message, `Speech ${message.speech_id}`)
          }
        } else if (message.type === 'speech_finished' && typeof message.speech_id === 'string') {
          const sequence = readNonNegativeNumber(message.turn_sequence)
          if (sequence !== null) {
            finishedSpeechIdsRef.current.add(message.speech_id)
            latestSpeechSequenceRef.current = Math.max(latestSpeechSequenceRef.current, sequence)
            if (sequence === latestSpeechSequenceRef.current) setActiveSpeechId(null)
            addDiagnosticTimelineEvent('SPEECH_FINISHED', `Turn ${sequence} ${message.interrupted === true ? 'interrupted' : 'finished'}`, message,
              `Speech ${message.speech_id}${typeof message.item_id === 'string' ? ` · item ${message.item_id}` : ''}`)
          }
        } else if (message.type === 'turn_metrics' && typeof message.item_id === 'string') {
          const itemId = message.item_id
          const turnSequence = readNonNegativeNumber(message.turn_sequence)
          if (turnSequence !== null) {
            const result = mergeTurnMetrics(completedTurnLatenciesRef.current, latestCompletedTurnRef.current,
              itemId, turnSequence, message.completed === true, readTurnLatency(message) ?? {})
            latestCompletedTurnRef.current = result.latestCompleted
            if (result.visibleLatency) setTurnLatency(result.visibleLatency)
          }

          const speechId = typeof message.speech_id === 'string' ? message.speech_id : 'unknown speech'
          addDiagnosticTimelineEvent(
            turnSequence !== null && turnSequence < latestSpeechSequenceRef.current ? 'LATE_RESPONSE_METRIC' : 'RESPONSE_METRICS_RECEIVED',
            `Turn ${turnSequence ?? 'unknown'} metrics updated (${speechId})`,
            message,
          )
        } else if (message.type === 'provider_metric') {
          const providerMetric = readLatestProviderMetric(message)
          if (providerMetric) setLatestProviderMetric(providerMetric)
        } else if (message.type === 'speech_provider_metric' && typeof message.speech_id === 'string') {
          const sequence = readNonNegativeNumber(message.turn_sequence)
          const providerMetric = readLatestProviderMetric(message)
          addDiagnosticTimelineEvent(
            sequence !== null && sequence < latestSpeechSequenceRef.current ? 'LATE_PROVIDER_METRIC' : 'INTERRUPTED_PROVIDER_METRIC',
            `Turn ${sequence ?? 'unknown'} ${message.metric_type === 'tts' ? 'TTS' : 'LLM'} metric observed after interruption/newer speech`,
            message,
            `Speech ${message.speech_id}${providerMetric ? ` · ${providerMetric.values}` : ''}`,
          )
        } else if (message.type === 'session_usage' && Array.isArray(message.items)) {
          setUsage(message.items.map((item) => {
            const values = item as Record<string, unknown>
            return `${values.type}: ${values.input_tokens ?? 0} in / ${values.output_tokens ?? 0} out`
          }).join(' · ') || 'No provider usage yet')
        } else if (message.type === 'session_started' && typeof message.llm_model === 'string') {
          setLlmModel(message.llm_model)
          setTurnConfiguration(readTurnConfiguration(message.turn_configuration))
          const configuration = message.turn_configuration
          if (typeof configuration === 'object' && configuration !== null && 'interruption_mode' in configuration && typeof configuration.interruption_mode === 'string') {
            setInterruptionMode(`${configuration.interruption_mode} (configured)`)
          }
          setUserActivity('listening')
          setAgentActivity('idle')
          addDiagnosticTimelineEvent('SESSION_READY', 'Voice pipeline ready', message)
        } else if (message.type === 'session_error' && typeof message.source === 'string' && typeof message.message === 'string') {
          setSessionDiagnosticError(`${message.source}: ${sanitizeConnectionErrorMessage(message.message)}`)
          addDiagnosticTimelineEvent('SESSION_ERROR', `Provider error: ${message.source}`, message)
        } else if (message.type === 'session_closed') addDiagnosticTimelineEvent('SESSION_CLOSED', 'Voice pipeline closed', message)
      } catch {
        // Ignore malformed data messages from the room.
      }
    }
    roomEventHandlersRef.current = { connectionStateChanged, participantChanged, microphonePublicationChanged, trackSubscribed, trackUnsubscribed, transcriptionReceived, audioPlaybackStatusChanged, dataReceived }
    room.on(RoomEvent.ConnectionStateChanged, connectionStateChanged)
    room.on(RoomEvent.ParticipantConnected, participantChanged)
    room.on(RoomEvent.ParticipantDisconnected, participantChanged)
    room.on(RoomEvent.TrackMuted, microphonePublicationChanged)
    room.on(RoomEvent.TrackUnmuted, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackPublished, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackUnpublished, microphonePublicationChanged)
    room.on(RoomEvent.TrackSubscribed, trackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, trackUnsubscribed)
    room.on(RoomEvent.TranscriptionReceived, transcriptionReceived)
    room.on(RoomEvent.AudioPlaybackStatusChanged, audioPlaybackStatusChanged)
    room.on(RoomEvent.DataReceived, dataReceived)
    try {
      await room.connect(serverUrl, token)
      connectionAttemptRef.current = null
      if (roomRef.current !== room) return
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) attachRemoteAudio(room, publication.track)
        }
      }
      setConnectionStatus('Connected')
      setRemoteParticipantCount(room.remoteParticipants.size)
      updateAudioPlayback(room)
      syncMicrophoneState(room)
    } catch (error) {
      if (connectionAttemptRef.current !== room) return
      setConnectionError(sanitizeConnectionErrorMessage(error instanceof Error ? error.message : 'LiveKit connection failed.'))
      disconnectRoom()
      setConnectionStatus('Connection failed')
    }
  }

  function disconnectRoom() {
    const room = roomRef.current
    if (!room) return
    removeRoomEventListeners(room)
    removeAllRemoteAudio()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    stopMicrophoneAnalyser()
    void room.disconnect()
    setConnectionStatus('Disconnected')
    setMicrophoneStatus('Microphone off')
    setRemoteParticipantCount(0)
    resetConversationState()
  }

  async function enableMicrophone() {
    const room = roomRef.current
    if (!room || room.state !== ConnectionState.Connected || microphoneRequestRoomRef.current) return
    microphoneRequestRoomRef.current = room
    setMicrophoneStatus('Requesting microphone')
    setMicrophoneError('')
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
      if (roomRef.current !== room || room.state !== ConnectionState.Connected) return
      microphoneRequestRoomRef.current = null
      syncMicrophoneState(room)
    } catch (error) {
      if (roomRef.current === room) {
        microphoneRequestRoomRef.current = null
        setMicrophoneStatus('Error')
        setMicrophoneError(formatMicrophoneError(error))
      }
    }
  }

  async function toggleMicrophoneMute() {
    const room = roomRef.current
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (!room || room.state !== ConnectionState.Connected || !publication?.track) return
    try {
      await room.localParticipant.setMicrophoneEnabled(publication.isMuted)
      if (roomRef.current === room) syncMicrophoneState(room)
    } catch (error) {
      setMicrophoneStatus('Error')
      setMicrophoneError(formatMicrophoneError(error))
    }
  }

  async function enableAudio() {
    const room = roomRef.current
    if (!room) return
    try {
      audioPlaybackErrorRef.current = ''
      await room.startAudio()
      updateAudioPlayback(room)
    } catch (error) {
      audioPlaybackErrorRef.current = sanitizeConnectionErrorMessage(
        error instanceof Error ? error.message : 'Audio playback could not be enabled.',
      )
      updateAudioPlayback(room)
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation"><div className="brand"><div className="mark" aria-hidden="true"><i /><i /><i /><i /><i /></div><span>voicely<span className="brand-accent">.</span></span></div><div><p className="nav-label">Workspace</p><nav className="nav" aria-label="Sections"><a className="active" href="#session"><span>Voice session</span></a><a href="#diagnostics"><span>Diagnostics</span></a></nav></div><div className="sidebar-bottom"><div className="phase">Phase 2B</div><p>Turn handling and interruption visibility.</p></div></aside>
      <main className="main">
        <header className="top"><h1>Voice Companion / Session</h1><div className={`backend-status ${backendStatus === 'Backend connected' ? 'is-ready' : ''}`}><span>{backendStatus}</span><button type="button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Retry</button></div></header>
        <div className="layout"><div className="column">
          <div className="intro"><p className="eyebrow">A space to be heard</p><h2>Speak freely.<br />One moment at a time.</h2><p>Connect, enable your microphone, and hear the companion respond through the same LiveKit room.</p></div>
          <section className="card voice-card" id="session" aria-labelledby="session-heading"><div className="status-row"><h3 className="section-title" id="session-heading">Your voice space</h3><span className={`status ${connectionStatus === 'Connected' ? 'is-connected' : ''}`}>{connectionStatus}</span></div><div className="orb-wrap" aria-hidden="true"><div className="ring ring-two" /><div className="ring" /><div className="orb">&#9834;</div></div><div className="voice-copy"><h3>{connectionStatus === 'Connected' ? 'Connected and ready' : 'Ready when you are'}</h3><p>{connectionStatus === 'Connected' ? microphoneStatus : 'Create a session, then connect when you are ready to speak.'}</p></div><div className="controls" aria-label="Voice controls"><button className="button primary" type="button" onClick={() => void createSession()} disabled={roomIsActive}>Create session</button><button className="button" type="button" onClick={() => void connectRoom()} disabled={!hasSessionConnectionDetails || roomIsActive}>Connect</button><button className="button" type="button" onClick={() => void enableMicrophone()} disabled={connectionStatus !== 'Connected' || microphoneStatus !== 'Microphone off'}>Enable mic</button><button className="button" type="button" onClick={() => void toggleMicrophoneMute()} disabled={connectionStatus !== 'Connected' || !['Publishing microphone', 'Muted'].includes(microphoneStatus)}>{microphoneStatus === 'Muted' ? 'Unmute' : 'Mute'}</button><button className="button" type="button" onClick={() => void enableAudio()} disabled={connectionStatus !== 'Connected'}>Enable audio</button><button className="button end-button" type="button" onClick={disconnectRoom} disabled={!roomIsActive}>End</button></div><p className="control-note">Session: {sessionStatus}</p>{(connectionError || microphoneError || sessionDiagnosticError) && <p className="error-message" role="alert">{connectionError || microphoneError || sessionDiagnosticError}</p>}<div ref={audioContainerRef} className="remote-audio" aria-hidden="true" /></section>
          <section className="card panel" id="diagnostics" aria-labelledby="diagnostics-heading">
            <div className="panel-head"><h3 id="diagnostics-heading">Latency</h3><span>Latest completed turn</span></div>
            <div className="metrics">
              <div className="metric"><small>LLM first token</small><strong>{formatMilliseconds(turnLatency?.llmFirstToken ?? null)}</strong></div>
              <div className="metric"><small>LLM generation</small><strong>{formatMilliseconds(turnLatency?.llmDuration ?? null)}</strong></div>
              <div className="metric"><small>TTS first audio chunk</small><strong>{formatMilliseconds(turnLatency?.ttsFirstAudio ?? null)}</strong></div>
              <div className="metric"><small>TTS generation</small><strong>{formatMilliseconds(turnLatency?.ttsDuration ?? null)}</strong></div>
              <div className="metric"><small>Speech end → agent audio (server)</small><strong>{formatMilliseconds(turnLatency?.speechEndToAgentAudio ?? null)}</strong></div>
            </div>
            <div className="diagnostic-subsection">
              <div className="panel-head compact"><h3>Current user turn</h3><span>Native turn signals</span></div>
              <div className="metrics turn-metrics">
                <div className="metric"><small>Speech span (first start to final end)</small><strong>{formatMilliseconds(currentTurnDiagnostics.speechSpan)}</strong></div>
                <div className="metric"><small>Speech end to end-of-turn decision</small><strong>{formatMilliseconds(currentTurnDiagnostics.speechEndToTurnDecision)}</strong></div>
                <div className="metric"><small>Speech end to final transcript</small><strong>{formatMilliseconds(currentTurnDiagnostics.speechEndToFinalTranscript)}</strong></div>
                <div className="metric"><small>Turn commit to agent thinking</small><strong>{formatMilliseconds(currentTurnDiagnostics.turnCommitToAgentThinking)}</strong></div>
              </div>
            </div>
            <div className="diagnostic-subsection">
              <div className="panel-head compact"><h3>Turn handling</h3><span>Worker configuration</span></div>
              <div className="connection-details turn-configuration">
                <span>VAD <strong>{turnConfiguration?.vad ?? 'Unavailable'}</strong></span>
                <span>VAD min silence <strong>{formatMilliseconds(turnConfiguration?.vadMinSilence ?? null)} configured</strong></span>
                <span>Turn detection <strong>{turnConfiguration?.turnDetection ?? 'Unavailable'}</strong></span>
                <span>Turn detector model <strong>{turnConfiguration?.turnDetectionModel ?? 'Unavailable'}</strong></span>
                <span>Endpointing mode <strong>{turnConfiguration ? `${turnConfiguration.endpointingMode} (${turnConfiguration.endpointingModeSource})` : 'Unavailable'}</strong></span>
                <span>Min endpoint delay <strong>{turnConfiguration ? `${formatMilliseconds(turnConfiguration.minEndpointingDelay)} ${turnConfiguration.minEndpointingDelaySource}` : 'Unavailable'}</strong></span>
                <span>Max endpoint delay <strong>{turnConfiguration ? `${formatMilliseconds(turnConfiguration.maxEndpointingDelay)} ${turnConfiguration.maxEndpointingDelaySource}` : 'Unavailable'}</strong></span>
                <span>Preemptive generation <strong>{turnConfiguration ? (turnConfiguration.preemptiveGenerationEnabled ? 'enabled' : 'disabled') : 'Unavailable'}</strong></span>
              </div>
            </div>
            <div className="diagnostic-subsection">
              <div className="panel-head compact"><h3>Interruption</h3><span>Native LiveKit events</span></div>
              <div className="connection-details turn-configuration">
                <span>Interruption mode <strong>{interruptionMode}</strong></span>
                <span>Last overlap <strong>{interruptionDiagnostics.overlap}</strong></span>
                <span>Detection delay <strong>{formatMilliseconds(interruptionDiagnostics.detectionDelay)}</strong></span>
                <span>Prediction duration <strong>{formatMilliseconds(interruptionDiagnostics.predictionDuration)}</strong></span>
                <span>Detector RTT <strong>{formatMilliseconds(interruptionDiagnostics.totalDuration)}</strong></span>
                <span>Probability <strong>{interruptionDiagnostics.probability === null ? '—' : `${(interruptionDiagnostics.probability * 100).toFixed(0)}%`}</strong></span>
                <span>Detector requests <strong>{interruptionDiagnostics.requestCount ?? '—'}</strong></span>
                <span>Last assistant response <strong>{interruptionDiagnostics.assistantResponse}</strong></span>
                <span>False interruption resumed <strong>{interruptionDiagnostics.falseInterruptionResumed}</strong></span>
                <span>User speech → agent stopped speaking (worker) <strong>{formatMilliseconds(interruptionDiagnostics.userSpeechToAgentStopped)}</strong></span>
              </div>
            </div>
            <div className="diagnostic-subsection">
              <div className="panel-head compact"><h3>Response ownership</h3><span>Current room</span></div>
              <div className="connection-details turn-configuration">
                <span>Session <strong>{roomName || 'None'}</strong></span>
                <span>Active response speech <strong>{activeSpeechId || 'None'}</strong></span>
                <span>Latest assistant item <strong>{latestAssistantItemRef.current?.itemId || 'None'}</strong></span>
                <span>Interrupted assistant items <strong>{interruptedResponseCount}</strong></span>
              </div>
            </div>
            <div className="connection-details">
              <span>Latest provider metric (uncorrelated) <strong>{latestProviderMetric ? `${latestProviderMetric.metricType}: ${latestProviderMetric.values}${latestProviderMetric.speechId ? ` · speech ${latestProviderMetric.speechId}` : ''}` : 'None'}</strong></span>
            </div>
            <div className="connection-details"><span>LLM model <strong>{llmModel}</strong></span><span>Audio playback <strong>{audioPlayback.status}</strong></span><span>Room <strong>{roomName || 'Not connected'}</strong></span><span>Local participant <strong>{participantIdentity || 'Not available'}</strong></span><span>Remote participants <strong>{connectionStatus === 'Connected' ? remoteParticipantCount : '-'}</strong></span><span>Session usage <strong>{usage}</strong></span>{audioPlayback.error && <span>Playback error <strong>{audioPlayback.error}</strong></span>}</div>
          </section>
        </div><div className="column">
          <section className="card conversation" aria-labelledby="conversation-heading">
            <div className="panel-head"><h3 id="conversation-heading">Conversation</h3><span>{agentActivity}</span></div>
            <div className="conversation-debug">
              <div className="debug-row"><small>User activity</small><strong className={`activity ${userActivity}`}>{userActivity}</strong></div>
              <div className="debug-row"><small>Agent activity</small><strong className={`activity ${agentActivity}`}>{agentActivity}</strong></div>
              <div className="debug-block"><small>Microphone signal</small><p>{microphoneLevel === null ? 'Enable the microphone to inspect its local input level.' : microphoneStatus === 'Muted' ? 'Muted' : `Local input level: ${microphoneLevel.toFixed(3)}`}</p></div>
              <div className="debug-block"><small>Current partial user transcript</small><p>{partialTranscript || 'Waiting for speech recognition...'}</p></div>
              <div className="debug-block"><small>Final user transcriptions</small>{finalTranscripts.length ? <ol className="transcript-history">{finalTranscripts.map((transcript) => <li key={transcript.id}>{transcript.text}</li>)}</ol> : <p>No final user transcription yet.</p>}</div>
              <div className="debug-block"><small>Generated agent response</small><p>{agentResponse || 'Waiting for a committed agent response...'}</p></div>
              <div className="debug-block"><small>Speech-synchronized agent text</small><p>{agentSpeechText || 'Waiting for agent audio...'}</p></div>
              <div className="debug-block">
                <small>Checkpoint 2A manual prompts</small>
                <ul className="test-prompts">
                  <li>
                    <strong>Test A — clearly complete:</strong> Say “What is Redis?” Record end-of-turn delay, speech end → agent audio, and LLM TTFT. Does the detector close the completed utterance efficiently?
                  </li>
                  <li>
                    <strong>Test B — short hesitation:</strong> Say “I've been thinking that...”, pause approximately 1 second, then say “...I should change my project.” Observe whether USER_TURN_COMMITTED or AGENT_THINKING occurs during the pause, or whether both phrases remain one user turn.
                  </li>
                  <li>
                    <strong>Test C — long silence:</strong> Say “I don't know...” and stay silent. Record end-of-turn delay and when the turn commits; check that it waits appropriately without hanging.
                  </li>
                </ul>
              </div>
              <div className="debug-block">
                <small>Checkpoint 2B manual scenarios</small>
                <ul className="test-prompts">
                  <li><strong>1. Genuine interruption:</strong> During a long response say “Wait, stop.” Check overlap verdict, agent stop, interrupted assistant item, and next user turn. Record detection delay and worker stop time.</li>
                  <li><strong>2. Semantic correction:</strong> During agent speech say “No, that's not what I meant.” Check that the prior answer stops and the correction receives a response.</li>
                  <li><strong>3. “OK” backchannel:</strong> During agent speech say “OK.” Record the native overlap verdict and whether speech continues.</li>
                  <li><strong>4. “Hmm” backchannel:</strong> During agent speech say “Hmm.” Record the native overlap verdict and whether speech continues.</li>
                  <li><strong>5. Brief noise:</strong> Make a small non-speech sound. Watch VAD state, overlap verdict, and false interruption recovery.</li>
                </ul>
              </div>
              <div className="debug-block">
                <small>Pipeline event timeline</small>
                {diagnosticTimeline.length ? (
                  <ol className="diagnostic-timeline">
                    {diagnosticTimeline.map((event) => (
                      <li key={event.id}>
                        <time>{event.timestamp}</time>
                        <code>{event.type}</code>
                        <span>{event.message}</span>
                        {event.sessionElapsedSeconds !== null && <em>+{event.sessionElapsedSeconds.toFixed(3)} s worker time</em>}
                        {event.details && <em>{event.details}</em>}
                      </li>
                    ))}
                  </ol>
                ) : <p>No session events yet.</p>}
              </div>
            </div>
          </section>
        </div></div>
        <p className="footer">Voice Companion · Phase 2B exposes native turn and interruption signals. Worker timing is not browser-audible playback timing.</p>
      </main>
    </div>
  )
}

export default App
