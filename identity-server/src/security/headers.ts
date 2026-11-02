import helmet from 'helmet';

// Mount before all application routes and provider.callback().
// The issuer is trusted server configuration, never a request Host header.
export function securityHeaders(issuer: string) {
  const url = new URL(issuer);
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('HTTP issuer is allowed only on loopback');
  }
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: secure ? [] : null,
      },
    },
    strictTransportSecurity: secure ? { maxAge: 31536000 } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
}
