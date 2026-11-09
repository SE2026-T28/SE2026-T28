export interface SearchQuery { page: number; limit: number; email?: string }
export class SearchValidationError extends Error {
  readonly status = 400;
  constructor() { super('Invalid user search query'); }
}
export function parseSearchQuery(query: URLSearchParams): SearchQuery {
  const allowed = new Set(['email', 'page', 'limit']);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new SearchValidationError();
  }
  function integer(key: string, fallback: number): number {
    const raw = query.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new SearchValidationError();
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new SearchValidationError();
    return value;
  }
  const page = integer('page', 1);
  const limit = integer('limit', 10);
  if (limit > 50 || (page - 1) * limit > 2147483647) throw new SearchValidationError();
  const email = query.get('email')?.trim();
  return { page, limit, ...(email ? { email } : {}) };
}
interface PublicUser { id: string; email: string; createdAt: Date }
interface SearchWhere { email?: { contains: string; mode: 'insensitive' } }
interface SearchArguments {
  where: SearchWhere;
  skip: number;
  take: number;
  orderBy: [{ createdAt: 'desc' }, { id: 'asc' }];
  select: { id: true; email: true; createdAt: true };
}
export interface SearchRepository {
  count(args: { where: SearchWhere }): Promise<number>;
  findMany(args: SearchArguments): Promise<PublicUser[]>;
}
// Share only overlapping COUNT queries for the same repository/filter.
// Never retain a completed result: later requests must see subsequent writes.
const pendingCounts = new WeakMap<SearchRepository, Map<string, Promise<number>>>();
function countUsers(repository: SearchRepository, where: SearchWhere): Promise<number> {
  let pending = pendingCounts.get(repository);
  if (!pending) { pending = new Map(); pendingCounts.set(repository, pending); }
  const key = JSON.stringify(where);
  const existing = pending.get(key);
  if (existing) return existing;
  const counts = pending;
  const query = Promise.resolve().then(() => repository.count({ where })).finally(() => counts.delete(key));
  counts.set(key, query);
  return query;
}
export async function searchUsers(query: SearchQuery, repository: SearchRepository) {
  // Validate at this boundary too, so direct service callers cannot bypass limits.
  const raw = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
  if (query.email !== undefined) raw.set('email', query.email);
  const { page, limit, email } = parseSearchQuery(raw);
  // PostgreSQL LIKE metacharacters must represent literal substring characters.
  const where: SearchWhere = email ? { email: { contains: email.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } } : {};
  const total = await countUsers(repository, where);
  const rows = await repository.findMany({
    where, skip: (page - 1) * limit, take: limit,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: { id: true, email: true, createdAt: true },
  });
  return {
    data: rows.map(({ id, email, createdAt }) => ({ id, email, createdAt })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
