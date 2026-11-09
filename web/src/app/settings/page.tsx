"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, ErrorNote, Field, inputClass } from "@/components/ui";
import { get, post, type PanelEntry } from "@/lib/api";
import { useMe, useSession, type Me } from "@/lib/session";

function when(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} hours ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-rule pt-8 pb-10">
      <h2 className="text-[20px] font-bold tracking-[-0.01em]">{title}</h2>
      {intro && <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-soft">{intro}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Saved({ text }: { text?: string | undefined }) {
  return text ? <span className="note text-[14px] text-ink">{text}</span> : null;
}

// A small form wrapper: busy state, error and a confirmation line.
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const msg = await fn();
      if (msg) setDone(msg);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
}

function Profile({ me }: { me: Me }) {
  const { refresh } = useSession();
  const [name, setName] = useState(me.user.name);
  const [email, setEmail] = useState(me.user.email);
  const a = useAction();
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void a.run(async () => {
          await post("/api/me/profile", { name, email });
          await refresh();
          return "Saved.";
        });
      }}
    >
      <Field label="Name">
        <input className={`${inputClass} w-full py-2`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </Field>
      <Field label="Email">
        <input className={`${inputClass} w-full py-2`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </Field>
      {a.error && <ErrorNote>{a.error}</ErrorNote>}
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={a.busy}>
          Save profile
        </Button>
        <Saved text={a.done} />
      </div>
    </form>
  );
}

function Password() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const a = useAction();
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void a.run(async () => {
          await post("/api/me/password", { current, next });
          setCurrent("");
          setNext("");
          return "Password changed. Other devices have been signed out.";
        });
      }}
    >
      <Field label="Current password">
        <input className={`${inputClass} w-full py-2`} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </Field>
      <Field label="New password" hint="At least 10 characters.">
        <input className={`${inputClass} w-full py-2`} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
      </Field>
      {a.error && <ErrorNote>{a.error}</ErrorNote>}
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={a.busy}>
          Change password
        </Button>
        <Saved text={a.done} />
      </div>
    </form>
  );
}

interface KeyStatus {
  label?: string;
  limitUsd: number | null;
  usageUsd: number;
  remainingUsd: number | null;
}

function describeStatus(s: KeyStatus): string {
  const used = `$${s.usageUsd.toFixed(2)} used`;
  if (s.limitUsd === null) return `${used}, with no spending limit on the key.`;
  return `${used}; $${(s.remainingUsd ?? 0).toFixed(2)} left of its $${s.limitUsd.toFixed(2)} limit.`;
}

