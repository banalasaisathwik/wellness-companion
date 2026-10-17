import { type RemoteTrack, type Room, Track } from 'livekit-client'

export type RemoteAudioState = {
  elements: Map<string, HTMLMediaElement>
  playbackError: { current: string }
  container: { current: HTMLDivElement | null }
  room: { current: Room | null }
  setPlayback: (status: string) => void
}

export function updateAudioPlayback(audio: RemoteAudioState, room: Room) {
  const elements = [...audio.elements.values()]
  if (audio.playbackError.current) audio.setPlayback(audio.playbackError.current)
  else if (elements.some((element) => !element.paused)) audio.setPlayback('Playing remote audio')
  else if (elements.length) audio.setPlayback(room.canPlaybackAudio ? 'Audio attached' : 'Enable audio playback')
  else audio.setPlayback('Remote audio unavailable')
}

export function attachRemoteAudio(audio: RemoteAudioState, room: Room, track: RemoteTrack) {
  if (track.kind !== Track.Kind.Audio || !track.sid || audio.elements.has(track.sid)) return
  const element = document.createElement('audio')
  element.autoplay = true
  element.muted = false
  element.volume = 1
  audio.elements.set(track.sid, element)
  element.addEventListener('playing', () => {
    audio.playbackError.current = ''
    if (audio.room.current === room) updateAudioPlayback(audio, room)
  })
  element.addEventListener('pause', () => {
    if (audio.room.current === room) updateAudioPlayback(audio, room)
  })
  element.addEventListener('error', () => {
    audio.playbackError.current = element.error?.message || 'Audio playback failed.'
    if (audio.room.current === room) updateAudioPlayback(audio, room)
  })
  audio.container.current?.append(element)
  track.attach(element)
  updateAudioPlayback(audio, room)
}

export function removeRemoteAudio(audio: RemoteAudioState, room: Room, trackSid: string) {
  const element = audio.elements.get(trackSid)
  if (!element) return
  element.remove()
  audio.elements.delete(trackSid)
  updateAudioPlayback(audio, room)
}

export function removeAllRemoteAudio(elements: Map<string, HTMLMediaElement>) {
  for (const element of elements.values()) element.remove()
  elements.clear()
}
