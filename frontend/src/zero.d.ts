export type NativeSdkJson =
  | null
  | boolean
  | number
  | string
  | NativeSdkJson[]
  | { [key: string]: NativeSdkJson };

export interface NativeSdkInvokeError extends Error {
  code: string;
}

export interface NativeSdkBridge {
  invoke: (command: string, payload?: NativeSdkJson) => Promise<NativeSdkJson>;
  off: (name: string, callback: (detail: NativeSdkJson) => void) => void;
  on: (name: string, callback: (detail: NativeSdkJson) => void) => () => void;
}

declare global {
  interface Window {
    zero?: NativeSdkBridge;
  }
}
