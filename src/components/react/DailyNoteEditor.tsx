import { useEffect, useRef } from "react";
import { InputRule, Node, type Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { Lexer, Marked, marked, type Token } from "marked";

function preserveSource(token: Token) {
  if (token.type === "html") {
    Object.assign(token, { type: token.block ? "noteSourceBlock" : "noteSourceInline" });
  } else if (token.type === "image") {
    // Resolve reference images before their definitions disappear from the token stream.
    const alt = String(token.text).replace(/[\\[\]]/g, "\\$&");
    const href = String(token.href).replace(/>/g, "%3E");
    const title = token.title ? ` "${String(token.title).replace(/[\\"]/g, "\\$&")}"` : "";
    Object.assign(token, { type: "noteSourceInline", raw: `![${alt}](<${href}>${title})` });
  }
}

class NoteLexer<ParserOutput = string, RendererOutput = string> extends Lexer<
  ParserOutput,
  RendererOutput
> {
  lex(source: string) {
    const tokens = super.lex(source);
    marked.walkTokens(tokens, preserveSource);
    return tokens;
  }

  inlineTokens(source: string, tokens?: Token[]) {
    const result = super.inlineTokens(source, tokens);
    marked.walkTokens(result, preserveSource);
    return result;
  }
}

const noteMarked = new Marked({ gfm: true });
noteMarked.Lexer = NoteLexer;

// HTML and images stay editable source, never DOM or a network request.
const SourceInline = Node.create({
  name: "noteSourceInline",
  group: "inline",
  inline: true,
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'span[data-note-source="inline"]' }],
  renderHTML: () => ["span", { "data-note-source": "inline" }, 0],
  parseMarkdown: (token, helpers) =>
    helpers.createNode("noteSourceInline", {}, [helpers.createTextNode(token.raw || "")]),
  renderMarkdown: (node) => node.content?.map((child) => child.text || "").join("") || "",
});

const SourceBlock = Node.create({
  name: "noteSourceBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'pre[data-note-source="block"]', preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-note-source": "block" }, 0],
  parseMarkdown: (token, helpers) =>
    helpers.createNode("noteSourceBlock", {}, [helpers.createTextNode(token.raw || "")]),
  renderMarkdown: (node) => node.content?.map((child) => child.text || "").join("") || "",
});

const NoteTaskItem = TaskItem.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*(?:[-+*]\s)?\[([ xX])\]\s$/,
        handler: ({ range, match, chain }) => {
          // "- " has already become a bullet list when the checkbox marker arrives.
          const commands = chain().deleteRange(range);
          if (!this.editor.isActive("taskList")) commands.toggleTaskList();
          commands.updateAttributes(this.name, { checked: match[1].toLowerCase() === "x" }).run();
        },
      }),
    ];
  },
});

function safeLink(href: string) {
  if (!href.trim()) return false;
  try {
    const url = new URL(href, window.location.href);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

const EXTENSIONS = [
  StarterKit.configure({
    link: {
      openOnClick: false,
      isAllowedUri: (href, context) => context.defaultValidate(href) && safeLink(href),
      HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
    },
    trailingNode: false,
    // Underline has no Markdown representation; do not introduce lossy formatting.
    underline: false,
  }),
  TaskList,
  NoteTaskItem.configure({
    nested: true,
    a11y: { checkboxLabel: (node) => node.textContent || "Task" },
  }),
  TableKit,
  SourceInline,
  SourceBlock,
  // The extension accepts Marked instances at runtime but types only the callable singleton.
  Markdown.configure({ marked: noteMarked as unknown as typeof marked }),
];

interface DailyNoteEditorProps {
  text: string;
  date: string;
  onChange: (markdown: string) => void;
}

export default function DailyNoteEditor({ text, date, onChange }: DailyNoteEditorProps) {
  const received = useRef(text);
  const editor: Editor | null = useEditor({
    extensions: EXTENSIONS,
    content: text || `# ${date}\n\n`,
    contentType: "markdown",
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    autofocus: false,
    editorProps: {
      attributes: {
        class: "daily-note-editor",
        role: "textbox",
        "aria-label": "Daily note",
        "aria-multiline": "true",
        spellcheck: "true",
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (
            event.key !== "Escape" &&
            (event.metaKey || event.ctrlKey || event.key.startsWith("Arrow") || event.key === "Tab")
          ) {
            // Keep ProseMirror's keymaps running without invoking calendar shortcuts.
            event.stopPropagation();
          }
          return false;
        },
      },
      handleClick: (_view, _position, event) => {
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!(link instanceof HTMLAnchorElement)) return false;
        event.preventDefault();
        const href = link.getAttribute("href") || "";
        if ((event.metaKey || event.ctrlKey) && safeLink(href)) {
          window.open(link.href, "_blank", "noopener,noreferrer");
        }
        return false;
      },
      handlePaste: (view, event) => {
        const source = event.clipboardData?.getData("text/plain");
        event.preventDefault();
        if (!source) return true;
        if (view.state.selection.$from.parent.type.spec.code) {
          view.dispatch(view.state.tr.insertText(source));
        } else {
          editor?.commands.insertContent(source, { contentType: "markdown" });
        }
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        event.preventDefault();
        const source = event.dataTransfer?.getData("text/plain");
        const position = editor?.view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (source && position) {
          editor?.commands.insertContentAt(position.pos, source, { contentType: "markdown" });
        }
        return true;
      },
      clipboardTextSerializer: (slice) =>
        editor?.markdown?.serialize({ type: "doc", content: slice.content.toJSON() }) || "",
    },
    onUpdate: ({ editor: updated }) => {
      if (!updated.isInitialized) return;
      const markdown = updated.getMarkdown();
      received.current = markdown;
      onChange(markdown);
    },
  });

  useEffect(() => {
    if (!editor || text === received.current) return;
    received.current = text;
    const parsed = editor.markdown?.parse(text || `# ${date}\n\n`);
    if (!parsed) return;
    const doc = editor.schema.nodeFromJSON(parsed);
    if (doc.eq(editor.state.doc)) return;
    // Only an external replacement resets history; an autosave echo never resets the caret or undo.
    const position = Math.min(editor.state.selection.from, doc.content.size);
    editor.view.updateState(
      EditorState.create({
        schema: editor.schema,
        doc,
        plugins: editor.state.plugins,
        selection: TextSelection.near(doc.resolve(position)),
      }),
    );
  }, [editor, text, date]);

  return (
    <EditorContent
      editor={editor}
      className="h-full"
      onPointerDown={(event) => {
        if (!editor || event.button !== 0) return;
        if (event.target !== event.currentTarget && event.target !== editor.view.dom) return;
        event.preventDefault();
        event.stopPropagation();
        // Empty card space starts body text instead of leaving focus on the calendar.
        const last = editor.state.doc.lastChild;
        if (last?.type.name !== "paragraph" || last.content.size > 0) {
          editor
            .chain()
            .insertContentAt(editor.state.doc.content.size, { type: "paragraph" })
            .focus("end")
            .unsetAllMarks()
            .run();
        } else {
          editor.commands.focus("end");
        }
      }}
    />
  );
}
