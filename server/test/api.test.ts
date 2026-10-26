import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, login, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

describe('Kirish', () => {
  it('noto\'g\'ri parol 401', async () => {
    const r = await api().post('/api/auth/login').send({ login: 'admin', password: 'xato' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('BAD_CREDENTIALS');
  });

  it('tokensiz so\'rov 401', async () => {
    expect((await api().get('/api/users')).status).toBe(401);
  });

  it('admin kiradi, profil va rol nomi qaytadi', async () => {
    const a = await admin();
    expect(a.user).toMatchObject({ login: 'admin', role: 'admin', role_label: 'Admin', must_change_password: false });
    const me = await api().get('/api/auth/me').set(auth(a.token));
    expect(me.body.full_name).toBe('Administrator');
  });

  it('refresh token aylanadi, eskisi qayta ishlamaydi', async () => {
    const a = await admin();
    const r1 = await api().post('/api/auth/refresh').set('Cookie', a.cookie);
    expect(r1.status).toBe(200);
    expect((await api().post('/api/auth/refresh').set('Cookie', a.cookie)).status).toBe(401);
  });

  it('kuchsiz parol qabul qilinmaydi', async () => {
    const a = await admin();
    const u = await newUser(a.token, 'sklad');
    const r = await api().post('/api/auth/password').set(auth(u.token)).send({ current: 'Xodim12345', next: 'qisqa' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });
});

describe('Foydalanuvchilar', () => {
  it('admin xodim qo\'shadi: vaqtinchalik parol, birinchi kirishda almashtirish', async () => {
    const a = await admin();
    const l = uniq('innov');
    const r = await api().post('/api/users').set(auth(a.token)).send({ login: l, full_name: 'Dizayner', role: 'innovatsiya', phone: '+998901234567' });
    expect(r.status).toBe(201);
    expect(r.body.temp_password).toHaveLength(12);
    expect(JSON.stringify(r.body.user)).not.toContain('password_hash');
    const first = await login(l, r.body.temp_password);
    expect(first.user.must_change_password).toBe(true);
    expect(first.user.role_label).toBe('Innovatsion bo\'lim');
  });

  it('noto\'g\'ri rol va takroriy login rad etiladi', async () => {
    const a = await admin();
    expect((await api().post('/api/users').set(auth(a.token)).send({ login: uniq('x'), full_name: 'X', role: 'super_admin' })).status).toBe(400);
    const l = uniq('dup');
    await api().post('/api/users').set(auth(a.token)).send({ login: l, full_name: 'Ali', role: 'sklad' });
    expect((await api().post('/api/users').set(auth(a.token)).send({ login: l.toUpperCase(), full_name: 'Vali', role: 'sklad' })).status).toBe(409);
  });

  it('o\'chirilgan xodim darhol tizimdan chiqadi', async () => {
    const a = await admin();
    const u = await newUser(a.token, 'kassir');
    expect((await api().get('/api/auth/me').set(auth(u.token))).status).toBe(200);
    await api().patch(`/api/users/${u.id}`).set(auth(a.token)).send({ is_active: false });
    expect((await api().get('/api/auth/me').set(auth(u.token))).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ login: u.login, password: 'Xodim12345' })).status).toBe(401);
  });

  it('admin o\'zini o\'chira olmaydi; parol tiklanadi', async () => {
    const a = await admin();
    expect((await api().patch(`/api/users/${a.user.id}`).set(auth(a.token)).send({ is_active: false })).status).toBe(400);
    const u = await newUser(a.token, 'tsex');
    const rp = await api().post(`/api/users/${u.id}/reset-password`).set(auth(a.token));
    expect((await login(u.login, rp.body.temp_password)).user.must_change_password).toBe(true);
  });
});

describe('Ruxsatlar va audit', () => {
  it('admin bo\'lmagan foydalanuvchilarni boshqara olmaydi', async () => {
    const a = await admin();
    const r = await newUser(a.token, 'rahbar');
    expect((await api().get('/api/users').set(auth(r.token))).status).toBe(403);
    expect((await api().post('/api/users').set(auth(r.token)).send({ login: uniq('x'), full_name: 'X', role: 'admin' })).status).toBe(403);
  });

  it('har o\'zgarish auditga yoziladi; auditni rahbar ko\'radi, skladchi ko\'rmaydi', async () => {
    const a = await admin();
    const u = await newUser(a.token, 'sklad');
    await api().patch(`/api/users/${u.id}`).set(auth(a.token)).send({ full_name: 'Yangi ism' });
    const rah = await newUser(a.token, 'rahbar');
    const log = await api().get('/api/audit?entity=user').set(auth(rah.token));
    expect(log.status).toBe(200);
    const upd = log.body.find((x: { action: string; entity_id: string }) => x.action === 'update' && x.entity_id === String(u.id));
    expect(upd.old_data.full_name).toBe('sklad xodim');
    expect(upd.new_data.full_name).toBe('Yangi ism');
    expect(upd.user_name).toBe('Administrator');
    expect((await api().get('/api/audit').set(auth(u.token))).status).toBe(403);
  });
});
