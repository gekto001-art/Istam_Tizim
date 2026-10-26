import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
export const api = () => request(app);

let seq = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;

export async function login(loginName: string, password: string) {
  const res = await api().post('/api/auth/login').send({ login: loginName, password });
  if (res.status !== 200) throw new Error(`login ${loginName}: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  return { token: res.body.accessToken as string, user: res.body.user, cookie };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Seed'dagi admin (vitest.config.ts: ADMIN_LOGIN / ADMIN_PASSWORD). */
export const admin = () => login('admin', 'Admin12345');

/** Admin nomidan foydalanuvchi yaratadi, vaqtinchalik parolni almashtirib kiradi. */
export async function newUser(adminToken: string, role: string) {
  const l = uniq(role);
  const r = await api().post('/api/users').set(auth(adminToken)).send({ login: l, full_name: `${role} xodim`, role });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const first = await login(l, r.body.temp_password);
  const pw = await api().post('/api/auth/password').set(auth(first.token)).send({ current: r.body.temp_password, next: 'Xodim12345' });
  return { token: pw.body.accessToken as string, id: r.body.user.id as number, login: l };
}
