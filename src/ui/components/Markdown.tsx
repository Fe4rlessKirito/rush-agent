import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownProps {
  children: string;
}

/**
 * Renders chat message text as GitHub-flavored Markdown:
 * headings, bold/italic, lists, tables, blockquotes, links,
 * inline code, and syntax-highlighted fenced code blocks.
 *
 * Streaming-safe: react-markdown re-parses on each chunk, so partial
 * markdown (an unclosed ``` fence, a half-written list) renders as
 * plain text until it completes, then snaps into formatting.
 */
function MarkdownImpl({ children }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Open links in a new tab; never let chat content hijack the app window.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
