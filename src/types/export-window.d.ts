declare global {
  interface Window {
    __MEO_EXPORT_READY__?: boolean;
    __MEO_EXPORT_ERROR__?: string | null;
  }
}

export {};
