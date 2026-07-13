import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkBreaks from "remark-breaks";

const allowedElements = [
  "blockquote",
  "br",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
] as const;

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-content-primary">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded-sm bg-surface-elevated ui-text-body-sm font-mono ui-color-primary">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-surface-elevated p-2 ui-text-body-sm [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l border-border-secondary pl-3 ui-color-secondary">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc list-outside space-y-0.5 pl-4 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal list-outside space-y-0.5 pl-8 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="ui-text-body pl-0.5">{children}</li>,
};

interface TranscriptMarkdownProps {
  text: string;
  rehypePlugins?: Options["rehypePlugins"];
  skipHtml?: boolean;
}

export default function TranscriptMarkdown({
  text,
  rehypePlugins,
  skipHtml,
}: TranscriptMarkdownProps) {
  return (
    <ReactMarkdown
      allowedElements={allowedElements}
      components={components}
      rehypePlugins={rehypePlugins}
      remarkPlugins={[remarkBreaks]}
      skipHtml={skipHtml}
    >
      {text}
    </ReactMarkdown>
  );
}
