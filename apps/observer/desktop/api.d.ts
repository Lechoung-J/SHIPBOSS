export interface ShipbossToolCall {
  readonly callId: string; readonly sequence: number;
  readonly state: 'started' | 'ended' | 'error';
  readonly timestamp: number; readonly startedAt: number;
  readonly category: 'read' | 'search' | 'edit' | 'command' | 'test' | 'delegate' | 'other';
  readonly target: string;
}
export interface ShipbossToolActivity {
  readonly version: 1; readonly projectId: string; readonly actorId: string; readonly sessionId: string;
  readonly runningCount: number; readonly thinking: boolean; readonly suppressed?: boolean;
  readonly calls: ReadonlyArray<ShipbossToolCall>;
}
export interface ShipbossActor {
  readonly id: 'pm' | 'eng-a' | 'eng-b' | 'verifier' | 'recording';
  readonly role: 'pm' | 'engineer' | 'verifier' | 'recording';
  readonly name: string; readonly active: boolean; readonly uncertain: boolean;
  readonly taskId: string | null; readonly motion: string; readonly activity: string; readonly papers: number;
  readonly toolActivity?: ShipbossToolActivity | null;
}
export interface ShipbossProject extends Readonly<Record<string, unknown>> {
  readonly id: string; readonly actors: ReadonlyArray<ShipbossActor>;
  readonly recording: boolean; readonly recordingUncertain: boolean;
  readonly recordingActor?: ShipbossActor | null;
}

export interface ShipbossDesktopState {
  readonly pinned: boolean;
  readonly expanded: boolean;
  readonly visible: boolean;
}

export interface ShipbossDesktop {
  readonly getState: () => Promise<ShipbossDesktopState>;
  readonly setPinned: (pinned: boolean) => Promise<ShipbossDesktopState>;
  readonly setExpanded: (expanded: boolean) => Promise<ShipbossDesktopState>;
  readonly hide: () => Promise<ShipbossDesktopState>;
  readonly quit: () => Promise<void>;
  /** Subscribe to subsequent changes; call getState() to initialize. */
  readonly onState: (callback: (state: ShipbossDesktopState) => void) => () => void;
}

export interface ShipbossObserverState {
  readonly mode: 'bridge' | 'demo';
  readonly status: 'waiting' | 'live' | 'stale' | 'demo';
  readonly version: 1;
  readonly source: string | null;
  readonly generatedAt: string | null;
  readonly projects: ReadonlyArray<ShipbossProject>;
  readonly error: { readonly type: string; readonly at: string } | null;
  readonly receivedAt: string | null;
}

/** Read-only state bridge. It intentionally has no send/write method. */
export interface ShipbossObserver {
  readonly preview: boolean; readonly activityTesting: boolean;
  readonly mode: 'bridge' | 'demo';
  readonly getState: () => Promise<ShipbossObserverState>;
  /** Subscribe to subsequent state changes; call getState() to initialize. */
  readonly onState: (callback: (state: ShipbossObserverState) => void) => () => void;
}

declare global {
  interface Window {
    readonly shipbossDesktop?: Readonly<ShipbossDesktop>;
    readonly shipbossObserver?: Readonly<ShipbossObserver>;
  }
}
