import { Markdown } from "@tiptap/markdown";
import { Selection } from "@tiptap/pm/state";
import { Tiptap, useEditor, useTiptap } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeftIcon,
  ChevronsRightIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
} from "react";
import { toast } from "sonner";
import { parseStoredDoc, plainTextToTiptap } from "@/bridge";
import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { EditorBubbleMenu } from "@/components/editor-bubble-menu";
import { NoUnderlineShortcut } from "@/components/editor-no-underline";
import { EditorSkeleton } from "@/components/editor-skeleton";
import { EntryDateLine } from "@/components/entry-date-line";
import { Hint } from "@/components/hint";
import { useEntry, useJournal } from "@/components/journal-context";
import {
  PanelIconButton,
  panelIconHoverClass,
} from "@/components/panel-icon-button";
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
import { Toggle } from "@/components/ui/toggle";
import { readingColumnClass } from "@/lib/page-column";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const extensions = [
  StarterKit.configure({
    link: {
      openOnClick: false,
    },
  }),
  Markdown,
  NoUnderlineShortcut,
];
const emptyDoc = { content: [{ type: "paragraph" }], type: "doc" as const };

// Focus mode puts the header buttons under the titlebar toggle. The padding
// follows the sidebar's slide, full when it is closed and none when it is
// open. It sits on the header alone, so the text column stays centered in the
// window.
const collapsedLeadingClass =
  "pl-[calc(1.5rem+(var(--titlebar-leading)+2.75rem)*(1-var(--sidebar-progress,1)))]";

function EditorFrame({ children }: { children: ReactNode }) {
  const {
    actions: { registerEditor, scheduleSave },
  } = useEntry();

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
        if (entry.format === "markdown") {
          if (entry.body.trim().length === 0) {
            editor.commands.setContent(emptyDoc, { emitUpdate: false });
            return;
          }
          try {
            editor.commands.setContent(entry.body, {
              contentType: "markdown",
              emitUpdate: false,
            });
          } catch {
            editor.commands.setContent(plainTextToTiptap(entry.body), {
              emitUpdate: false,
            });
          }
          return;
        }
        editor.commands.setContent(parseStoredDoc(entry), {
          emitUpdate: false,
        });
      },
      resetDraft: () => {
        if (editor.isDestroyed) {
          return;
        }
        editor.commands.setContent(emptyDoc, { emitUpdate: false });
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
  const {
    state: { expanded },
  } = useJournal();
  return (
    <div
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 px-6",
        expanded && collapsedLeadingClass
      )}
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      <div className="flex items-center">
        {expanded ? (
          <BackToJournalButton />
        ) : (
          <>
            <ClosePanelButton />
            <ExpandToggle />
          </>
        )}
      </div>
      <EntryMenu />
    </div>
  );
}

function useCloseEntry() {
  const {
    actions: { setDetailOpen },
  } = useJournal();
  return useCallback(() => {
    setDetailOpen(false);
  }, [setDetailOpen]);
}

function ClosePanelButton() {
  const closeEntry = useCloseEntry();
  return (
    <Hint label="Close entry" shortcut={shortcuts.closeEntry}>
      <PanelIconButton
        aria-keyshortcuts="Meta+Alt+B"
        aria-label="Close entry"
        onClick={closeEntry}
      >
        <ChevronsRightIcon className="size-4.5" />
      </PanelIconButton>
    </Hint>
  );
}

// Back leaves full screen and keeps the entry open. The list slides back in
// beside it, to the split the owner last chose.
function BackToJournalButton() {
  const {
    actions: { setExpanded },
  } = useJournal();
  const showList = useCallback(() => {
    setExpanded(false);
  }, [setExpanded]);
  return (
    <Hint label="Back to journal">
      <PanelIconButton aria-label="Back to journal" onClick={showList}>
        <ArrowLeftIcon />
      </PanelIconButton>
    </Hint>
  );
}

function ExpandToggle() {
  const {
    actions: { setExpanded },
  } = useJournal();
  return (
    <Hint label="Full screen">
      <Toggle
        aria-label="Full screen"
        className={cn("px-0", panelIconHoverClass)}
        onPressedChange={setExpanded}
        size="sm"
      >
        <Maximize2Icon />
      </Toggle>
    </Hint>
  );
}

function EntryMenu() {
  const {
    actions: { deleteOpenEntry },
  } = useEntry();
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
    state: { date, title, updatedAt },
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
  const {
    state: { loading },
  } = useEntry();

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
  const {
    actions: { flush },
  } = useEntry();
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
  } = useJournal();
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
