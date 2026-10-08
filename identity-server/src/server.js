require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const argon2 = require('argon2');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const { signupSchema, loginSchema } = require('./validation');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || '';
if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters. Set a random secret in .env.');
}

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', require('node:path').join(__dirname, '..', 'views'));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(require('node:path').join(__dirname, '..', 'public'), { maxAge: isProduction ? '1h' : 0 }));

app.use(session({
  name: 'app04.sid',
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 2,
    path: '/',
  },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Quá nhiều lần thử. Vui lòng đợi 15 phút rồi thử lại.',
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.',
});

function csrfTokenFor(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireCsrf(req, res, next) {
  if (!safeEqual(req.body._csrf, req.session.csrfToken)) {
    return res.status(403).render('error', { title: 'Yêu cầu không hợp lệ', message: 'CSRF token không hợp lệ hoặc đã hết hạn. Hãy tải lại trang và thử lại.' });
  }
  next();
}
function renderForm(res, view, options = {}) {
  return res.status(options.status || 200).render(view, {
    title: options.title,
    csrfToken: options.csrfToken,
    errors: options.errors || [],
    values: options.values || {},
    message: options.message || null,
  });
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}
async function audit(eventType, userId, req, details = {}) {
  // Keep audit data deliberately small: never log passwords, session IDs, or tokens.
  try {
    await pool.query(
      `INSERT INTO audit_events (event_type, user_id, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [eventType, userId || null, req.ip || null, String(req.get('user-agent') || '').slice(0, 300), JSON.stringify(details)]
    );
  } catch (err) {
    // Audit schema is created by migration. Fail visibly in logs, but don't log sensitive input.
    console.error('Audit write failed:', err.message);
  }
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userId ? { id: req.session.userId, username: req.session.username } : null;
  next();
});

app.get('/', (req, res) => {
  res.render('home', { title: 'APP-04 · Authentication Demo', csrfToken: csrfTokenFor(req) });
});

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/profile');
  renderForm(res, 'signup', { title: 'Tạo tài khoản', csrfToken: csrfTokenFor(req) });
});

app.post('/signup', signupLimiter, requireCsrf, async (req, res, next) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => issue.message);
    return renderForm(res, 'signup', { status: 400, title: 'Tạo tài khoản', csrfToken: csrfTokenFor(req), errors, values: { username: req.body.username, email: req.body.email } });
  }

  const { username, email, password } = parsed.data;
  const usernameNormalized = username.toLowerCase();
  const emailNormalized = email.toLowerCase();
  try {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const result = await pool.query(
      `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, created_at`,
      [username, usernameNormalized, email, emailNormalized, passwordHash]
    );
    const user = result.rows[0];
    await audit('signup_success', user.id, req);
    // Do not automatically authenticate after signup: require a separate login step in this demo.
    return res.redirect('/login?registered=1');
  } catch (err) {
    if (err.code === '23505') {
      await audit('signup_duplicate_rejected', null, req);
      return renderForm(res, 'signup', {
        status: 409, title: 'Tạo tài khoản', csrfToken: csrfTokenFor(req),
        errors: ['Tên người dùng hoặc email đã được sử dụng.'],
        values: { username, email },
      });
    }
    return next(err);
  }
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/profile');
  const registered = req.query.registered === '1';
  renderForm(res, 'login', {
    title: 'Đăng nhập', csrfToken: csrfTokenFor(req),
    message: registered ? 'Đăng ký thành công. Hãy đăng nhập bằng tài khoản vừa tạo.' : null,
  });
});

app.post('/login', authLimiter, requireCsrf, async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return renderForm(res, 'login', { status: 400, title: 'Đăng nhập', csrfToken: csrfTokenFor(req), errors: parsed.error.issues.map((i) => i.message), values: { identifier: req.body.identifier } });
  }
  const { identifier, password } = parsed.data;
  try {
    const normalized = identifier.toLowerCase();
    const result = await pool.query(
      `SELECT id, username, email, password_hash, is_active
       FROM users WHERE username_normalized = $1 OR email_normalized = $1 LIMIT 1`,
      [normalized]
    );
    const user = result.rows[0];
    const passwordMatches = user ? await argon2.verify(user.password_hash, password) : false;
    if (!user || !user.is_active || !passwordMatches) {
      await audit('login_failed', user?.id || null, req);
      return renderForm(res, 'login', { status: 401, title: 'Đăng nhập', csrfToken: csrfTokenFor(req), errors: ['Thông tin đăng nhập không chính xác.'], values: { identifier } });
    }

    // Regenerate session ID after authentication to mitigate session fixation.
    req.session.regenerate(async (sessionErr) => {
      if (sessionErr) return next(sessionErr);
      req.session.userId = String(user.id);
      req.session.username = user.username;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      try {
        await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        await audit('login_success', user.id, req);
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          return res.redirect('/profile');
        });
      } catch (err) {
        return next(err);
      }
    });
  } catch (err) {
    next(err);
  }
});

app.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, created_at, last_login_at FROM users WHERE id = $1 AND is_active = TRUE',
      [req.session.userId]
    );
    if (!result.rowCount) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    res.render('profile', { title: 'Tài khoản của tôi', user: result.rows[0], csrfToken: csrfTokenFor(req) });
  } catch (err) { next(err); }
});

app.post('/logout', requireCsrf, async (req, res, next) => {
  const userId = req.session.userId || null;
  if (userId) await audit('logout', userId, req);
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('app04.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.redirect('/');
  });
});

app.use((req, res) => res.status(404).render('error', { title: 'Không tìm thấy trang', message: 'Trang bạn yêu cầu không tồn tại.' }));
app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Lỗi máy chủ', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' });
});

async function start() {
  await pool.query('SELECT 1');
  const server = app.listen(port, () => console.log(`APP-04 auth demo listening at http://localhost:${port}`));
  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Could not start server:', err.message);
  process.exit(1);
});
