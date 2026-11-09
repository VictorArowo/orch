"use client";

import { useParams } from "next/navigation";
import { RunView } from "@/components/RunView";
import { useMe } from "@/lib/session";

export default function RunPage() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  if (!me) return null;
  return <RunView key={id} runId={id} />;
}
