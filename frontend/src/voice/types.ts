export type TimelineEvent = { id: number; time: string; text: string }
export type Interruption = { speechId: string; sequence: number; seconds: number }
export type ConversationState = { energy: string; stress: string; frustration: string; sentiment: string }
export type StartupState = 'idle' | 'creating-session' | 'connecting' | 'waiting-agent' | 'starting-audio' | 'enabling-microphone' | 'ready' | 'error'
