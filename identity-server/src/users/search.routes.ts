import { Router } from 'express';
import type { Provider } from 'oidc-provider';
import { getPrisma } from '../db/prisma.js';
import { parseSearchQuery, searchUsers, SearchValidationError, type SearchRepository } from './search.js';
export function searchRouter(provider: Provider, clientId: string, repository?: SearchRepository, eligible: (id: string | undefined) => boolean = () => false) {
    const router = Router();
    router.get('/search', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const reject = (status: number, code: string) => {
            if (status === 401)
                res.set('WWW-Authenticate', 'Bearer');
            return res.status(status).json({ error: { code } });
        };
        try {
            const headers = req.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'authorization');
            const match = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i);
            if (headers.length !== 1 || !match)
                return reject(401, 'UNAUTHENTICATED');
            const token = await provider.AccessToken.find(match[1]);
            if (!token || token.isExpired || token.clientId !== clientId || token.aud !== `${provider.issuer}/api/users` || token.isSenderConstrained()) {
                return reject(401, 'UNAUTHENTICATED');
            }
            if (!token.scopes.has('users:read') || !eligible(token.accountId))
                return reject(403, 'FORBIDDEN');
            const query = parseSearchQuery(new URL(req.originalUrl, provider.issuer).searchParams);
            const result = await searchUsers(query, repository ?? getPrisma().user);
            return res.json(result);
        }
        catch (error) {
            if (error instanceof SearchValidationError)
                return reject(400, 'INVALID_QUERY');
            // Never log token, SQL, connection strings or provider/storage error details.
            return reject(500, 'INTERNAL_ERROR');
        }
    });
    return router;
}
