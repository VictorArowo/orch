"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useMe } from "@/lib/session";

interface SavedTree {
  id: string;
  goal: string;
  updatedAt: string;
}

export default function TreesPage() {
  const me = useMe();
  const [trees, setTrees] = useState<SavedTree[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (me) get<SavedTree[]>("/api/trees").then(setTrees, (e: Error) => setError(e.message));
  }, [me]);
  if (!me) return null;

  async function remove(t: SavedTree) {
    if (!window.confirm(`Delete the saved tree "${t.goal}"? Runs made from it are kept.`)) return;
    try {
      await post(`/api/trees/${t.id}/delete`, {});
      setTrees((all) => all?.filter((x) => x.id !== t.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const panel = me.user.settings.defaultPanel ?? "starter";
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 pt-12 pb-24">
        <h1 className="text-[26px] font-bold tracking-[-0.02em]">Saved trees</h1>
        {error && <ErrorNote>{error}</ErrorNote>}
        {trees?.length === 0 && (
          <p className="note text-[15px] text-graphite">
            Nothing saved yet. Draft a plan, shape it in the editor and press Save tree to keep it here.
          </p>
        )}
        <ul className="flex flex-col">
          {trees?.map((t) => (
            <li key={t.id} className="flex items-baseline gap-4 border-b border-rule py-3">
              <Link href={`/edit?saved=${t.id}&panel=${panel}`} className="line-clamp-1 flex-1 text-[15px] text-ink hover:underline">
                {t.goal}
              </Link>
              <span className="text-[13px] text-graphite">
                {new Date(t.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
              </span>
              <button className="text-[13px] text-red hover:underline" onClick={() => void remove(t)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
