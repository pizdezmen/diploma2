import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api";
import { live, useLive } from "./live";
import { Toast } from "./toast";
import { Login } from "./pages/Login";
import { ModulesPage } from "./pages/Modules";
import { ModulePage } from "./pages/Module";
import { GroupsPage } from "./pages/Groups";
import { FirmwarePage } from "./pages/Firmware";
import { EventsPage } from "./pages/Events";
import { SettingsPage } from "./pages/Settings";
import { RulesPage } from "./pages/Rules";
import { AlertsPage } from "./pages/Alerts";
// esptool-js великий, тому сторінку додавання завантажуємо лише коли її відкрили
const AddModulePage = lazy(() => import("./pages/AddModule").then((m) => ({ default: m.AddModulePage })));

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      live.stop();
      setUser(null);
    });
    api<{ username: string }>("/auth/me")
      .then((r) => setUser(r.username))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (user) {
      live.start().catch(() => {});
      return () => live.stop();
    }
  }, [user]);

  if (user === undefined) return null;
  if (user === null) return <Login onLogin={setUser} />;

  return (
    <BrowserRouter>
      <TopBar
        onLogout={async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          live.stop();
          setUser(null);
        }}
      />
      <main>
        <Routes>
          <Route path="/" element={<ModulesPage />} />
          <Route path="/modules/:id" element={<ModulePage />} />
          <Route path="/add" element={<Suspense fallback={<div className="note">Завантаження…</div>}><AddModulePage /></Suspense>} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/firmware" element={<FirmwarePage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
        </Routes>
      </main>
      <Toast />
    </BrowserRouter>
  );
}

function TopBar({ onLogout }: { onLogout: () => void }) {
  const l = useLive();
  const mods = [...l.modules.values()];
  const online = mods.filter((m) => m.online).length;
  return (
    <div className="topbar">
      <span className="brand">Моніторинг</span>
      <nav>
        <NavLink to="/" end>Модулі</NavLink>
        <NavLink to="/add">Додати модуль</NavLink>
        <NavLink to="/groups">Групи</NavLink>
        <NavLink to="/firmware">Прошивки</NavLink>
        <NavLink to="/rules">Правила</NavLink>
        <NavLink to="/alerts">Сповіщення<AlertBadge /></NavLink>
        <NavLink to="/events">Події</NavLink>
        <NavLink to="/settings">Налаштування</NavLink>
      </nav>
      <span className="spacer" />
      <span className="conn">
        На зв'язку {online} з {mods.length}
      </span>
      <span className="conn">
        <span className={"dot " + (l.connected ? "ok" : "alarm")} />
        {l.connected ? "Живі дані" : "Немає з'єднання з сервером"}
      </span>
      <button className="small" onClick={onLogout}>Вийти</button>
    </div>
  );
}

// Кількість активних непідтверджених тривог; колір за найвищим рівнем
function AlertBadge() {
  const l = useLive();
  const open = [...l.alerts.values()].filter((a) => !a.acknowledged_at);
  if (!open.length) return null;
  const lvl = open.some((a) => a.level === "alarm") ? "alarm" : open.some((a) => a.level === "warning") ? "warn" : "";
  return <span className={"count " + lvl}>{open.length}</span>;
}
