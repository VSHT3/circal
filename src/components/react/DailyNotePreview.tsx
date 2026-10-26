import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN_PLUGINS = [remarkGfm];

export default function DailyNotePreview({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed break-words [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-hairline [&_blockquote]:pl-3 [&_blockquote]:text-ink-2 [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:font-mono [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:border-hairline [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-surface-2 [&_pre]:p-2 [&_table]:w-full [&_td]:border [&_td]:border-hairline [&_td]:p-1 [&_th]:border [&_th]:border-hairline [&_th]:p-1 [&_ul]:list-disc [&_ul]:pl-5 [&>*+*]:mt-3">
      {text ? (
        <Markdown
          remarkPlugins={MARKDOWN_PLUGINS}
          components={{
            a: ({ href, children }) =>
              href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            // Notes never fetch a remote image just because they were opened.
            img: ({ alt }) => <span className="text-ink-2">[Image: {alt || "image"}]</span>,
          }}
        >
          {text}
        </Markdown>
      ) : (
        <p className="caption text-ink-3">No note for this day.</p>
      )}
    </div>
  );
}
