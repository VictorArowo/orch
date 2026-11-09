"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ErrorNote, Field, inputClass } from "./ui";
import { post } from "@/lib/api";
import { useSession } from "@/lib/session";

// Only follow `next` to a path on this site.
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const { session, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const next = safeNext(params.get("next"));

  useEffect(() => {
    if (session.status === "signed-in") router.replace(next);
  }, [session.status, router, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post(mode === "signin" ? "/api/auth/signin" : "/api/auth/signup", mode === "signin" ? { email, password } : { email, name, password });
      await refresh();
      router.replace(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const other = mode === "signin" ? "/signup" : "/signin";
  const otherHref = params.get("next") ? `${other}?next=${encodeURIComponent(next)}` : other;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-5 px-6 pt-20 pb-16">
        <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em]">{mode === "signin" ? "Sign in" : "Create your account"}</h1>
        {mode === "signup" && (
          <p className="-mt-2 text-[15px] leading-relaxed text-ink-soft">
            You bring your own model key, so runs are billed to you directly. orch never handles payment.
          </p>
        )}
        {mode === "signup" && (
          <Field label="Name">
            <input className={`${inputClass} w-full py-2`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <input
            className={`${inputClass} w-full py-2`}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
          />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "At least 10 characters." : undefined}>
          <input
            className={`${inputClass} w-full py-2`}
            type="password"
            required
            minLength={mode === "signup" ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button tone="primary" type="submit" disabled={busy} className="h-10 justify-center">
          {busy ? (mode === "signin" ? "Signing in…" : "Creating your account…") : mode === "signin" ? "Sign in" : "Create account"}
        </Button>
        <p className="text-[14px] text-ink-soft">
          {mode === "signin" ? "New to orch? " : "Already have an account? "}
          <Link href={otherHref} className="font-medium text-blue underline-offset-2 hover:underline">
            {mode === "signin" ? "Create an account" : "Sign in"}
          </Link>
        </p>
      </form>
    </div>
  );
}
