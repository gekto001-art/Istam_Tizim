import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { can, type Role } from './types';
import { LoginPage, ChangePasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { UsersPage } from './pages/Users';
import { AuditPage } from './pages/Audit';

interface NavItem {
  to: string;
  label: string;
  show: (r: Role) => boolean;
}
const NAV: [string, NavItem[]][] = [
  ['Asosiy', [{ to: '/', label: 'Dashboard', show: () => true }]],
  [
    'Tizim',
    [
      { to: '/users', label: 'Foydalanuvchilar', show: (r) => can.users(r) },
      { to: '/audit', label: 'Audit log', show: (r) => can.audit(r) },
    ],
  ],
];

function Layout({ children }: { children: React.ReactNode }) {
  const { me, logout } = useAuth();
  if (!me) return null;
  return (
    <div className="app">
      <aside>
        <div className="logo">
          ISTAM
          <small>Bolalar kiyimlari · boshqaruv tizimi</small>
        </div>
        <nav aria-label="Asosiy menyu" style={{ display: 'contents' }}>
          {NAV.map(([group, items]) => {
            const vis = items.filter((i) => i.show(me.role));
            if (!vis.length) return null;
            return (
              <div key={group} style={{ display: 'contents' }}>
                <div className="ng">{group}</div>
                {vis.map((i) => (
                  <NavLink key={i.to} className="nav" to={i.to} end={i.to === '/'}>
                    {i.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <span className="who">
            {me.full_name} · {me.role_label}
          </span>
          <NavLink className="nav" to="/password" style={{ padding: 0 }}>
            Parolni almashtirish
          </NavLink>
          <button onClick={() => logout()}>Chiqish</button>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="login-wrap" aria-busy="true" />;
  if (!me) return <LoginPage />;
  if (me.must_change_password) return <ChangePasswordPage forced />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        {can.users(me.role) && <Route path="/users" element={<UsersPage />} />}
        {can.audit(me.role) && <Route path="/audit" element={<AuditPage />} />}
        <Route path="/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
