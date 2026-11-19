const jwt = require('jsonwebtoken');
const COOKIE = 'hostly_session';
function sign(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Faça login para continuar.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.clearCookie(COOKIE); return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
}
function setSession(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
}
module.exports = { sign, requireAuth, setSession, COOKIE };
