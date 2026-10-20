import { Markdown } from "@tiptap/markdown";
import { Selection } from "@tiptap/pm/state";
import { Tiptap, useEditor, useTiptap } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
} from "react";
import { toast } from "sonner";
import { EditorBubbleMenu } from "@/components/editor-bubble-menu";
import { EditorSkeleton } from "@/components/editor-skeleton";
import { EntryDateLine } from "@/components/entry-date-line";
import {
  useEntry,
  useEntryActions,
  useEntryLoading,
} from "@/components/journal-context";
import { SplitView, useSplitView } from "@/components/split-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  emptyDoc,
  loadBlankContent,
  loadEntryContent,
} from "@/lib/editor-content";
import { readingColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

const extensions = [
  StarterKit.configure({
    link: {
      openOnClick: false,
    },
  }),
  Markdown,
];

function EditorFrame({ children }: { children: ReactNode }) {
  const { registerEditor, scheduleSave } = useEntryActions();

  const editor = useEditor({
    content: emptyDoc,
    editorProps: {
      attributes: {
        class: "tiptap",
      },
      // A journal link must not replace this page. Packaged Sage only
      // trusts zero://app inside the window.
      handleDOMEvents: {
        click: (_view, event) => {
          const { target } = event;
          if (!(target instanceof Element)) {
            return false;
          }
          if (target.closest("a") === null) {
            return false;
          }
          event.preventDefault();
          return false;
        },
      },
    },
    extensions,
    shouldRerenderOnTransaction: false,
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      registerEditor(null);
      return;
    }
    registerEditor({
      getBody: () => editor.getMarkdown(),
      getText: () => editor.getText(),
      isReady: () => !editor.isDestroyed,
      loadDoc: (entry) => {
        if (editor.isDestroyed) {
          return;
        }
        loadEntryContent(editor, entry);
      },
      resetDraft: () => {
        if (editor.isDestroyed) {
          return;
        }
        loadBlankContent(editor);
        editor.commands.focus("end");
      },
    });
    const onUpdate = () => scheduleSave();
    editor.on("update", onUpdate);
    return () => {
      if (!editor.isDestroyed) {
        editor.off("update", onUpdate);
      }
      registerEditor(null);
    };
  }, [editor, registerEditor, scheduleSave]);

  if (!editor || editor.isDestroyed) {
    return <EditorSkeleton />;
  }

  return (
    <Tiptap editor={editor}>
      <div className="flex h-full min-h-0 flex-col">{children}</div>
    </Tiptap>
  );
}

function EditorHeader() {
  return (
    <SplitView.DetailHeader>
      <SplitView.PanelControls
        backLabel="Back to journal"
        closeLabel="Close entry"
      />
      <EntryMenu />
    </SplitView.DetailHeader>
  );
}

function EntryMenu() {
  const { deleteOpenEntry } = useEntryActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Entry actions"
            className="ml-auto"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={deleteOpenEntry} variant="destructive">
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditorTitle() {
  const {
    actions: { changeTitle },
    state: { date, loading, title, updatedAt },
  } = useEntry();

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      changeTitle(event.currentTarget.value.replaceAll("\n", " "));
    },
    [changeTitle]
  );

  const handleTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    },
    []
  );

  return (
    <div className="pb-2">
      <EditorColumn>
        <FieldGroup className="gap-1">
          <Field>
            <FieldLabel className="sr-only" htmlFor="entry-title">
              Title
            </FieldLabel>
            <div
              className="font-semibold text-2xl leading-tight"
              data-slot="entry-title-sizer"
              data-value={title}
            >
              <textarea
                className="resize-none overflow-hidden placeholder:text-muted-foreground"
                data-slot="entry-title"
                id="entry-title"
                onChange={handleTitleChange}
                onKeyDown={handleTitleKeyDown}
                placeholder="Untitled"
                readOnly={loading}
                rows={1}
                value={title}
              />
            </div>
          </Field>
          <p className="text-muted-foreground text-sm">
            <EntryDateLine date={date} updatedAt={updatedAt} />
          </p>
        </FieldGroup>
      </EditorColumn>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function EditorBody() {
  const { editor } = useTiptap();
  const loading = useEntryLoading();

  // The text ends well before the pane does. A click on the empty page around
  // it would land on the scroll area, take focus from the editor, and hide the
  // caret. Put the caret at the nearest text instead, like a click in the text.
  const pageRef = useCallback(
    (page: HTMLDivElement | null) => {
      if (page === null) {
        return;
      }
      const onMouseDown = (event: MouseEvent) => {
        const { target } = event;
        if (
          event.button !== 0 ||
          !(target instanceof Node) ||
          editor.view.dom.contains(target)
        ) {
          return;
        }
        event.preventDefault();
        const { state, view } = editor;
        const box = view.dom.getBoundingClientRect();
        const found = view.posAtCoords({
          left: clamp(event.clientX, box.left + 1, box.right - 1),
          top: clamp(event.clientY, box.top + 1, box.bottom - 1),
        });
        if (found === null) {
          editor.commands.focus("end");
          return;
        }
        view.dispatch(
          state.tr.setSelection(Selection.near(state.doc.resolve(found.pos)))
        );
        view.focus();
      };
      page.addEventListener("mousedown", onMouseDown);
      return () => {
        page.removeEventListener("mousedown", onMouseDown);
      };
    },
    [editor]
  );

  if (loading) {
    return (
      <EditorColumn className="flex flex-col gap-3 py-3">
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-3/4" />
      </EditorColumn>
    );
  }
  return (
    <div className="flex-1 cursor-text" ref={pageRef}>
      <EditorColumn className="pt-3 pb-32">
        <Tiptap.Content />
        <EditorBubbleMenu />
      </EditorColumn>
    </div>
  );
}

function EditorColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(readingColumnClass, className)}>{children}</div>;
}

export const Editor = {
  Body: EditorBody,
  Frame: EditorFrame,
  Header: EditorHeader,
  Skeleton: EditorSkeleton,
  Title: EditorTitle,
};

// Cmd+S saves at once, then says Sage saves on its own. The toast id keeps
// repeated presses to one toast.
function useSaveShortcut() {
  const { flush } = useEntryActions();
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (
        event.code !== "KeyS" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      flush()
        .then((saved) => {
          if (saved) {
            toast("Sage saves your entry automatically.", {
              id: "entry-autosave",
            });
          }
        })
        .catch(() => undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [flush]);
}

export default function EditorPane() {
  const {
    state: { expanded },
  } = useSplitView();
  useSaveShortcut();
  return (
    <Editor.Frame>
      <Editor.Header />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex min-h-full flex-col", expanded && "py-8.5")}>
          <Editor.Title />
          <Editor.Body />
        </div>
      </ScrollArea>
    </Editor.Frame>
  );
}
