import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import TranscriptMarkdown from "./TranscriptMarkdown";

export default function TranscriptHtmlText({ text }: { text: string }) {
  return (
    <TranscriptMarkdown
      text={text}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
    />
  );
}