function Keys({ me }: { me: Me }) {
  const { refresh } = useSession();
  const key = me.keys.find((k) => k.provider === "openrouter");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [status, setStatus] = useState<string>();
  const a = useAction();

  const connect = () =>
    a.run(async () => {
      const r = await post<{ url: string }>("/api/keys/openrouter/connect", { callbackUrl: `${window.location.origin}/settings/connected` });
      window.location.href = r.url;
    });

  return (
    <div className="flex max-w-xl flex-col gap-5">
      {me.gateway === "mock" && (
        <p className="note text-[14px] text-graphite">This engine is running on mock models, so nothing needs a key right now. A key you add here is used once it runs on OpenRouter.</p>
      )}
      {key ? (
        <div className="rounded-[6px] border border-ink/20 bg-sheet px-5 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="text-[16px] font-semibold">OpenRouter key ending in {key.last4}</div>
            <span className="text-[13px] text-graphite">{key.source === "oauth" ? "connected through OpenRouter" : "pasted"}</span>
          </div>
          <div className="mt-1 text-[14px] text-ink-soft">
            Added {when(key.createdAt)}. Last used {when(key.lastUsedAt)}.
          </div>
          {status && <div className="mt-2 text-[14px] text-ink">{status}</div>}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  const r = await post<{ ok: boolean; status?: KeyStatus; error?: string }>("/api/keys/openrouter/check", {});
                  if (!r.ok) throw new Error(r.error);
                  setStatus(describeStatus(r.status!));
                })
              }
            >
              Check it
            </Button>
            <Button disabled={a.busy} onClick={() => void connect()}>
              Replace with a new connection
            </Button>
            <Button
              tone="danger"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  if (!window.confirm("Remove this key from orch? Runs will stop working until you add another. This doesn't revoke it on OpenRouter.")) return;
                  await post("/api/keys/openrouter/delete", {});
                  setStatus(undefined);
                  await refresh();
                  return "Removed. To revoke the key itself, delete it in your OpenRouter dashboard.";
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="primary" disabled={a.busy} onClick={() => void connect()}>
              Connect with OpenRouter
            </Button>
            <button className="text-[14px] text-blue underline-offset-2 hover:underline" onClick={() => setPasting((p) => !p)}>
              {pasting ? "Cancel" : "Paste a key instead"}
            </button>
          </div>
          <p className="text-[13px] leading-relaxed text-graphite">
            Connecting creates a key for orch in your OpenRouter account. You can set a spending limit on it, or revoke it, from your OpenRouter dashboard at any time.
          </p>
        </div>
      )}
      {(pasting || key) && (
        <form
          className={`flex flex-col gap-3 ${key && !pasting ? "hidden" : ""}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void a.run(async () => {
              const r = await post<{ status: KeyStatus }>("/api/keys/openrouter", { key: pasted });
              setPasted("");
              setPasting(false);
              setStatus(describeStatus(r.status));
              await refresh();
              return "Saved. The key is encrypted and won't be shown again.";
            });
          }}
        >
          <Field
            label="OpenRouter key"
            hint={
              <>
                Make a dedicated key with a spending limit at{" "}
                <a className="text-blue underline" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
                  openrouter.ai/settings/keys
                </a>
                .
              </>
            }
          >
            <input className={`${inputClass} w-full py-2`} type="password" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="sk-or-…" autoComplete="off" spellCheck={false} />
          </Field>
          <div>
            <Button type="submit" disabled={a.busy || !pasted.trim()}>
              Check and save
            </Button>
          </div>
        </form>
      )}
      {key && !pasting && (
        <button className="self-start text-[14px] text-blue underline-offset-2 hover:underline" onClick={() => setPasting(true)}>
          Paste a different key
        </button>
      )}
      {a.error && <ErrorNote>{a.error}</ErrorNote>}
      <Saved text={a.done} />
    </div>
  );
}

function Defaults({ me }: { me: Me }) {
  const { refresh } = useSession();
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [panel, setPanel] = useState(me.user.settings.defaultPanel ?? "starter");
  const [cap, setCap] = useState(String(me.user.settings.defaultCapUsd ?? ""));
  const [planCap, setPlanCap] = useState(String(me.user.settings.planCapUsd ?? "0.10"));
  const a = useAction();
  useEffect(() => {
    get<PanelEntry[]>("/api/panels").then(setPanels, () => {});
  }, []);
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void a.run(async () => {
          const body: Record<string, unknown> = { defaultPanel: panel, planCapUsd: Number(planCap) };
          if (cap.trim()) body.defaultCapUsd = Number(cap);
          await post("/api/me/settings", body);
          await refresh();
          return "Saved.";
        });
      }}
    >
      <Field label="Panel for new plans">
        <select className={`${inputClass} w-full py-2`} value={panel} onChange={(e) => setPanel(e.target.value)}>
          {panels.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Spend at most, per run ($)" hint="Leave empty to start from each plan's high estimate.">
        <input className={`${inputClass} tnum w-40 py-2`} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="0.50" />
      </Field>
      <Field label="Spend at most on drafting a plan ($)" hint="Up to $1.00.">
        <input className={`${inputClass} tnum w-40 py-2`} inputMode="decimal" value={planCap} onChange={(e) => setPlanCap(e.target.value)} />
      </Field>
      {a.error && <ErrorNote>{a.error}</ErrorNote>}
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={a.busy}>
          Save defaults
        </Button>
        <Saved text={a.done} />
      </div>
    </form>
  );
}

function DeleteAccount() {
  const router = useRouter();
  const { refresh } = useSession();
  const [password, setPassword] = useState("");
  const a = useAction();
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void a.run(async () => {
          if (!window.confirm("Delete your account, runs, saved trees and stored keys? This can't be undone.")) return;
          await post("/api/me/delete", { password });
          await refresh();
          router.replace("/");
        });
      }}
    >
      <Field label="Your password">
        <input className={`${inputClass} w-full py-2`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      {a.error && <ErrorNote>{a.error}</ErrorNote>}
      <div>
        <Button tone="danger" type="submit" disabled={a.busy}>
          Delete my account
        </Button>
      </div>
    </form>
  );
}

const SECTIONS = [
  ["profile", "Profile"],
  ["password", "Password"],
  ["keys", "API keys"],
  ["defaults", "Defaults"],
  ["delete", "Delete account"],
] as const;

export default function SettingsPage() {
  const me = useMe();
  const loaded = Boolean(me);
  // The page renders once the account has loaded, so jump to #section then.
  useEffect(() => {
    if (loaded && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [loaded]);
  if (!me) return null;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl gap-14 px-6 pt-12 pb-24">
        <nav className="sticky top-12 hidden h-fit w-40 shrink-0 flex-col gap-2 md:flex" aria-label="Settings sections">
          <h1 className="mb-3 text-[26px] font-bold tracking-[-0.02em]">Settings</h1>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="text-[14px] text-ink-soft hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <h1 className="mb-6 text-[26px] font-bold tracking-[-0.02em] md:hidden">Settings</h1>
          <Section id="profile" title="Profile">
            <Profile me={me} />
          </Section>
          <Section id="password" title="Password">
            <Password />
          </Section>
          <Section
            id="keys"
            title="API keys"
            intro="orch runs on your own OpenRouter key, so you're billed by OpenRouter directly. The key is encrypted before it's stored, used only while a call is being made, and never shown again."
          >
            <Keys me={me} />
          </Section>
          <Section id="defaults" title="Defaults">
            <Defaults me={me} />
          </Section>
          <Section id="delete" title="Delete account" intro="Deletes your account, your runs, your saved trees and the stored copy of your key. Your key itself stays valid on OpenRouter until you revoke it there.">
            <DeleteAccount />
          </Section>
        </div>
      </div>
    </div>
  );
}
