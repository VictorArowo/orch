import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output, set as a page of the score: readable prose, tight tables.
// Raw HTML in a model's reply is never rendered.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md text-[14px] leading-relaxed text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {text || "_(empty)_"}
      </ReactMarkdown>
    </div>
  );
}
