import { FormEvent, useState } from "react";
import { api } from "../api";

export function Login({ onLogin }: { onLogin: (u: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ username: string }>("/auth/login", { method: "POST", body: { username, password } });
      onLogin(r.username);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Вхід у систему моніторингу</h1>
        <input placeholder="Логін" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="Пароль" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy || !username || !password}>Увійти</button>
      </form>
    </div>
  );
}
