"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get, post, ApiError } from "./api";

export interface UserSettings {
  defaultPanel?: string;
  defaultCapUsd?: number;
  planCapUsd?: number;
}

export interface Me {
  user: { id: string; email: string; name: string; settings: UserSettings; createdAt: string };
  keys: { provider: string; source: "oauth" | "pasted"; last4: string; createdAt: string; lastUsedAt: string | null }[];
  gateway: string;
}

type Session = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; me: Me };

const Ctx = createContext<{ session: Session; refresh: () => Promise<void>; signOut: () => Promise<void> }>({
  session: { status: "loading" },
  refresh: async () => {},
  signOut: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const refresh = useCallback(async () => {
    try {
      setSession({ status: "signed-in", me: await get<Me>("/api/me") });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession({ status: "signed-out" });
      else setSession({ status: "signed-out" });
    }
  }, []);
  const signOut = useCallback(async () => {
    await post("/api/auth/signout", {}).catch(() => {});
    setSession({ status: "signed-out" });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ session, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

// For pages that need an account: sends signed-out visitors to sign in, and
// back here afterwards.
export function useMe(): Me | undefined {
  const { session } = useSession();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (session.status === "signed-out") {
      const next = typeof window === "undefined" ? path : window.location.pathname + window.location.search;
      router.replace(`/signin?next=${encodeURIComponent(next)}`);
    }
  }, [session.status, router, path]);
  return session.status === "signed-in" ? session.me : undefined;
}
