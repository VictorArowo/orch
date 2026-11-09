"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link href={href} className={`text-[14px] ${active ? "text-ink" : "text-graphite hover:text-ink"}`} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}

function AccountMenu({ label, email }: { label: string; email: string }) {
  const { signOut } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex size-8 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-paper"
        title={email}
      >
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-50 w-60 rounded-[6px] border border-rule bg-sheet py-1.5 shadow-[0_8px_24px_-12px_rgba(23,25,30,0.25)]">
          <div className="truncate px-3.5 pt-1 pb-2 text-[13px] text-graphite">{email}</div>
          <Link role="menuitem" href="/settings" onClick={() => setOpen(false)} className="block px-3.5 py-1.5 text-[14px] hover:bg-paper">
            Settings
          </Link>
          <Link role="menuitem" href="/settings#keys" onClick={() => setOpen(false)} className="block px-3.5 py-1.5 text-[14px] hover:bg-paper">
            API keys
          </Link>
          <button
            role="menuitem"
            className="block w-full px-3.5 py-1.5 text-left text-[14px] hover:bg-paper"
            onClick={async () => {
              setOpen(false);
              await signOut();
              router.push("/");
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { session } = useSession();
  const me = session.status === "signed-in" ? session.me : undefined;
  const initials = me ? (me.user.name || me.user.email).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "";
  return (
    <header className="flex h-14 shrink-0 items-center gap-7 px-5">
      <Link href="/" className="text-[18px] font-bold tracking-tight text-ink">
        orch
      </Link>
      {me && (
        <nav className="flex gap-5">
          <NavLink href="/">New goal</NavLink>
          <NavLink href="/runs">Runs</NavLink>
          <NavLink href="/trees">Saved trees</NavLink>
        </nav>
      )}
      <div className="ml-auto flex items-center gap-4">
        {me && me.gateway === "openrouter" && !me.keys.some((k) => k.provider === "openrouter") && (
          <Link href="/settings#keys" className="note text-[13px] text-red hover:underline">
            Connect an OpenRouter key to run anything
          </Link>
        )}
        {me ? (
          <AccountMenu label={initials} email={me.user.email} />
        ) : session.status === "signed-out" ? (
          <>
            <Link href="/signin" className="text-[14px] text-ink-soft hover:text-ink">
              Sign in
            </Link>
            <Link href="/signup" className="inline-flex h-8 items-center rounded-[5px] bg-ink px-3 text-[14px] font-medium text-paper hover:bg-ink-soft">
              Create an account
            </Link>
          </>
        ) : null}
      </div>
    </header>
  );
}
