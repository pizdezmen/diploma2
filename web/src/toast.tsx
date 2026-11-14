import { useSyncExternalStore } from "react";

let current: { text: string; err: boolean } | null = null;
let timer: number | undefined;
const subs = new Set<() => void>();

export function toast(text: string, err = false) {
  current = { text, err };
  subs.forEach((f) => f());
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    current = null;
    subs.forEach((f) => f());
  }, err ? 7000 : 3000);
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), true);
}

export function Toast() {
  const t = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
  if (!t) return null;
  return <div className={"toast" + (t.err ? " err" : "")}>{t.text}</div>;
}
