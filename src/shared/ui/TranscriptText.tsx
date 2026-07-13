import { lazy, memo, Suspense } from "react";
import TranscriptMarkdown from "./TranscriptMarkdown";

interface TranscriptTextProps {
  text: string;
}

const TranscriptHtmlText = lazy(() => import("./TranscriptHtmlText"));
const rawHtmlPattern = /<\/?[a-z][^>]*>/i;

function TranscriptText({ text }: TranscriptTextProps) {
  if (!rawHtmlPattern.test(text)) return <TranscriptMarkdown text={text} />;

  return (
    <Suspense fallback={<TranscriptMarkdown text={text} skipHtml />}>
      <TranscriptHtmlText text={text} />
    </Suspense>
  );
}

export default memo(TranscriptText);
