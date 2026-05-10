/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production: full origin of signal-api (no trailing slash). Dev: omit — uses Vite `/api` proxy. */
  readonly VITE_SIGNAL_API?: string;
  /** Production: full origin of ens-resolver gateway. Dev: omit — uses `/gw` proxy. */
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css' {
  const content: string;
  export default content;
}
