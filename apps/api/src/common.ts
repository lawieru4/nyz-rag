export const MAX_QUESTION_LENGTH = 2000;

export const elapsed = (start: number) => Math.round(performance.now() - start);

export const pageParams = (page: string, pageSize: string) => ({
  page: Math.max(1, Number.parseInt(page, 10) || 1),
  pageSize: Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20)),
});
