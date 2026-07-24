export type PaginationCmdOpts = {
  all?: boolean;
  maxPages?: string;
  cursor?: string;
  delay?: string;
};

export function parsePositiveIntFlag(
  raw: string | undefined,
  flagName: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `Invalid ${flagName}. Expected a positive integer.` };
  }
  return { ok: true, value };
}

export function parseNonNegativeIntFlag(
  raw: string | undefined,
  flagName: string,
  defaultValue: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number.parseInt(raw ?? String(defaultValue), 10);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: `Invalid ${flagName}. Expected a non-negative integer.` };
  }
  return { ok: true, value };
}

export function parsePaginationFlags(
  cmdOpts: PaginationCmdOpts,
  opts?: {
    maxPagesImpliesPagination?: boolean;
    defaultDelayMs?: number;
    includeDelay?: boolean;
  },
):
  | {
      ok: true;
      usePagination: boolean;
      maxPages?: number;
      cursor?: string;
      pageDelayMs?: number;
    }
  | { ok: false; error: string } {
  const maxPagesImpliesPagination = opts?.maxPagesImpliesPagination ?? false;
  const includeDelay = opts?.includeDelay ?? false;
  const defaultDelayMs = opts?.defaultDelayMs ?? 1000;

  const maxPages = parsePositiveIntFlag(cmdOpts.maxPages, '--max-pages');
  if (!maxPages.ok) {
    return maxPages;
  }

  const usePagination = Boolean(
    cmdOpts.all || cmdOpts.cursor || (maxPagesImpliesPagination && maxPages.value !== undefined),
  );

  let pageDelayMs: number | undefined;
  if (includeDelay) {
    const delay = parseNonNegativeIntFlag(cmdOpts.delay, '--delay', defaultDelayMs);
    if (!delay.ok) {
      return delay;
    }
    pageDelayMs = delay.value;
  }

  return {
    ok: true,
    usePagination,
    maxPages: maxPages.value,
    cursor: cmdOpts.cursor,
    pageDelayMs,
  };
}
