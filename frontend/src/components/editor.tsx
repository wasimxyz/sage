import { Markdown } from "@tiptap/markdown";
import { Tiptap, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeftIcon,
  CheckIcon,
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
  useLayoutEffect,
  useRef,
} from "react";
import { parseStoredDoc, plainTextToTiptap } from "@/bridge";
import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { EditorBubbleMenu } from "@/components/editor-bubble-menu";
import { EditorSkeleton } from "@/components/editor-skeleton";
import { EntryDateLine } from "@/components/entry-date-line";
import {
  generatingLabel,
  useEntry,
  useJournal,
} from "@/components/journal-context";
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
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

const extensions = [
  StarterKit.configure({
    link: {
      openOnClick: false,
    },
  }),
  Markdown,
];
const emptyDoc = { content: [{ type: "paragraph" }], type: "doc" as const };

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
      className="flex h-(--titlebar-height) shrink-0 items-center gap-2 px-6"
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
      <SaveStatus />
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
    <PanelIconButton
      aria-keyshortcuts="Meta+Alt+B"
      aria-label="Close entry"
      onClick={closeEntry}
    >
      <ChevronsRightIcon className="size-4.5" />
    </PanelIconButton>
  );
}

function BackToJournalButton() {
  const closeEntry = useCloseEntry();
  return (
    <PanelIconButton aria-label="Back to journal" onClick={closeEntry}>
      <ArrowLeftIcon />
    </PanelIconButton>
  );
}

function ExpandToggle() {
  const {
    actions: { setExpanded },
  } = useJournal();
  return (
    <Toggle
      aria-label="Full screen"
      className={cn("px-0", panelIconHoverClass)}
      onPressedChange={setExpanded}
      size="sm"
    >
      <Maximize2Icon />
    </Toggle>
  );
}

function EntryMenu() {
  const {
    actions: { openDelete },
  } = useEntry();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button aria-label="Entry actions" size="icon-sm" variant="ghost" />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={openDelete} variant="destructive">
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SaveStatus() {
  const {
    state: { saveLabel },
  } = useEntry();
  let icon: ReactNode = null;
  if (saveLabel === "Saving" || saveLabel === generatingLabel) {
    icon = <Spinner />;
  } else if (saveLabel === "Saved") {
    icon = <CheckIcon />;
  }
  return (
    <span
      aria-live="polite"
      className="ml-auto flex items-center gap-1.5 text-muted-foreground text-sm"
      data-slot="save-status"
    >
      {icon}
      {saveLabel}
    </span>
  );
}

function fitTitleField(field: HTMLTextAreaElement, value: string) {
  field.value = value;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

function EditorTitle() {
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    actions: { changeTitle },
    state: { date, title, updatedAt },
  } = useEntry();

  useLayoutEffect(() => {
    const field = titleRef.current;
    if (field === null) {
      return;
    }
    fitTitleField(field, title);
    const onResize = () => {
      fitTitleField(field, title);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [title]);

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
            <textarea
              className="field-sizing-content w-full resize-none overflow-hidden break-words bg-transparent font-semibold text-2xl outline-none placeholder:text-muted-foreground"
              data-slot="entry-title"
              id="entry-title"
              onChange={handleTitleChange}
              onKeyDown={handleTitleKeyDown}
              placeholder="Untitled"
              ref={titleRef}
              rows={1}
              value={title}
            />
          </Field>
          <p className="text-muted-foreground text-sm">
            <EntryDateLine date={date} updatedAt={updatedAt} />
          </p>
        </FieldGroup>
      </EditorColumn>
    </div>
  );
}

function EditorBody() {
  const {
    state: { loading },
  } = useEntry();
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
    <EditorColumn className="py-3">
      <Tiptap.Content />
      <EditorBubbleMenu />
    </EditorColumn>
  );
}

function EditorColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      {children}
    </div>
  );
}

export const Editor = {
  Body: EditorBody,
  Frame: EditorFrame,
  Header: EditorHeader,
  Skeleton: EditorSkeleton,
  Title: EditorTitle,
};

export default function EditorPane() {
  const {
    state: { expanded },
  } = useJournal();
  return (
    <Editor.Frame>
      <Editor.Header />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(expanded && "py-8.5")}>
          <Editor.Title />
          <Editor.Body />
        </div>
      </ScrollArea>
    </Editor.Frame>
  );
}
