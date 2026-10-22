import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "../src/dashboard/types";

export function useBoard() {
  const [data, setData] = useState<DashboardSnapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("state", (event) => {
      try {
        setData(JSON.parse((event as MessageEvent).data));
        setConnected(true);
        setError("");
      } catch {
        setError("Не удалось прочитать обновление");
      }
    });
    source.onerror = () => {
      setConnected(false);
      setError("Соединение с сервисом потеряно, переподключаемся");
    };
    return () => source.close();
  }, []);
  async function command(path: string, method = "POST", body: unknown = {}) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Не удалось выполнить действие");
    const snapshot = await fetch("/api/state");
    if (snapshot.ok) setData(await snapshot.json());
  }
  return { data, connected, error, command };
}
