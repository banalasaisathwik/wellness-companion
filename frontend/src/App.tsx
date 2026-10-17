import { useEffect, useRef, useState } from 'react'
import { ConnectionState, type Participant, type RemoteTrack, Room, RoomEvent, Track, type TranscriptionSegment } from 'livekit-client'
import { readConversationState, updateTranscript, type ConversationMessage } from './conversation'
import { belongsToSession, formatMilliseconds, mergeTurnMetrics, readAgentLogicMetrics, readSeconds, readTurnLatency, selectAssistantItem, updateRecentTurns, type AgentLogicMetrics, type AssistantItem, type CompletedTurn, type TurnLatency } from './reliability'
import { formatMicrophoneError, removeRoomEventListeners, requestSession, sanitizeError, waitForAgentReady, type RoomEventHandlers, type SessionCredentials } from './voice/session'
import { attachRemoteAudio, removeAllRemoteAudio, removeRemoteAudio, updateAudioPlayback } from './voice/audio'
import type { ConversationState, Interruption, StartupState, TimelineEvent } from './voice/types'
import { ConversationPanel } from './components/ConversationPanel'
import { StatePanel } from './components/StatePanel'
import { VoiceControls } from './components/VoiceControls'
import { DebugPanel } from './components/DebugPanel'
import './App.css'
import './Luna.css'

const startupText: Record<StartupState, string> = {
  idle: '',
  'creating-session': 'Creating your space...',
  connecting: 'Connecting to Luna...',
  'waiting-agent': 'Preparing Luna...',
  'starting-audio': 'Preparing Luna...',
  'enabling-microphone': 'Almost ready...',
  ready: 'Luna is listening',
  error: '',
}

