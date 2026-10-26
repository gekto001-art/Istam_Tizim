import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { can, type Role } from './types';
import { LoginPage, ChangePasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { UsersPage } from './pages/Users';
import { AuditPage } from './pages/Audit';
import { CatalogPage } from './pages/Catalog';
import { OrdersPage } from './pages/Orders';
import { OrderPage } from './pages/Order';
import { SupplyOrderPage, SupplyPage } from './pages/Supply';
import { PurchasesPage } from './pages/Purchases';
import { TrackingPage } from './pages/Tracking';
import { PrixodPage, PrixodTaminotPage } from './pages/StockIn';
import { RasxodPage, SotuvPage, ZayavkaPage } from './pages/StockOut';
import { NakladnoyPage, OstatkaPage } from './pages/StockReports';
import { KroyPage } from './pages/Kroy';
import { BrakPage, KroyClosedPage, KroyRasxodPage, OtkPage, SemiPage } from './pages/KroyOtk';
import { TsexOstatkaPage, TsexPrixodPage, TsexProductionPage, TsexXaPage } from './pages/Tsex';
import { OtkFinalPage, SpisaniyaPage, TayyorPage } from './pages/OtkFinal';

interface NavItem {
  to: string;
  label: string;
  show: (r: Role) => boolean;
}
const NAV: [string, NavItem[]][] = [
  ['Asosiy', [{ to: '/', label: 'Dashboard', show: () => true }]],
  ['Innovatsion bo\'lim', [{ to: '/orders', label: 'Zakazlar', show: (r) => can.ordersRead(r) }]],
  [
    'Ta\'minot',
    [
      { to: '/supply', label: 'Xomashyo zakaz', show: (r) => can.purchaseRead(r) },
      { to: '/purchases', label: 'Postavshik kelishuv', show: (r) => can.purchaseRead(r) },
      { to: '/tracking', label: "Status o'zgartirish", show: (r) => can.purchaseRead(r) },
    ],
  ],
  [
    'Xomashyo skladi',
    [
      { to: '/stock/prixod-taminot', label: "Prixod (Ta'minot orqali)", show: (r) => can.stockRead(r) },
      { to: '/stock/prixod', label: 'Prixod', show: (r) => can.stockRead(r) },
      { to: '/stock/zayavka', label: 'Rasxod (Zayavka)', show: (r) => can.stockRead(r) },
      { to: '/stock/rasxod', label: 'Rasxod', show: (r) => can.stockRead(r) },
      { to: '/stock/sotuv', label: 'Sotuv', show: (r) => can.stockRead(r) },
      { to: '/stock/ostatka', label: 'Ostatka', show: (r) => can.stockRead(r) },
      { to: '/stock/nakladnoy', label: 'Nakladnoy', show: (r) => can.stockRead(r) },
    ],
  ],
  [
    'Bichuv (kroy)',
    [
      { to: '/kroy', label: 'Kroy', show: (r) => can.kroyRead(r) },
      { to: '/kroy/otk', label: 'Sifat nazorati', show: (r) => can.kroyRead(r) },
      { to: '/kroy/brak', label: 'OTK Brak', show: (r) => can.kroyRead(r) },
      { to: '/kroy/yarim-tayyor', label: 'Kroyda yarim tayyor', show: (r) => can.kroyRead(r) },
      { to: '/kroy/rasxod', label: 'Kroydan rasxod', show: (r) => can.kroyRead(r) },
      { to: '/kroy/yopilgan', label: 'Yopilgan zakazlar', show: (r) => can.kroyRead(r) },
    ],
  ],
  [
    'Tsex (ishlab chiqarish)',
    [
      { to: '/tsex/prixod', label: 'Prixod (kroydan)', show: (r) => can.tsexRead(r) },
      { to: '/tsex', label: 'Ishlab chiqarish', show: (r) => can.tsexRead(r) },
      { to: '/tsex/ostatka', label: 'Ostatka', show: (r) => can.tsexRead(r) },
      { to: '/tsex/xa', label: 'Ish/Chiq Xa', show: (r) => can.tsexRead(r) },
    ],
  ],
  [
    'OTK va tayyor mahsulot',
    [
      { to: '/otk', label: 'OTK (tayyor mahsulot)', show: (r) => can.fgRead(r) },
      { to: '/tayyor', label: 'Tayyor mahsulot skladi', show: (r) => can.fgRead(r) },
      { to: '/spisaniya', label: 'Spisaniya (P&L)', show: (r) => can.fgRead(r) },
    ],
  ],
  ['Ma\'lumotnomalar', [{ to: '/catalog', label: 'Ranglar, xomashyo...', show: () => true }]],
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
                  <NavLink key={i.to} className="nav" to={i.to} end={['/', '/kroy', '/tsex'].includes(i.to)}>
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
        {can.ordersRead(me.role) && <Route path="/orders" element={<OrdersPage />} />}
        {can.ordersRead(me.role) && <Route path="/orders/:id" element={<OrderPage />} />}
        {can.purchaseRead(me.role) && <Route path="/supply" element={<SupplyPage />} />}
        {can.purchaseRead(me.role) && <Route path="/supply/:orderId" element={<SupplyOrderPage />} />}
        {can.purchaseRead(me.role) && <Route path="/purchases" element={<PurchasesPage />} />}
        {can.purchaseRead(me.role) && <Route path="/tracking" element={<TrackingPage />} />}
        {can.purchaseRead(me.role) && <Route path="/tracking/:orderId" element={<TrackingPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/prixod-taminot" element={<PrixodTaminotPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/prixod" element={<PrixodPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/zayavka" element={<ZayavkaPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/rasxod" element={<RasxodPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/sotuv" element={<SotuvPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/ostatka" element={<OstatkaPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/nakladnoy" element={<NakladnoyPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy" element={<KroyPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/otk" element={<OtkPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/brak" element={<BrakPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/yarim-tayyor" element={<SemiPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/rasxod" element={<KroyRasxodPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/yopilgan" element={<KroyClosedPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex" element={<TsexProductionPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/prixod" element={<TsexPrixodPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/ostatka" element={<TsexOstatkaPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/xa" element={<TsexXaPage />} />}
        {can.fgRead(me.role) && <Route path="/otk" element={<OtkFinalPage />} />}
        {can.fgRead(me.role) && <Route path="/tayyor" element={<TayyorPage />} />}
        {can.fgRead(me.role) && <Route path="/spisaniya" element={<SpisaniyaPage />} />}
        <Route path="/catalog" element={<CatalogPage />} />
        {can.users(me.role) && <Route path="/users" element={<UsersPage />} />}
        {can.audit(me.role) && <Route path="/audit" element={<AuditPage />} />}
        <Route path="/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
