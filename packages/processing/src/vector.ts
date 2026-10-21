import type { DocumentChunkRecord, ModelProviderRecord } from "@nyz-rag/types";
import { Pool } from "pg";

let pool: Pool | undefined;
let schemaInitialization: Promise<void> | undefined;

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to use the vector store.");
  }
  if (!pool) {
    pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    pool.on("error", () => console.error("Vector store idle connection failed"));
  }
  return pool;
}

function initializeSchema(currentPool: Pool): Promise<void> {
  if (!schemaInitialization) {
    const attempt = (async () => {
      await currentPool.query("CREATE EXTENSION IF NOT EXISTS vector");
      await currentPool.query(`
        CREATE TABLE IF NOT EXISTS document_vectors (
          document_id text NOT NULL,
          chunk_id text NOT NULL,
          chunk_index integer NOT NULL,
          content text NOT NULL,
          provider_id text NOT NULL,
          model text NOT NULL,
          dimensions integer NOT NULL,
          embedding vector NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (document_id, chunk_id)
        )
      `);
    })();

    const trackedAttempt = attempt.catch((error: unknown) => {
      if (pool === currentPool && schemaInitialization === trackedAttempt) {
        schemaInitialization = undefined;
      }
      throw error;
    });
    schemaInitialization = trackedAttempt;
  }

  return schemaInitialization;
}

async function getInitializedPool(): Promise<Pool> {
  const currentPool = getPool();
  await initializeSchema(currentPool);
  return currentPool;
}

function validateVectors(chunks: DocumentChunkRecord[], vectors: number[][], provider: ModelProviderRecord): void {
  if (chunks.length !== vectors.length) {
    throw new Error("The number of chunks and vectors must match.");
  }
  if (!provider.id.trim() || !provider.embeddingModel.trim()) {
    throw new Error("Vector provider ID and embedding model are required.");
  }

  let dimensions: number | undefined;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = vectors[index];
    if (!chunk.id.trim() || !Number.isSafeInteger(chunk.index) || chunk.index < 0) {
      throw new Error("Vector chunks require a nonempty ID and nonnegative integer index.");
    }
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
      throw new Error("Vectors must contain finite numeric values.");
    }
    if (!vector.some((value) => value !== 0)) {
      throw new Error("Vectors must not be zero vectors.");
    }
    if (dimensions !== undefined && vector.length !== dimensions) {
      throw new Error("All vectors for one document must have the same dimensions.");
    }
    dimensions = vector.length;
  }
}

export async function replaceDocumentVectors(
  documentId: string,
  chunks: DocumentChunkRecord[],
  vectors: number[][],
  provider: ModelProviderRecord,
): Promise<void> {
  if (!documentId.trim()) {
    throw new Error("A document ID is required to store vectors.");
  }
  validateVectors(chunks, vectors, provider);

  const currentPool = await getInitializedPool();
  const client = await currentPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM document_vectors WHERE document_id = $1", [documentId]);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const vector = vectors[index];
      await client.query(
        `INSERT INTO document_vectors
          (document_id, chunk_id, chunk_index, content, provider_id, model, dimensions, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [
          documentId,
          chunk.id,
          chunk.index,
          chunk.content,
          provider.id,
          provider.embeddingModel.trim(),
          vector.length,
          `[${vector.join(",")}]`,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDocumentVectors(documentId: string): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    return;
  }

  const currentPool = await getInitializedPool();
  await currentPool.query("DELETE FROM document_vectors WHERE document_id = $1", [documentId]);
}

export async function closeVectorStore(): Promise<void> {
  const currentPool = pool;
  pool = undefined;
  schemaInitialization = undefined;
  if (currentPool) {
    await currentPool.end();
  }
}
