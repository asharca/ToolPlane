import 'server-only';
import { Prisma } from '@prisma/client';
import { Type } from '@earendil-works/pi-ai';
import { agentTool, type AgentToolSet } from '@/lib/agents/agent-tool';
import { db } from '@/lib/db';

const MAX_QUERY_LENGTH = 4_000;

type EmbeddingProvider = { format: string; baseUrl: string; apiKey: string };
type SearchBase = {
  id: string;
  embeddingModel: string;
  topK: number;
  threshold: number;
  provider: EmbeddingProvider | null;
};

export async function embed(provider: EmbeddingProvider, model: string, input: string): Promise<number[]> {
  if (provider.format === 'anthropic' || provider.format === 'pi:anthropic') {
    throw new Error('This provider does not expose an OpenAI-compatible embeddings endpoint.');
  }
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Embedding request failed (${response.status}).`);
  const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => typeof value !== 'number')) {
    throw new Error('Embedding provider returned an invalid vector.');
  }
  return vector;
}

export function splitKnowledgeText(text: string, chunkSize: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const size = Math.max(200, Math.min(chunkSize, 8_000));
  const step = Math.max(1, size - Math.max(0, Math.min(overlap, size - 1)));
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += step) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + size / 2) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
  }
  return chunks;
}

function vectorLiteral(vector: number[]) {
  return `[${vector.join(',')}]`;
}

export async function indexKnowledgeText(documentId: string, text: string) {
  const document = await db.knowledgeDocument.findUnique({
    where: { id: documentId },
    include: { knowledgeBase: { include: { provider: true } } },
  });
  if (!document) throw new Error('Knowledge document not found.');
  const provider = document.knowledgeBase.provider;
  if (!provider) throw new Error('Configure an embedding provider first.');
  const chunks = splitKnowledgeText(text, document.knowledgeBase.chunkSize, document.knowledgeBase.chunkOverlap);
  if (!chunks.length) throw new Error('The file does not contain indexable text.');

  await db.knowledgeDocument.update({ where: { id: document.id }, data: { status: 'indexing', error: null } });
  try {
    const vectors = await Promise.all(chunks.map((chunk) => embed(provider, document.knowledgeBase.embeddingModel, chunk)));
    const dimensions = vectors[0]?.length;
    if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new Error('Embedding dimensions are inconsistent.');
    await db.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
      for (const [ordinal, chunk] of chunks.entries()) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "KnowledgeChunk" ("id", "documentId", "ordinal", "content", "embedding", "createdAt")
          VALUES (${`kc_${crypto.randomUUID().replaceAll('-', '')}`}, ${document.id}, ${ordinal}, ${chunk}, ${vectorLiteral(vectors[ordinal])}::vector, NOW())
        `);
      }
      await tx.knowledgeBase.update({ where: { id: document.knowledgeBaseId }, data: { dimensions } });
      await tx.knowledgeDocument.update({ where: { id: document.id }, data: { status: 'indexed', error: null } });
    });
  } catch (error) {
    await db.knowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'Indexing failed.' },
    });
    throw error;
  }
}

export async function searchKnowledgeBases(bases: SearchBase[], query: string) {
  const cleanQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!cleanQuery) return [];
  const results = await Promise.all(bases.filter((base) => base.provider).map(async (base) => {
    const vector = await embed(base.provider!, base.embeddingModel, cleanQuery);
    const rows = await db.$queryRaw<Array<{
      chunkId: string;
      content: string;
      documentId: string;
      filename: string;
      sourcePath: string;
      score: number;
    }>>(Prisma.sql`
      SELECT kc."id" AS "chunkId", kc."content", kd."id" AS "documentId", kd."filename", kd."sourcePath",
        1 - (kc."embedding" <=> ${vectorLiteral(vector)}::vector) AS "score"
      FROM "KnowledgeChunk" kc
      JOIN "KnowledgeDocument" kd ON kd."id" = kc."documentId"
      WHERE kd."knowledgeBaseId" = ${base.id}
        AND kd."status" = 'indexed'
        AND kc."embedding" IS NOT NULL
      ORDER BY kc."embedding" <=> ${vectorLiteral(vector)}::vector
      LIMIT ${Math.max(1, Math.min(base.topK, 20))}
    `);
    return rows.filter((row) => row.score >= base.threshold).map((row) => ({ ...row, knowledgeBaseId: base.id }));
  }));
  return results.flat().sort((a, b) => b.score - a.score).slice(0, 20);
}

export function buildKnowledgeTool(bases: SearchBase[]): AgentToolSet {
  if (!bases.length) return {};
  return {
    knowledge_search: agentTool({
      name: 'knowledge_search',
      description: "Search the Agent's authorized workspace knowledge bases. Returns source citations and excerpts.",
      parameters: Type.Object({ query: Type.String({ description: 'The question or terms to search for.' }) }),
      execute: async ({ query }: { query: string }) => ({ sources: await searchKnowledgeBases(bases, query) }),
    }),
  };
}
