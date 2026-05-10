/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production: full origin of signal-api (no trailing slash). Dev: omit — uses Vite `/api` proxy. */
  readonly VITE_SIGNAL_API?: string;
  /** Production: full origin of ens-resolver gateway. Dev: omit — uses `/gw` proxy. */
  readonly VITE_GATEWAY_URL?: string;
  /** ENS wildcard parent for `[addr].<parent>` CCIP demo (default risks.argus-security.eth). */
  readonly VITE_ARGUS_ENS_PARENT?: string;
  /** Sepolia `ArgusRegistry` contract (0x + 40 hex). Build-time; optional `localStorage` ARGUS_REGISTRY_ADDRESS_OVERRIDE in dev. */
  readonly VITE_ARGUS_REGISTRY_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css' {
  const content: string;
  export default content;
}
