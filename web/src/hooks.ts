import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { toastError } from "./toast";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useFetch<T>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    return api<T>(path).then(setData).catch(toastError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, reload, setData };
}
