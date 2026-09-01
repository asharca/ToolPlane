declare module '@novnc/novnc' {
  type Credentials = {
    username?: string;
    password?: string;
    target?: string;
  };

  type RfbOptions = {
    shared?: boolean;
    credentials?: Credentials;
    repeaterID?: string;
    wsProtocols?: string[];
  };

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: RfbOptions,
    );

    compressionLevel: number;
    focusOnClick: boolean;
    qualityLevel: number;
    resizeSession: boolean;
    scaleViewport: boolean;
    viewOnly: boolean;

    disconnect(): void;
    focus(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    sendCredentials(credentials: Credentials): void;
  }
}
