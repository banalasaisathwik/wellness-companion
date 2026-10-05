import { useEffect, useRef, useState } from 'react'
import {
  ConnectionState,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from 'livekit-client'
import { updateTranscript, type ConversationMessage } from './conversation'
import { belongsToSession, mergeTurnMetrics, selectAssistantItem, slowestStage, updateRecentTurns, type AssistantItem, type CompletedTurn, type TurnLatency } from './reliability'
import './App.css'
import './Luna.css'

type TimelineEvent = { id: number; time: string; text: string }
type Interruption = { speechId: string; sequence: number; seconds: number }
type ConversationState = { energy: string; stress: string; frustration: string; sentiment: string }
type SessionCredentials = { server_url: string; token: string; room_name: string }

const unknownState: ConversationState = {
  energy: 'UNKNOWN', stress: 'UNKNOWN', frustration: 'UNKNOWN', sentiment: 'UNKNOWN',
}

const strategyDetails: Record<string, { title: string; description: string }> = {
  LISTEN: { title: 'Listening', description: 'Make room for what you want to share.' },
  CLARIFY: { title: 'Clarifying', description: 'Understand what matters most right now.' },
  ENCOURAGE: { title: 'Encouragement', description: 'Offer steady, practical support.' },
  GROUND: { title: 'Grounding', description: 'Slow the conversation and return to the present.' },
  PROBLEM_SOLVE: { title: 'Problem solving', description: 'Work through a next step together.' },
  CHECK_IN: { title: 'Checking in', description: 'Pause and see how this feels for you.' },
}

function readSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function formatMilliseconds(value: number | null) {
  return value === null ? '—' : value > 0 && value < 0.001 ? '<1 ms' : `${Math.round(value * 1000)} ms`
}

function readTurnLatency(message: Record<string, unknown>): TurnLatency {
  const values: TurnLatency = {}
  for (const [source, target] of [
    ['response_latency_seconds', 'responseLatency'],
    ['final_transcript_seconds', 'finalTranscript'],
    ['turn_detection_seconds', 'turnDetection'],
    ['turn_processing_seconds', 'turnProcessing'],
    ['llm_first_token_seconds', 'llmFirstToken'],
    ['first_speakable_text_seconds', 'firstSpeakableText'],
    ['tts_first_audio_seconds', 'ttsFirstAudio'],
    ['audio_output_start_seconds', 'audioOutputStart'],
    ['state_analysis_seconds', 'stateAnalysis'],
    ['strategy_selection_seconds', 'strategySelection'],
  ] as const) {
    const value = readSeconds(message[source])
    if (value !== null) values[target] = value
  }
  if (values.responseLatency !== undefined
    && (message.response_latency_source === 'native' || message.response_latency_source === 'worker_state_fallback')) {
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

function readConversationState(value: unknown): ConversationState | null {
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

function sanitizeError(message: string) {
  return message
    .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b((?:token|api[ _-]?secret)\s*[=:]\s*)\S+/gi, '$1[redacted]')
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('No session created')
  const [startingStep, setStartingStep] = useState('')
  const [roomName, setRoomName] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Disconnected')
  const [connectionError, setConnectionError] = useState('')
  const [microphoneStatus, setMicrophoneStatus] = useState('Microphone off')
  const [microphoneError, setMicrophoneError] = useState('')
  const [sessionError, setSessionError] = useState('')
  const [audioPlayback, setAudioPlayback] = useState('Remote audio unavailable')
  const [userActivity, setUserActivity] = useState('waiting')
  const [agentActivity, setAgentActivity] = useState('waiting')
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>(unknownState)
  const [stateConfidence, setStateConfidence] = useState<number | null>(null)
  const [strategy, setStrategy] = useState('Waiting for a turn')
  const [stateStatus, setStateStatus] = useState('Waiting for a turn')
  const [recentTurns, setRecentTurns] = useState<CompletedTurn[]>([])
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [interruptions, setInterruptions] = useState<Interruption[]>([])
  const [providerModels, setProviderModels] = useState({ stt: '', llm: '', tts: '' })
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [debugOpen, setDebugOpen] = useState(false)

  const roomRef = useRef<Room | null>(null)
  const startingRef = useRef(false)
  const startAttemptRef = useRef(0)
  const connectionAttemptRef = useRef<Room | null>(null)
  const microphoneRequestRoomRef = useRef<Room | null>(null)
  const audioContainerRef = useRef<HTMLDivElement | null>(null)
  const remoteAudioElementsRef = useRef(new Map<string, HTMLMediaElement>())
  const audioPlaybackErrorRef = useRef('')
  const userSegmentOwnersRef = useRef(new Map<string, string>())
  const assistantSegmentOwnersRef = useRef(new Map<string, string>())
  const assistantMessageBySpeechRef = useRef(new Map<string, string>())
  const activeUserMessageIdRef = useRef<string | null>(null)
  const userTurnCommittedRef = useRef(false)
  const userSpeechActiveRef = useRef(false)
  const activeAssistantSpeechRef = useRef<{ speechId: string; messageId: string | null } | null>(null)
  const completedTurnLatenciesRef = useRef(new Map<string, TurnLatency>())
  const latestCompletedTurnRef = useRef<{ itemId: string; sequence: number } | null>(null)
  const latestSpeechSequenceRef = useRef(0)
  const latestAssistantItemRef = useRef<AssistantItem | null>(null)
  const latestStateTurnRef = useRef<{ itemId: string; sequence: number } | null>(null)
  const timelineIdRef = useRef(0)
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

  const roomIsActive = ['Connecting', 'Connected', 'Reconnecting'].includes(connectionStatus)

  function addTimelineEvent(text: string) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const id = timelineIdRef.current++
    setTimeline((events) => [...events.slice(-29), { id, time, text }])
  }

  function resetConversation() {
    userSegmentOwnersRef.current.clear()
    assistantSegmentOwnersRef.current.clear()
    assistantMessageBySpeechRef.current.clear()
    activeUserMessageIdRef.current = null
    userTurnCommittedRef.current = false
    userSpeechActiveRef.current = false
    activeAssistantSpeechRef.current = null
    completedTurnLatenciesRef.current.clear()
    latestCompletedTurnRef.current = null
    latestSpeechSequenceRef.current = 0
    latestAssistantItemRef.current = null
    latestStateTurnRef.current = null
    timelineIdRef.current = 0
    setUserActivity('waiting')
    setAgentActivity('waiting')
    setConversationMessages([])
    setConversationState(unknownState)
    setStateConfidence(null)
    setStrategy('Waiting for a turn')
    setStateStatus('Waiting for a turn')
    setRecentTurns([])
    setSelectedTurnId(null)
    setInterruptions([])
    setProviderModels({ stt: '', llm: '', tts: '' })
    setTimeline([])
    setSessionError('')
    setAudioPlayback('Remote audio unavailable')
    audioPlaybackErrorRef.current = ''
  }

  function updateAudioPlayback(room: Room) {
    const elements = [...remoteAudioElementsRef.current.values()]
    if (audioPlaybackErrorRef.current) setAudioPlayback(audioPlaybackErrorRef.current)
    else if (elements.some((element) => !element.paused)) setAudioPlayback('Playing remote audio')
    else if (elements.length) setAudioPlayback(room.canPlaybackAudio ? 'Audio attached' : 'Enable audio playback')
    else setAudioPlayback('Remote audio unavailable')
  }

  function attachRemoteAudio(room: Room, track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio || !track.sid || remoteAudioElementsRef.current.has(track.sid)) return
    const element = document.createElement('audio')
    element.autoplay = true
    element.muted = false
    element.volume = 1
    remoteAudioElementsRef.current.set(track.sid, element)
    element.addEventListener('playing', () => {
      audioPlaybackErrorRef.current = ''
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('pause', () => {
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('error', () => {
      audioPlaybackErrorRef.current = element.error?.message || 'Audio playback failed.'
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    audioContainerRef.current?.append(element)
    track.attach(element)
    updateAudioPlayback(room)
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
    setMicrophoneStatus(!publication?.track ? 'Microphone off' : publication.isMuted ? 'Muted' : 'Publishing microphone')
    setMicrophoneError('')
  }

  function formatMicrophoneError(error: unknown) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied.'
    if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone device was found.'
    if (error instanceof Error && /permission|notallowed/i.test(error.message)) return 'Microphone permission was denied.'
    return sanitizeError(error instanceof Error ? error.message : 'The microphone could not be enabled.')
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
    startAttemptRef.current += 1
    startingRef.current = false
    const room = roomRef.current
    if (room) removeRoomEventListeners(room)
    removeAllRemoteAudio()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    if (room) void room.disconnect()
  }, [])

  useEffect(() => {
    if (!debugOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDebugOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [debugOpen])

  async function createSession(): Promise<SessionCredentials | null> {
    setSessionStatus('Creating session...')
    setConnectionError('')
    setRoomName('')
    resetConversation()
    try {
      const response = await fetch('/api/session', { method: 'POST' })
      if (!response.ok) throw new Error('The session could not be created.')
      const session = (await response.json()) as SessionCredentials
      if (!session.server_url || !session.token || !session.room_name) throw new Error('Incomplete session response.')
      setRoomName(session.room_name)
      setSessionStatus('Session created')
      return session
    } catch {
      setSessionStatus('Unable to create a session. Check the backend configuration.')
      return null
    }
  }

  async function connectRoom(session: SessionCredentials): Promise<Room | null> {
    if (roomRef.current) return null
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
        syncMicrophoneState(room)
      }
      if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) setConnectionStatus('Reconnecting')
      if (state === ConnectionState.Disconnected && connectionAttemptRef.current !== room) disconnectRoom()
    }
    const participantChanged = () => {
      if (roomRef.current === room) updateAudioPlayback(room)
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
        if (!segment.text.trim()) continue
        if (fromUser) {
          if (!userSegmentOwnersRef.current.has(segment.id)
            && !activeUserMessageIdRef.current && userTurnCommittedRef.current) continue
          const messageId = userSegmentOwnersRef.current.get(segment.id)
            ?? activeUserMessageIdRef.current ?? segment.id
          userSegmentOwnersRef.current.set(segment.id, messageId)
          activeUserMessageIdRef.current ??= messageId
          setConversationMessages((messages) => updateTranscript(messages, messageId, 'user', segment))
        } else {
          const activeSpeech = activeAssistantSpeechRef.current
          const messageId = assistantSegmentOwnersRef.current.get(segment.id)
            ?? activeSpeech?.messageId
          if (!messageId && !activeSpeech) continue
          const ownerId = messageId ?? segment.id
          assistantSegmentOwnersRef.current.set(segment.id, ownerId)
          if (activeSpeech && !activeSpeech.messageId) {
            activeSpeech.messageId = ownerId
            assistantMessageBySpeechRef.current.set(activeSpeech.speechId, ownerId)
          }
          setConversationMessages((messages) => updateTranscript(messages, ownerId, 'assistant', segment))
        }
      }
    }
    const audioPlaybackStatusChanged = (playing: boolean) => {
      if (roomRef.current !== room) return
      audioPlaybackErrorRef.current = playing ? '' : 'Browser autoplay blocked remote audio. Select Enable audio.'
      updateAudioPlayback(room)
    }
    const dataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (roomRef.current !== room || topic !== 'session_diagnostics') return
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
        if (!message || typeof message.type !== 'string' || !belongsToSession(message.session_id, session.room_name)) return
        const sequence = readSeconds(message.turn_sequence)
        if (message.type === 'session_started') {
          setUserActivity('listening')
          setAgentActivity('idle')
          setProviderModels({
            stt: typeof message.stt_model === 'string' ? message.stt_model : '',
            llm: typeof message.llm_model === 'string' ? message.llm_model : '',
            tts: typeof message.tts_model === 'string' ? message.tts_model : '',
          })
        } else if (message.type === 'user_state_changed' && typeof message.state === 'string') {
          setUserActivity(message.state)
          if (message.state === 'speaking') {
            userSpeechActiveRef.current = true
            if (userTurnCommittedRef.current) activeUserMessageIdRef.current = null
            userTurnCommittedRef.current = false
            activeAssistantSpeechRef.current = null
            setTimeline([])
            addTimelineEvent('User started speaking')
          } else if (message.state === 'listening') {
            userSpeechActiveRef.current = false
            addTimelineEvent('User stopped speaking')
          }
        } else if (message.type === 'agent_state_changed' && typeof message.state === 'string') {
          setAgentActivity(message.state)
          if (message.state === 'speaking') {
            activeUserMessageIdRef.current = null
            userTurnCommittedRef.current = true
            addTimelineEvent('Agent started speaking')
          }
        } else if (message.type === 'conversation_item_added' && message.role === 'user') {
          if (userSpeechActiveRef.current) return
          const messageId = activeUserMessageIdRef.current
          userTurnCommittedRef.current = true
          if (messageId) setConversationMessages((messages) => messages.map((item) =>
            item.id === messageId && item.role === 'user'
              ? { ...item, itemId: typeof message.item_id === 'string' ? message.item_id : undefined, final: true }
              : item,
          ))
          addTimelineEvent('User turn committed')
        } else if (message.type === 'conversation_item_added' && message.role === 'assistant'
          && typeof message.item_id === 'string' && typeof message.speech_id === 'string' && sequence !== null) {
          const incoming: AssistantItem = {
            itemId: message.item_id,
            speechId: message.speech_id,
            sequence,
            text: typeof message.text === 'string' ? message.text : '',
            interrupted: message.interrupted === true,
          }
          const selected = selectAssistantItem(latestAssistantItemRef.current, incoming, latestSpeechSequenceRef.current)
          const transcriptId = assistantMessageBySpeechRef.current.get(incoming.speechId)
          if (transcriptId) setConversationMessages((messages) => messages.map((item) =>
            item.id === transcriptId && item.role === 'assistant'
              ? { ...item, itemId: incoming.itemId, text: incoming.text || item.text, final: true, interrupted: incoming.interrupted }
              : item,
          ))
          if (selected === incoming) {
            latestSpeechSequenceRef.current = Math.max(latestSpeechSequenceRef.current, sequence)
            latestAssistantItemRef.current = incoming
            if (incoming.text && !transcriptId) setConversationMessages((messages) =>
              messages.some((item) => item.itemId === incoming.itemId || item.id === incoming.itemId)
                ? messages
                : [...messages, { id: incoming.itemId, itemId: incoming.itemId, role: 'assistant', text: incoming.text, final: true, interrupted: incoming.interrupted }],
            )
          }
        } else if (message.type === 'speech_created' && typeof message.speech_id === 'string' && sequence !== null) {
          if (sequence > latestSpeechSequenceRef.current) {
            latestSpeechSequenceRef.current = sequence
            activeUserMessageIdRef.current = null
            userTurnCommittedRef.current = true
            activeAssistantSpeechRef.current = { speechId: message.speech_id, messageId: null }
          }
        } else if (message.type === 'turn_metrics' && typeof message.item_id === 'string' && sequence !== null) {
          const result = mergeTurnMetrics(
            completedTurnLatenciesRef.current, latestCompletedTurnRef.current,
            message.item_id, sequence, message.completed === true, readTurnLatency(message),
          )
          latestCompletedTurnRef.current = result.latestCompleted
          if (message.completed === true && typeof message.speech_id === 'string') {
            const itemId = message.item_id
            const speechId = message.speech_id
            const latency = completedTurnLatenciesRef.current.get(itemId)
            if (latency) setRecentTurns((turns) => updateRecentTurns(turns, {
              itemId,
              speechId,
              userItemId: typeof message.user_item_id === 'string' ? message.user_item_id : undefined,
              sequence,
              latency,
            }))
          }
        } else if (message.type === 'barge_in' && typeof message.speech_id === 'string' && sequence !== null) {
          const latency = readSeconds(message.barge_in_seconds)
          if (latency !== null) {
            setInterruptions((events) => [
              { speechId: message.speech_id as string, sequence, seconds: latency },
              ...events.filter((event) => event.speechId !== message.speech_id),
            ].sort((first, second) => second.sequence - first.sequence).slice(0, 5))
            addTimelineEvent(`Interrupted — agent stopped in ${formatMilliseconds(latency)} (worker)`)
          }
        } else if (message.type === 'state_analysis_started' && typeof message.item_id === 'string' && sequence !== null) {
          const current = latestStateTurnRef.current
          if (!current || sequence > current.sequence) {
            latestStateTurnRef.current = { itemId: message.item_id, sequence }
            setStateStatus('Analyzing current turn')
            setStrategy('Waiting for analysis')
            setConversationState(unknownState)
            setStateConfidence(null)
          }
        } else if (message.type === 'state_analysis_failed' && typeof message.item_id === 'string') {
          if (message.item_id === latestStateTurnRef.current?.itemId) {
            setStateStatus(`State analysis failed: ${sanitizeError(typeof message.message === 'string' ? message.message : 'Unknown error')}`)
          }
          addTimelineEvent('State analysis error')
        } else if (message.type === 'conversation_state_updated' && typeof message.item_id === 'string' && sequence !== null) {
          const state = readConversationState(message.turn_state)
          if (state && message.item_id === latestStateTurnRef.current?.itemId && sequence === latestStateTurnRef.current.sequence) {
            setConversationState(state)
            setStateConfidence(typeof message.confidence === 'number' && Number.isFinite(message.confidence)
              && message.confidence >= 0 && message.confidence <= 1 ? message.confidence : null)
            setStateStatus('Updated for current turn')
            addTimelineEvent('Conversational state updated')
          }
        } else if (message.type === 'strategy_selected' && typeof message.item_id === 'string'
          && typeof message.strategy === 'string' && sequence !== null) {
          if (message.item_id === latestStateTurnRef.current?.itemId && sequence === latestStateTurnRef.current.sequence) {
            setStrategy(message.strategy)
            addTimelineEvent(`Strategy selected: ${message.strategy.toLowerCase()}`)
          }
        } else if (message.type === 'session_error' && typeof message.message === 'string') {
          setSessionError(sanitizeError(message.message))
          addTimelineEvent('Voice session error')
        }
      } catch {
        // Ignore malformed room data.
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
      await room.connect(session.server_url, session.token)
      connectionAttemptRef.current = null
      if (roomRef.current !== room) return null
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) attachRemoteAudio(room, publication.track)
        }
      }
      setConnectionStatus('Connected')
      updateAudioPlayback(room)
      syncMicrophoneState(room)
      return room
    } catch (error) {
      if (connectionAttemptRef.current !== room) return null
      const reason = sanitizeError(error instanceof Error ? error.message : 'LiveKit connection failed.')
      disconnectRoom()
      setConnectionError(reason)
      setConnectionStatus('Connection failed')
      return null
    }
  }

  function disconnectRoom() {
    startAttemptRef.current += 1
    startingRef.current = false
    setStartingStep('')
    const room = roomRef.current
    if (!room) {
      setSessionStatus('No session created')
      setRoomName('')
      return
    }
    removeRoomEventListeners(room)
    removeAllRemoteAudio()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    void room.disconnect()
    setConnectionStatus('Disconnected')
    setMicrophoneStatus('Microphone off')
    resetConversation()
    setSessionStatus('No session created')
    setRoomName('')
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

  async function enableAudio(room = roomRef.current) {
    if (!room) return
    try {
      audioPlaybackErrorRef.current = ''
      await room.startAudio()
      updateAudioPlayback(room)
    } catch (error) {
      audioPlaybackErrorRef.current = sanitizeError(error instanceof Error ? error.message : 'Audio playback could not be enabled.')
      updateAudioPlayback(room)
    }
  }

  async function startSession() {
    if (startingRef.current || roomRef.current) return
    startingRef.current = true
    const attempt = ++startAttemptRef.current
    setStartingStep('Starting...')
    const session = await createSession()
    if (!session || attempt !== startAttemptRef.current) {
      if (attempt === startAttemptRef.current) {
        startingRef.current = false
        setStartingStep('')
      }
      return
    }
    setStartingStep('Connecting...')
    const room = await connectRoom(session)
    if (!room || attempt !== startAttemptRef.current) {
      if (attempt === startAttemptRef.current) {
        startingRef.current = false
        setStartingStep('')
      }
      return
    }
    await enableAudio(room)
    if (attempt !== startAttemptRef.current || roomRef.current !== room) return
    setStartingStep('Turning on microphone...')
    await enableMicrophone()
    if (attempt === startAttemptRef.current) {
      startingRef.current = false
      setStartingStep('')
    }
  }

  const lunaSpeaking = connectionStatus === 'Connected' && agentActivity === 'speaking' && userActivity !== 'speaking'
  const voiceState = startingStep || (connectionStatus === 'Connected'
    ? userActivity === 'speaking' ? 'Listening'
      : lunaSpeaking ? 'Luna is speaking'
        : agentActivity === 'thinking' ? 'Thinking'
          : microphoneStatus === 'Muted' ? 'Muted'
            : microphoneStatus === 'Error' || microphoneStatus === 'Microphone off' ? 'Microphone needed'
              : 'Listening'
    : connectionStatus === 'Reconnecting' ? 'Reconnecting...' : 'Here with you')
  const currentStrategy = strategyDetails[strategy]
  const activeErrors = [
    connectionError, microphoneError, sessionError,
    sessionStatus.startsWith('Unable') ? sessionStatus : '',
    audioPlayback.includes('failed') || audioPlayback.startsWith('Browser autoplay blocked') ? audioPlayback : '',
    stateStatus.startsWith('State analysis failed') ? stateStatus : '',
  ].filter(Boolean)
  const latestTurn = recentTurns[0]
  const selectedTurn = recentTurns.find((turn) => turn.itemId === selectedTurnId) ?? latestTurn
  const selectedLatency = selectedTurn?.latency
  const bottleneck = selectedLatency ? slowestStage(selectedLatency) : null
  const speakableGap = selectedLatency?.firstSpeakableText !== undefined && selectedLatency.llmFirstToken !== undefined
    ? selectedLatency.firstSpeakableText - selectedLatency.llmFirstToken : null
  const selectedInterruption = interruptions.find((event) => event.speechId === selectedTurn?.speechId)
    ?? (selectedTurnId ? undefined : interruptions[0])
  const measurements = selectedLatency ? [
    { label: 'Final transcript after speech', meaning: 'Speech ended → final transcript ready', value: selectedLatency.finalTranscript },
    { label: 'Turn detection', meaning: 'Speech ended → user turn accepted complete', value: selectedLatency.turnDetection },
    { label: 'Turn processing', meaning: 'User-turn callback began → callback finished', value: selectedLatency.turnProcessing },
    { label: 'LLM first token', meaning: selectedLatency.llmFirstTokenSource === 'provider' ? 'LLM provider request began → first token returned' : 'LLM generation began → first token returned', value: selectedLatency.llmFirstToken },
    { label: 'First speakable text', meaning: 'LLM generation began → first TTS-ready sentence', value: selectedLatency.firstSpeakableText },
    { label: 'TTS first audio', meaning: selectedLatency.ttsFirstAudioSource === 'provider' ? 'TTS provider request began → first audio chunk returned' : 'First text reached TTS → first audio chunk returned', value: selectedLatency.ttsFirstAudio },
    { label: 'Audio output start', meaning: 'First audio frame forwarded → output reported playback started', value: selectedLatency.audioOutputStart },
    { label: 'Voice response', meaning: selectedLatency.responseSource === 'worker_state_fallback' ? 'Worker user-speech end → agent speaking state' : 'User speech ended → agent response began at server output', value: selectedLatency.responseLatency },
  ].filter((row) => row.value !== undefined && (row.label !== 'Turn processing' || row.value >= 0.02)) : []

  return (
    <div className="luna-app">
      <div className="night-scene" aria-hidden="true">
        <div className="stars" /><div className="sky-glow" /><div className="mountain mountain-back" /><div className="mountain mountain-front" /><div className="lake" /><div className="distant-shore" /><div className="field" />
        <div className="resting-figure"><span className="figure-head" /><span className="figure-body" /><span className="figure-legs" /></div>
        <div className="wind wind-one" /><div className="wind wind-two" /><div className="wind wind-three" /><div className="wind wind-four" />
        {Array.from({ length: 6 }, (_, index) => <span className={`leaf leaf-${index + 1}`} key={index} />)}
      </div>
      <div className="luna-content">
        <header className="luna-header">
          <div className="luna-brand"><span className="brand-moon" aria-hidden="true" /><div><h1>Luna</h1><p>A calmer you, always here</p></div></div>
          <span className={`session-indicator ${connectionStatus === 'Connected' ? 'is-connected' : ''}`}><span className="status-dot" />{connectionStatus === 'Connected' ? 'Connected' : startingStep || 'A quiet place to talk'}</span>
        </header>
        <main className={`luna-layout ${roomIsActive ? 'has-session' : ''}`}>
          <section className="moon-stage" aria-label="Luna voice session">
            <div className={`moon-zone ${lunaSpeaking ? 'moon-speaking' : agentActivity === 'thinking' && userActivity !== 'speaking' ? 'moon-thinking' : ''}`} aria-hidden="true">
              <span className="moon-ring ring-one" /><span className="moon-ring ring-two" /><span className="moon-ring ring-three" /><span className="moon-disc" />
            </div>
            <h2>Luna</h2>
            <p className="moon-status" aria-live="polite">{voiceState}</p>
            <span className="moon-divider" aria-hidden="true" />
            <p className="moon-caption">A little space to be heard.</p>
          </section>

          {roomIsActive && <section className="glass-panel conversation-panel" aria-labelledby="conversation-heading">
            <div className="panel-heading"><h2 id="conversation-heading">Conversation</h2><span className="panel-live"><span className="status-dot" />Live</span></div>
            <div className="conversation-messages" aria-live="polite">
              {conversationMessages.length === 0 && <p className="empty">Your words will appear here when you speak.</p>}
              {conversationMessages.map((message) => <div className={`message ${message.final ? '' : 'partial'}`} key={message.id}>
                <span className={`message-dot ${message.role}`} aria-hidden="true" />
                <div className="message-content"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Luna' : 'You'}</strong>{message.interrupted ? <span>Interrupted</span> : !message.final ? <span>{message.role === 'user' ? 'Listening' : 'Speaking'}</span> : null}</div><p>{message.text}</p></div>
              </div>)}
            </div>
          </section>}

          {roomIsActive && <aside className="insight-column">
            <section className="glass-panel state-panel" aria-labelledby="state-heading">
              <div className="panel-heading"><h2 id="state-heading">Current state</h2></div>
              <p className="state-summary">{conversationState.sentiment === 'UNKNOWN'
                ? stateStatus === 'Updated for current turn' ? 'Tone unknown this turn' : 'Awaiting analysis'
                : `${conversationState.sentiment.toLowerCase()} tone`}</p>
              <div className="state-values">{(['energy', 'stress', 'frustration'] as const).map((dimension) => <div key={dimension}><span>{dimension}</span><strong>{conversationState[dimension].toLowerCase()}</strong></div>)}</div>
              {stateConfidence !== null && <p className="state-confidence">Current turn confidence: {Math.round(stateConfidence * 100)}%</p>}
            </section>
            <section className="glass-panel strategy-panel" aria-labelledby="strategy-heading">
              <div className="panel-heading"><h2 id="strategy-heading">Guided strategy</h2></div>
              <strong>{currentStrategy?.title ?? strategy.replaceAll('_', ' ')}</strong>
              <p>{currentStrategy?.description ?? 'Waiting for the next turn.'}</p>
            </section>
            <section className="glass-panel response-panel" aria-label="Voice response"><span className="eyebrow">Voice response</span><strong>{formatMilliseconds(latestTurn?.latency.responseLatency ?? null)}</strong><p>{latestTurn?.latency.responseSource === 'native' ? 'Speech end → agent response · server output' : latestTurn?.latency.responseSource === 'worker_state_fallback' ? 'Speech end → agent speaking · worker estimate' : 'Awaiting a completed response'}</p></section>
          </aside>}
        </main>
        <div className="luna-bottom">
          <div className="voice-dock" aria-label="Voice controls">
            {!roomIsActive && !startingStep && <button className="chat-button" type="button" onClick={() => void startSession()}>Let’s chat <span aria-hidden="true">→</span></button>}
            {startingStep && <button className="chat-button" type="button" disabled>{startingStep}</button>}
            {roomIsActive && <>
              <button className="dock-button" type="button" onClick={() => void (microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? enableMicrophone() : toggleMicrophoneMute())} disabled={connectionStatus !== 'Connected' || !['Microphone off', 'Publishing microphone', 'Muted', 'Error'].includes(microphoneStatus)} aria-label={microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? 'Enable microphone' : microphoneStatus === 'Muted' ? 'Unmute microphone' : 'Mute microphone'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" />{microphoneStatus === 'Muted' && <path d="M3 3l18 18" />}</svg>{microphoneStatus === 'Muted' ? 'Unmute' : microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? 'Enable mic' : 'Mute'}</button>
              <span className="dock-state"><span className="status-dot" />{voiceState}</span>
              <button className="dock-button end-button" type="button" onClick={disconnectRoom}>End session</button>
              {(audioPlayback === 'Enable audio playback' || audioPlayback.startsWith('Browser autoplay blocked') || audioPlayback.includes('failed')) && <button className="dock-button" type="button" onClick={() => void enableAudio()}>Enable audio</button>}
            </>}
          </div>
          {(connectionError || microphoneError || sessionError || sessionStatus.startsWith('Unable') || audioPlayback.startsWith('Browser autoplay blocked')) && <p className="error-message" role="alert">{connectionError || microphoneError || sessionError || (sessionStatus.startsWith('Unable') ? sessionStatus : '') || audioPlayback}</p>}
          <button type="button" className="debug-button" onClick={() => setDebugOpen(true)}>Debug <span aria-hidden="true">↗</span></button>
        </div>
      </div>
      <div ref={audioContainerRef} hidden />

      {debugOpen && <div className="debug-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) setDebugOpen(false) }}>
        <div className="debug-shell" role="dialog" aria-modal="true" aria-labelledby="debug-heading">
          <div className="debug-top"><div className="debug-title"><span className="debug-badge" aria-hidden="true">⌁</span><div><h2 id="debug-heading">Realtime Debug</h2><p>Session diagnostics and voice pipeline events</p></div></div><button className="close-button" type="button" onClick={() => setDebugOpen(false)} aria-label="Close debug">×</button></div>
          <div className="debug-content">
            <div className="debug-column">
              <section className="debug-card trace-card"><div className="debug-card-head"><h3>Voice response trace</h3><span>{selectedTurn ? `Turn ${selectedTurn.sequence}` : 'Waiting for a completed turn'}</span></div>
                <div className="trace-summary"><div><span className="eyebrow">Voice response</span><strong>{formatMilliseconds(selectedLatency?.responseLatency ?? null)}</strong><small>{selectedLatency?.responseSource === 'native' ? 'Speech end → agent response begins · native server timing' : selectedLatency?.responseSource === 'worker_state_fallback' ? 'Speech end → agent speaking state · worker estimate' : 'No response timing available'}</small></div><div><span className="eyebrow">Slowest measured stage</span><strong>{bottleneck ? `${bottleneck.label} · ${formatMilliseconds(bottleneck.seconds)}` : '—'}</strong><small>{bottleneck?.hint ?? 'Awaiting stage measurements.'}</small></div></div>
                {selectedTurn ? <>
                  <div className="trace-flow">
                    <div className="trace-boundary">User speech ended</div>
                    {(selectedLatency?.finalTranscript !== undefined || selectedLatency?.turnDetection !== undefined) && <div className="trace-stage"><small>Both measured from speech end · may overlap</small>{selectedLatency.finalTranscript !== undefined && <div><span>Final transcript after speech</span><strong>{formatMilliseconds(selectedLatency.finalTranscript)}</strong></div>}{selectedLatency.turnDetection !== undefined && <div><span>Turn detection</span><strong>{formatMilliseconds(selectedLatency.turnDetection)}</strong></div>}</div>}
                    {selectedLatency?.turnProcessing !== undefined && selectedLatency.turnProcessing >= 0.02 && <div className="trace-stage"><small>After turn accepted</small><div><span>Turn processing</span><strong>{formatMilliseconds(selectedLatency.turnProcessing)}</strong></div></div>}
                    {(selectedLatency?.llmFirstToken !== undefined || selectedLatency?.firstSpeakableText !== undefined) && <div className="trace-stage"><small>Both measured from LLM start · may overlap</small>{selectedLatency.llmFirstToken !== undefined && <div><span>LLM first token</span><strong>{formatMilliseconds(selectedLatency.llmFirstToken)}</strong></div>}{selectedLatency.firstSpeakableText !== undefined && <div><span>First speakable text</span><strong>{formatMilliseconds(selectedLatency.firstSpeakableText)}</strong></div>}</div>}
                    {selectedLatency?.ttsFirstAudio !== undefined && <div className="trace-stage"><small>After text reached TTS</small><div><span>TTS first audio</span><strong>{formatMilliseconds(selectedLatency.ttsFirstAudio)}</strong></div></div>}
                    {selectedLatency?.audioOutputStart !== undefined && <div className="trace-stage"><small>Server audio output</small><div><span>Audio output start</span><strong>{formatMilliseconds(selectedLatency.audioOutputStart)}</strong></div></div>}
                    <div className="trace-boundary">Agent response began</div>
                  </div>
                  <p className="trace-note">Each number uses its own start and end points. Final transcript and turn detection both start at speech end; first speakable text includes first-token time; turn processing includes agent logic. Do not add the rows together. Audio output start is server output timing, not browser-audible timing.</p>
                  {selectedLatency?.finalTranscript !== undefined && selectedLatency.finalTranscript > 0.5 && <p className="trace-note">Final transcript took {formatMilliseconds(selectedLatency.finalTranscript)} after speech ended. Check STT finalization and provider latency.</p>}
                  {speakableGap !== null && speakableGap > 0.2 && <p className="trace-note">First speakable text followed the first token by {formatMilliseconds(speakableGap)}. Check sentence buffering or response formatting.</p>}
                </> : <p className="debug-empty">Complete a voice turn to see its timing trace.</p>}
              </section>
              {selectedTurn && <section className="debug-card"><div className="debug-card-head"><h3>Detailed measurements</h3><span>Only reported values</span></div><div className="measurement-scroll"><table className="measurement-table"><thead><tr><th>Measurement</th><th>Exact meaning</th><th>Value</th></tr></thead><tbody>{measurements.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.meaning}</td><td>{formatMilliseconds(row.value ?? null)}</td></tr>)}</tbody></table></div></section>}
              {selectedLatency && (selectedLatency.stateAnalysis !== undefined || selectedLatency.strategySelection !== undefined) && <section className="debug-card"><div className="debug-card-head"><h3>Agent logic</h3><span>Separate from provider timing</span></div><dl className="detail-list">{selectedLatency.stateAnalysis !== undefined && <div><dt>State analysis call</dt><dd>{formatMilliseconds(selectedLatency.stateAnalysis)}</dd></div>}{selectedLatency.strategySelection !== undefined && <div><dt>Strategy selection</dt><dd>{formatMilliseconds(selectedLatency.strategySelection)}</dd></div>}</dl></section>}
              {selectedInterruption && <section className="debug-card"><div className="debug-card-head"><h3>Interruption</h3><span>Interrupted speech {selectedInterruption.sequence}</span></div><div className="interruption-detail"><span>User speech detected → agent speaking state ended</span><strong>{formatMilliseconds(selectedInterruption.seconds)}</strong><small>Worker timing; this does not measure browser playback stop.</small></div></section>}
            </div>
            <div className="debug-column">
              <section className="debug-card"><div className="debug-card-head"><h3>Recent completed turns</h3><span>Current session</span></div>{recentTurns.length ? <div className="turn-picker">{recentTurns.map((turn) => <button type="button" className={selectedTurn?.itemId === turn.itemId ? 'selected' : ''} key={turn.itemId} onClick={() => setSelectedTurnId(turn.itemId)}><span>Turn {turn.sequence}</span><strong>{formatMilliseconds(turn.latency.responseLatency ?? null)}</strong></button>)}</div> : <p className="debug-empty">No completed turns yet.</p>}</section>
              <details className="debug-card advanced-card"><summary>Advanced technical debug</summary><dl className="detail-list">
                <div><dt>Session ID</dt><dd>{roomName || '—'}</dd></div>
                <div><dt>Speech ID</dt><dd>{selectedTurn?.speechId || '—'}</dd></div>
                <div><dt>User item ID</dt><dd>{selectedTurn?.userItemId || '—'}</dd></div>
                <div><dt>Assistant item ID</dt><dd>{selectedTurn?.itemId || '—'}</dd></div>
                <div><dt>Turn sequence</dt><dd>{selectedTurn?.sequence ?? '—'}</dd></div>
                <div><dt>Interrupted</dt><dd>{selectedTurn ? 'No · completed response' : '—'}</dd></div>
                <div><dt>STT model</dt><dd>{providerModels.stt || '—'}</dd></div>
                <div><dt>LLM model</dt><dd>{providerModels.llm || '—'}</dd></div>
                <div><dt>TTS model</dt><dd>{providerModels.tts || '—'}</dd></div>
                <div><dt>Voice response source</dt><dd>{selectedLatency?.responseSource || '—'}</dd></div>
                <div><dt>LLM first token source</dt><dd>{selectedLatency?.llmFirstTokenSource || '—'}</dd></div>
                <div><dt>TTS first audio source</dt><dd>{selectedLatency?.ttsFirstAudioSource || '—'}</dd></div>
                <div><dt>Provider request IDs</dt><dd>{selectedLatency?.providerRequestIds?.join(', ') || '—'}</dd></div>
                <div><dt>Additional metric updates</dt><dd>{selectedTurn?.additionalUpdates ?? '—'}</dd></div>
                {selectedLatency?.turnProcessing !== undefined && selectedLatency.turnProcessing < 0.02 && <div><dt>Turn processing</dt><dd>{formatMilliseconds(selectedLatency.turnProcessing)}</dd></div>}
              </dl></details>
              <section className="debug-card"><div className="debug-card-head"><h3>Recent events</h3><span>Session timeline</span></div>{timeline.length ? <ol className="timeline">{timeline.map((event) => <li key={event.id}><span className="flow-dot" /><span>{event.text}</span><time>{event.time}</time></li>)}</ol> : <p className="debug-empty">No turn events yet.</p>}</section>
              <section className="debug-card"><div className="debug-card-head"><h3>Session status</h3><span>Live state</span></div><dl className="detail-list"><div><dt>Backend</dt><dd>{backendStatus} <button className="text-button" type="button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Retry</button></dd></div><div><dt>Session</dt><dd>{sessionStatus}</dd></div><div><dt>Connection</dt><dd>{connectionStatus}</dd></div><div><dt>Microphone</dt><dd>{microphoneStatus}</dd></div><div><dt>Remote audio</dt><dd>{audioPlayback}</dd></div><div><dt>User activity</dt><dd>{userActivity}</dd></div><div><dt>Agent activity</dt><dd>{agentActivity}</dd></div><div><dt>State analysis</dt><dd>{stateStatus}</dd></div></dl></section>
              <section className="debug-card"><div className="debug-card-head"><h3>Errors</h3><span>Current session</span></div><div className="debug-errors">{activeErrors.length ? activeErrors.map((error, index) => <p key={index}>{error}</p>) : <p>No active errors.</p>}</div></section>
            </div>
          </div>
        </div>
      </div>}
    </div>
  )
}

export default App
