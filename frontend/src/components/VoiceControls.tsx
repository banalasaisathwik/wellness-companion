import type { StartupState } from '../voice/types'

type VoiceControlsProps = {
  startupState: StartupState
  isStarting: boolean
  roomIsActive: boolean
  connectionStatus: string
  microphoneStatus: string
  voiceState: string
  audioPlayback: string
  onStart: () => void
  onMicrophone: () => void
  onEnd: () => void
  onAudio: () => void
}

export function VoiceControls({ startupState, isStarting, roomIsActive, connectionStatus,
  microphoneStatus, voiceState, audioPlayback, onStart, onMicrophone, onEnd, onAudio }: VoiceControlsProps) {
  return (
    <div className="voice-dock" aria-label="Voice controls">
      {startupState === 'idle' && <button className="chat-button" type="button" onClick={onStart}>Let’s chat <span aria-hidden="true">→</span></button>}
      {isStarting && <button className="chat-button" type="button" disabled>Preparing Luna...</button>}
      {startupState === 'error' && <button className="chat-button" type="button" onClick={onStart}>Retry <span aria-hidden="true">→</span></button>}
      {roomIsActive && startupState === 'ready' && <>
        <button className="dock-button" type="button" onClick={onMicrophone} disabled={connectionStatus !== 'Connected' || !['Microphone off', 'Publishing microphone', 'Muted', 'Error'].includes(microphoneStatus)} aria-label={microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? 'Enable microphone' : microphoneStatus === 'Muted' ? 'Unmute microphone' : 'Mute microphone'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" />{microphoneStatus === 'Muted' && <path d="M3 3l18 18" />}</svg>{microphoneStatus === 'Muted' ? 'Unmute' : microphoneStatus === 'Microphone off' || microphoneStatus === 'Error' ? 'Enable mic' : 'Mute'}</button>
        <span className="dock-state"><span className="status-dot" />{voiceState}</span>
        <button className="dock-button end-button" type="button" onClick={onEnd}>End session</button>
        {(audioPlayback === 'Enable audio playback' || audioPlayback.startsWith('Browser autoplay blocked') || audioPlayback.includes('failed')) && <button className="dock-button" type="button" onClick={onAudio}>Enable audio</button>}
      </>}
    </div>
  )
}
