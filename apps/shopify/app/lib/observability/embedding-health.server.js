// @ts-check

const WINDOW_MS = 15 * 60 * 1000;

/** @type {number[]} */
let failureAt = [];
/** @type {number | null} */
let lastSuccessAt = null;
/** @type {string | null} */
let lastFailureCode = null;

/** @param {number} now */
function prune(now) {
  const cutoff = now - WINDOW_MS;
  failureAt = failureAt.filter((value) => value >= cutoff);
}

/** @param {number} [now] */
export function recordEmbeddingSuccess(now = Date.now()) {
  lastSuccessAt = now;
  prune(now);
}

/** @param {string} code @param {number} [now] */
export function recordEmbeddingFailure(code, now = Date.now()) {
  failureAt.push(now);
  lastFailureCode = code;
  prune(now);
}

/** @param {{ enabled: boolean; model: string }} config @param {number} [now] */
export function getEmbeddingHealth(config, now = Date.now()) {
  prune(now);
  return {
    configured: config.enabled,
    model: config.model,
    failuresInWindow: failureAt.length,
    lastSuccessAgoMs: lastSuccessAt === null ? null : now - lastSuccessAt,
    lastFailureCode,
  };
}

/** @param {any} prisma */
export async function getEpisodeIndexHealth(prisma) {
  const [grouped, recentFailures] = await Promise.all([
    prisma.merchantMemoryEpisode.groupBy({
      by: ["embeddingStatus"],
      _count: { _all: true },
    }),
    prisma.merchantMemoryEpisode.findMany({
      where: { embeddingStatus: "failed" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, embeddingErrorCode: true, updatedAt: true },
    }),
  ]);
  return {
    counts: Object.fromEntries(
      grouped.map((/** @type {any} */ row) => [
        row.embeddingStatus,
        row._count._all,
      ]),
    ),
    recentFailures: recentFailures.map((/** @type {any} */ row) => ({
      episodeId: row.id,
      reasonCode: row.embeddingErrorCode,
      failedAt: row.updatedAt.toISOString(),
    })),
  };
}

export function __resetEmbeddingHealth() {
  failureAt = [];
  lastSuccessAt = null;
  lastFailureCode = null;
}
