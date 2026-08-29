export const MODEL_PRIMARY_TYPES = ['text', 'image', 'embedding', 'rerank'] as const;
export const MODEL_CAPABILITIES = ['reasoning', 'function_calling'] as const;
export const MODEL_INPUT_MODALITIES = ['image', 'audio', 'video'] as const;

export type ModelPrimaryType = (typeof MODEL_PRIMARY_TYPES)[number];
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

export type ProviderModelValues = {
  modelId: string;
  name: string;
  group: string;
  primaryType: ModelPrimaryType;
  capabilities: ModelCapability[];
  inputModalities: ModelInputModality[];
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
};

export function inferModelGroup(modelId: string): string {
  const normalized = modelId.trim();
  const pathGroup = normalized.includes('/') ? normalized.split('/')[0]?.trim() : '';
  if (pathGroup) return pathGroup;
  const family = normalized.split('-')[0]?.trim();
  return family && family !== normalized ? family : '';
}

export function inferModelPrimaryType(modelId: string): ModelPrimaryType {
  const id = modelId.toLocaleLowerCase();
  if (/rerank|reranker/.test(id)) return 'rerank';
  if (/embedding|embed|(^|[\/_-])(bge|e5|gte)([\/_-]|$)/.test(id)) return 'embedding';
  if (/dall-e|gpt-image|imagen|stable-diffusion|sdxl|flux|cogview|kolors|ideogram|recraft/.test(id)) return 'image';
  return 'text';
}

export function defaultProviderModel(modelId: string): ProviderModelValues {
  return {
    modelId,
    name: modelId,
    group: inferModelGroup(modelId),
    primaryType: inferModelPrimaryType(modelId),
    capabilities: [],
    inputModalities: [],
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
  };
}
