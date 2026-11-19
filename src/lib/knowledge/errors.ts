import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

export const knowledgeFailures = defineFailures({
  KNOWLEDGE_DOCUMENT_NOT_FOUND: "Document not found.",
  KNOWLEDGE_PROVIDER_REQUIRED: "Configure an embedding provider first.",
  KNOWLEDGE_PROVIDER_UNSUPPORTED:
    "This provider does not expose an embeddings endpoint.",
  KNOWLEDGE_EMBEDDING_FAILED:
    "The embedding provider could not complete the request.",
  KNOWLEDGE_EMBEDDING_INVALID:
    "The embedding provider returned invalid or inconsistent vectors.",
  KNOWLEDGE_DOCUMENT_EMPTY: "The file does not contain indexable text.",
  KNOWLEDGE_INDEX_FAILED: "Knowledge document indexing failed.",
  KNOWLEDGE_SEARCH_FAILED: "Knowledge search failed.",
  KNOWLEDGE_SOURCE_WRITE_FAILED:
    "The source file could not be saved to the sandbox.",
});

export class KnowledgeError extends Error {
  constructor(readonly code: FailureCodeOf<typeof knowledgeFailures>) {
    super(knowledgeFailures.text(code));
  }
}
