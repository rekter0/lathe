import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll" role="region" aria-label="Scrollable Markdown table" tabIndex={0}><table {...props} /></div>
};

export function RenderedMarkdown({ text }: { text: string }) {
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>{text}</ReactMarkdown>;
}
