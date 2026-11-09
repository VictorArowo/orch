"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ErrorNote } from "@/components/ui";
import { post } from "@/lib/api";
import { useMe, useSession } from "@/lib/session";

// OpenRouter sends people back here with a one-time code, which the engine
// trades for a key.
function Finish() {
  const me = useMe();
  const { refresh } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    if (!me || started.current) return;
    started.current = true;
    const code = params.get("code");
    if (!code) {
      setError("OpenRouter didn't send a code back. Start the connection again from Settings.");
      return;
    }
    post("/api/keys/openrouter/finish", { code })
      .then(async () => {
        await refresh();
        router.replace("/settings#keys");
      })
      .catch((err: Error) => setError(err.message));
  }, [me, params, refresh, router]);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-6 pt-20">
      <h1 className="text-[26px] font-bold tracking-[-0.02em]">Connecting OpenRouter</h1>
      {error ? (
        <>
          <ErrorNote>{error}</ErrorNote>
          <Link href="/settings#keys" className="text-[14px] text-blue underline">
            Back to settings
          </Link>
        </>
      ) : (
        <p className="note text-[15px] text-graphite">Saving your new key…</p>
      )}
    </div>
  );
}

export default function ConnectedPage() {
  return (
    <Suspense>
      <Finish />
    </Suspense>
  );
}