const unknownState: ConversationState = {
  energy: 'UNKNOWN', stress: 'UNKNOWN', frustration: 'UNKNOWN', sentiment: 'UNKNOWN',
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('No session created')
  const [startupState, setStartupState] = useState<StartupState>('idle')
  const [startupError, setStartupError] = useState('')
  const [sessionReadySeconds, setSessionReadySeconds] = useState<number | null>(null)
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
  const [lastInterrupted, setLastInterrupted] = useState<{ speechId: string; itemId: string | null; sequence: number } | null>(null)
  const [providerModels, setProviderModels] = useState({ stt: '', llm: '', tts: '' })
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [debugOpen, setDebugOpen] = useState(false)

  const roomRef = useRef<Room | null>(null)
  const startingRef = useRef(false)
  const startAttemptRef = useRef(0)
  const startupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupAbortRef = useRef<AbortController | null>(null)
  const connectionAttemptRef = useRef<Room | null>(null)
  const readyRoomRef = useRef<Room | null>(null)
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
  const agentLogicByUserItemRef = useRef(new Map<string, AgentLogicMetrics>())
  const completedTurnByUserItemRef = useRef(new Map<string, { itemId: string; speechId: string; sequence: number }>())
  const latestCompletedTurnRef = useRef<{ itemId: string; sequence: number } | null>(null)
  const latestSpeechSequenceRef = useRef(0)
  const latestAssistantItemRef = useRef<AssistantItem | null>(null)
  const latestStateTurnRef = useRef<{ itemId: string; sequence: number } | null>(null)
  const timelineIdRef = useRef(0)
  const roomEventHandlersRef = useRef<RoomEventHandlers | null>(null)

  const remoteAudio = {
    elements: remoteAudioElementsRef.current,
    playbackError: audioPlaybackErrorRef,
    container: audioContainerRef,
    room: roomRef,
    setPlayback: setAudioPlayback,
  }

  const roomIsActive = ['Connecting', 'Connected', 'Reconnecting'].includes(connectionStatus)
  const isStarting = !['idle', 'ready', 'error'].includes(startupState)

  function isCurrentRoom(room: Room) {
    return roomRef.current === room
  }

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
    agentLogicByUserItemRef.current.clear()
    completedTurnByUserItemRef.current.clear()
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
    setLastInterrupted(null)
    setProviderModels({ stt: '', llm: '', tts: '' })
    setTimeline([])
    setSessionError('')
    setAudioPlayback('Remote audio unavailable')
    audioPlaybackErrorRef.current = ''
  }

  function syncMicrophoneState(room: Room) {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    setMicrophoneStatus(!publication?.track ? 'Microphone off' : publication.isMuted ? 'Muted' : 'Publishing microphone')
    setMicrophoneError('')
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
    if (startupTimeoutRef.current) clearTimeout(startupTimeoutRef.current)
    startupAbortRef.current?.abort()
    const room = roomRef.current
    if (room) removeRoomEventListeners(room, roomEventHandlersRef.current)
    roomEventHandlersRef.current = null
    removeAllRemoteAudio(remoteAudioElementsRef.current)
    roomRef.current = null
    connectionAttemptRef.current = null
    readyRoomRef.current = null
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

  async function createSession(signal: AbortSignal): Promise<SessionCredentials | null> {
    setSessionStatus('Creating session...')
    setConnectionError('')
    setRoomName('')
    resetConversation()
    try {
      const session = await requestSession(signal)
      if (!session) return null
      setRoomName(session.room_name)
      setSessionStatus('Session created')
      return session
    } catch {
      if (!signal.aborted) setSessionStatus('Unable to create a session. Check the backend configuration.')
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
      if (state === ConnectionState.Disconnected && connectionAttemptRef.current !== room) {
        const interruptedStartup = startingRef.current
        disconnectRoom()
        if (interruptedStartup) {
          setStartupError('Couldn’t connect to Luna.')
          setStartupState('error')
        }
      }
    }
    const participantChanged = () => {
      if (roomRef.current !== room) return
      updateAudioPlayback(remoteAudio, room)
      if (readyRoomRef.current === room && room.state === ConnectionState.Connected
        && ![...room.remoteParticipants.values()].some((participant) => participant.isAgent)) {
        disconnectRoom()
        setStartupError('Luna disconnected. Try again.')
        setStartupState('error')
      }
    }
    const microphonePublicationChanged = () => roomRef.current === room && syncMicrophoneState(room)
    const trackSubscribed = (track: RemoteTrack) => {
      if (roomRef.current === room) attachRemoteAudio(remoteAudio, room, track)
    }
    const trackUnsubscribed = (track: RemoteTrack) => {
      if (roomRef.current !== room) return
      track.detach()
      if (track.sid) removeRemoteAudio(remoteAudio, room, track.sid)
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
      updateAudioPlayback(remoteAudio, room)
    }
    const dataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      const frontendReceivedAt = performance.now()
      const frontendReceivedWallMs = Date.now()
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
        } else if (message.type === 'speech_finished' && message.interrupted === true
          && typeof message.speech_id === 'string' && sequence !== null) {
          setLastInterrupted((current) => current && current.sequence > sequence ? current : {
            speechId: message.speech_id as string,
            itemId: typeof message.item_id === 'string' ? message.item_id : null,
            sequence,
          })
        } else if (message.type === 'agent_logic_metrics' && typeof message.user_item_id === 'string') {
          const incoming = readAgentLogicMetrics(message.metrics)
          if (!incoming) return
          const userItemId = message.user_item_id
          agentLogicByUserItemRef.current.set(userItemId, {
            ...agentLogicByUserItemRef.current.get(userItemId), ...incoming,
          })
          const owner = completedTurnByUserItemRef.current.get(userItemId)
          if (owner) {
            mergeTurnMetrics(completedTurnLatenciesRef.current, latestCompletedTurnRef.current,
              owner.itemId, owner.sequence, true, { agentLogicMetrics: incoming })
            const latency = completedTurnLatenciesRef.current.get(owner.itemId)
            if (latency) setRecentTurns((turns) => updateRecentTurns(turns, {
              ...owner, userItemId, latency,
            }))
          }
          console.debug(`TURN ${String(message.turn_sequence ?? '?')} agent logic metrics received and ${owner ? 'merged' : 'queued'}`)
        } else if (message.type === 'turn_metrics' && typeof message.item_id === 'string' && sequence !== null) {
          const userItemId = typeof message.user_item_id === 'string' ? message.user_item_id : undefined
          const result = mergeTurnMetrics(
            completedTurnLatenciesRef.current, latestCompletedTurnRef.current,
            message.item_id, sequence, message.completed === true, {
              ...readTurnLatency(message),
              agentLogicMetrics: userItemId ? agentLogicByUserItemRef.current.get(userItemId) : undefined,
            },
          )
          const frontendMergedAt = performance.now()
          if (Array.isArray(message.metric_trace)) {
            for (const trace of message.metric_trace) {
              if (!trace || typeof trace !== 'object') continue
              console.debug('[metric-trace]', JSON.stringify({
                stage: 'merged',
                trace_id: trace.trace_id,
                observation_id: trace.observation_id,
                session_id: message.session_id,
                turn_seq: sequence,
                speech_id: message.speech_id,
                assistant_item_id: message.item_id,
                metric_name: trace.metric_name,
                metric_value_ms: trace.metric_value_ms,
                source: trace.source,
                update_kind: trace.update_kind,
                frontend_received_at: frontendReceivedAt,
                frontend_merged_at: frontendMergedAt,
                frontend_merge_delay_ms: frontendMergedAt - frontendReceivedAt,
                // Wall clocks can be skewed. This is approximate transport tracing only.
                approximate_transport_ms: typeof trace.backend_publish_wall_ms === 'number'
                  ? frontendReceivedWallMs - trace.backend_publish_wall_ms : null,
                merge_target: 'completedTurnLatenciesRef',
              }))
            }
          }
          latestCompletedTurnRef.current = result.latestCompleted
          if (message.completed === true && typeof message.speech_id === 'string') {
            const itemId = message.item_id
            const speechId = message.speech_id
            if (userItemId) completedTurnByUserItemRef.current.set(userItemId, { itemId, speechId, sequence })
            const latency = completedTurnLatenciesRef.current.get(itemId)
            if (latency) setRecentTurns((turns) => updateRecentTurns(turns, {
              itemId,
              speechId,
              userItemId,
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
      if (roomRef.current !== room) {
        void room.disconnect()
        return null
      }
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) attachRemoteAudio(remoteAudio, room, publication.track)
        }
      }
      setConnectionStatus('Connected')
      updateAudioPlayback(remoteAudio, room)
      syncMicrophoneState(room)
      return room
    } catch (error) {
      if (connectionAttemptRef.current !== room) return null
      const reason = sanitizeError(error instanceof Error ? error.message : 'LiveKit connection failed.')
      disconnectRoom()
      setConnectionError(reason)
      setConnectionStatus('Connection failed')
      setStartupError('Couldn’t connect to Luna.')
      setStartupState('error')
      return null
    }
  }

  function disconnectRoom() {
    startAttemptRef.current += 1
    startingRef.current = false
    if (startupTimeoutRef.current) clearTimeout(startupTimeoutRef.current)
    startupTimeoutRef.current = null
    startupAbortRef.current?.abort()
    startupAbortRef.current = null
    setStartupState('idle')
    setStartupError('')
    setSessionReadySeconds(null)
    const room = roomRef.current
    if (!room) {
      setSessionStatus('No session created')
      setRoomName('')
      return
    }
    removeRoomEventListeners(room, roomEventHandlersRef.current)
    roomEventHandlersRef.current = null
    removeAllRemoteAudio(remoteAudioElementsRef.current)
    roomRef.current = null
    connectionAttemptRef.current = null
    readyRoomRef.current = null
    microphoneRequestRoomRef.current = null
    void room.disconnect()
    setConnectionStatus('Disconnected')
    setMicrophoneStatus('Microphone off')
    resetConversation()
    setSessionStatus('No session created')
    setRoomName('')
  }

  async function enableMicrophone(): Promise<boolean> {
    const room = roomRef.current
    if (!room || room.state !== ConnectionState.Connected || microphoneRequestRoomRef.current) return false
    microphoneRequestRoomRef.current = room
    setMicrophoneStatus('Requesting microphone')
    setMicrophoneError('')
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
      if (roomRef.current !== room || room.state !== ConnectionState.Connected) return false
      microphoneRequestRoomRef.current = null
      syncMicrophoneState(room)
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
      return Boolean(publication?.track && !publication.isMuted)
    } catch (error) {
      if (roomRef.current === room) {
        microphoneRequestRoomRef.current = null
        setMicrophoneStatus('Error')
        setMicrophoneError(formatMicrophoneError(error))
      }
      return false
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

  async function enableAudio(room = roomRef.current): Promise<boolean> {
    if (!room) return false
    try {
      audioPlaybackErrorRef.current = ''
      await room.startAudio()
      updateAudioPlayback(remoteAudio, room)
      return room.canPlaybackAudio
    } catch (error) {
      audioPlaybackErrorRef.current = sanitizeError(error instanceof Error ? error.message : 'Audio playback could not be enabled.')
      updateAudioPlayback(remoteAudio, room)
      return false
    }
  }

  // Click path: create session, connect, start audio, await Luna, then publish the mic.
  async function startSession() {
    if (startingRef.current || roomRef.current) return
    startingRef.current = true
    const attempt = ++startAttemptRef.current
    const abortController = new AbortController()
    startupAbortRef.current = abortController
    const startedAt = performance.now()
    let step: StartupState = 'creating-session'
    const advance = (next: StartupState) => { step = next; setStartupState(next) }
    setStartupError('')
    setMicrophoneError('')
    setSessionReadySeconds(null)
    advance('creating-session')
    startupTimeoutRef.current = setTimeout(() => {
      if (attempt !== startAttemptRef.current) return
      const message = step === 'waiting-agent' ? 'Luna is taking too long to start.' : 'Luna couldn’t start. Try again.'
      disconnectRoom()
      setStartupError(message)
      setStartupState('error')
    }, 20000)
    try {
      const session = await createSession(abortController.signal)
      if (attempt !== startAttemptRef.current) return
      if (!session) throw new Error('session')
      advance('connecting')
      const room = await connectRoom(session)
      if (attempt !== startAttemptRef.current) return
      if (!room) throw new Error('connection')
      advance('starting-audio')
      if (!await enableAudio(room)) throw new Error('audio')
      if (attempt !== startAttemptRef.current || !isCurrentRoom(room)) return
      advance('waiting-agent')
      await waitForAgentReady(room, abortController.signal)
      if (attempt !== startAttemptRef.current || !isCurrentRoom(room)) return
      advance('enabling-microphone')
      if (![...room.remoteParticipants.values()].some((participant) => participant.isAgent)) throw new Error('agent')
      if (!await enableMicrophone()) throw new Error('microphone')
      if (attempt !== startAttemptRef.current || !isCurrentRoom(room)) return
      if (![...room.remoteParticipants.values()].some((participant) => participant.isAgent)) throw new Error('agent')
      readyRoomRef.current = room
      setSessionReadySeconds((performance.now() - startedAt) / 1000)
      advance('ready')
    } catch (error) {
      if (attempt !== startAttemptRef.current) return
      let message = 'Luna couldn’t start. Try again.'
      if (error instanceof Error) {
        switch (error.message) {
          case 'session':
            message = 'Couldn’t start the session.'
            break
          case 'connection':
            message = 'Couldn’t connect to Luna.'
            break
          case 'microphone':
            message = 'Microphone access is needed to talk with Luna.'
            break
          case 'audio':
            message = 'Couldn’t start Luna’s audio. Try again.'
            break
          case 'agent':
            message = 'Luna disconnected. Try again.'
            break
        }
      }
      disconnectRoom()
      setStartupError(message)
      setStartupState('error')
    } finally {
      if (attempt === startAttemptRef.current) {
        if (startupTimeoutRef.current) clearTimeout(startupTimeoutRef.current)
        startupTimeoutRef.current = null
        startupAbortRef.current = null
        startingRef.current = false
      }
    }
  }

  const lunaSpeaking = startupState === 'ready' && connectionStatus === 'Connected' && agentActivity === 'speaking' && userActivity !== 'speaking'
  let voiceState = 'Here with you'
  if (isStarting) {
    voiceState = startupText[startupState]
  } else if (startupState === 'error') {
    voiceState = 'Luna needs a moment'
  } else if (connectionStatus === 'Connected' && startupState === 'ready') {
    if (lunaSpeaking) voiceState = 'Luna is speaking'
    else if (agentActivity === 'thinking') voiceState = 'Thinking'
    else if (microphoneStatus === 'Muted') voiceState = 'Muted'
    else if (microphoneStatus !== 'Publishing microphone') voiceState = 'Microphone needed'
    else if (userActivity === 'speaking') voiceState = 'Listening'
    else voiceState = startupText.ready
  } else if (connectionStatus === 'Reconnecting') {
    voiceState = 'Reconnecting...'
  }
  const activeErrors = [
    connectionError, microphoneError, sessionError,
    sessionStatus.startsWith('Unable') ? sessionStatus : '',
    audioPlayback.includes('failed') || audioPlayback.startsWith('Browser autoplay blocked') ? audioPlayback : '',
    stateStatus.startsWith('State analysis failed') ? stateStatus : '',
  ].filter(Boolean)
  const latestTurn = recentTurns[0]

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
          <span className={`session-indicator ${startupState === 'ready' && connectionStatus === 'Connected' ? 'is-connected' : ''}`}><span className="status-dot" />{startupState === 'ready' && connectionStatus === 'Connected' ? 'Connected' : isStarting ? startupText[startupState] : 'A quiet place to talk'}</span>
        </header>
        <main className={`luna-layout ${roomIsActive && startupState === 'ready' ? 'has-session' : ''}`}>
          <section className="moon-stage" aria-label="Luna voice session">
            <div className={`moon-zone ${isStarting ? 'moon-starting' : lunaSpeaking ? 'moon-speaking' : startupState === 'ready' && agentActivity === 'thinking' && userActivity !== 'speaking' ? 'moon-thinking' : ''}`} aria-hidden="true">
              <span className="moon-ring ring-one" /><span className="moon-ring ring-two" /><span className="moon-ring ring-three" /><span className="moon-disc" />
            </div>
            <h2>Luna</h2>
            <p className="moon-status" aria-live="polite">{voiceState}</p>
            <span className="moon-divider" aria-hidden="true" />
            <p className="moon-caption">A little space to be heard.</p>
          </section>

          {roomIsActive && startupState === 'ready' && <ConversationPanel conversationMessages={conversationMessages} />}

          {roomIsActive && startupState === 'ready' && <aside className="insight-column">
            <StatePanel conversationState={conversationState} stateStatus={stateStatus} stateConfidence={stateConfidence} strategy={strategy} />
            <section className="glass-panel response-panel" aria-label="Voice response"><span className="eyebrow">Voice response</span><strong>{formatMilliseconds(latestTurn?.latency.responseLatency ?? null)}</strong><p>{latestTurn?.latency.responseSource === 'native' ? 'Speech end → agent response · server output' : latestTurn?.latency.responseSource === 'message_timestamps' ? 'Speech end → agent response · SDK message timestamps' : latestTurn?.latency.responseSource === 'worker_state_fallback' ? 'Speech end → agent speaking · worker estimate' : 'Awaiting a completed response'}</p></section>
          </aside>}
        </main>
        <div className="luna-bottom">
          <VoiceControls startupState={startupState} isStarting={isStarting} roomIsActive={roomIsActive}
            connectionStatus={connectionStatus} microphoneStatus={microphoneStatus} voiceState={voiceState}
            audioPlayback={audioPlayback} onStart={() => void startSession()}
            onMicrophone={() => void (microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? enableMicrophone() : toggleMicrophoneMute())}
            onEnd={disconnectRoom} onAudio={() => void enableAudio()} />
          {(startupError || (startupState === 'ready' && (microphoneError || sessionError || audioPlayback.startsWith('Browser autoplay blocked')))) && <p className="error-message" role="alert">{startupError || microphoneError || sessionError || audioPlayback}</p>}
          <button type="button" className="debug-button" onClick={() => setDebugOpen(true)}>Debug <span aria-hidden="true">↗</span></button>
        </div>
      </div>
      <div ref={audioContainerRef} hidden />

      {debugOpen && <DebugPanel recentTurns={recentTurns} selectedTurnId={selectedTurnId} interruptions={interruptions}
        lastInterrupted={lastInterrupted} providerModels={providerModels} timeline={timeline} roomName={roomName}
        backendStatus={backendStatus} startupState={startupState} sessionReadySeconds={sessionReadySeconds}
        sessionStatus={sessionStatus} connectionStatus={connectionStatus} microphoneStatus={microphoneStatus}
        audioPlayback={audioPlayback} userActivity={userActivity} agentActivity={agentActivity} stateStatus={stateStatus}
        activeErrors={activeErrors} onClose={() => setDebugOpen(false)} onSelectTurn={setSelectedTurnId}
        onRetryBackend={() => setRetryAttempt((attempt) => attempt + 1)} />}
    </div>
  )
}

export default App
