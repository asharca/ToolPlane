export type ProviderOAuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{
    id: string;
    label: string;
    description?: string;
  }>;
};

export type ProviderOAuthUrlInfo = {
  url: string;
  instructions?: string;
};

export type ProviderOAuthDeviceCodeInfo = {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
};

export type ProviderOAuthInfoNotice = {
  message: string;
  links?: ReadonlyArray<{ url: string; label?: string }>;
};

export type ProviderOAuthSessionSnapshot = {
  sessionId: string;
  format: string;
  name: string;
  status: "waiting" | "completed" | "failed" | "cancelled";
  authUrl?: ProviderOAuthUrlInfo;
  deviceCode?: ProviderOAuthDeviceCodeInfo;
  info?: ProviderOAuthInfoNotice;
  prompt?: ProviderOAuthPrompt;
  progress: string[];
  error?: string;
  providerId?: string;
  savedAt?: number;
};
