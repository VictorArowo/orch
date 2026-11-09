import { Suspense } from "react";
import { Editor } from "@/components/Editor";

export default function EditPage() {
  return (
    <Suspense fallback={<div className="p-10 text-[13px] text-faint">Loading…</div>}>
      <Editor />
    </Suspense>
  );
}
