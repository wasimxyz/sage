import { type Editor, useTiptap, useTiptapState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BoldIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  StrikethroughIcon,
  TextQuoteIcon,
  UnderlineIcon,
} from "lucide-react";
import { type ComponentProps, useCallback } from "react";
import { Hint } from "@/components/hint";
import { panelIconHoverClass } from "@/components/panel-icon-button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const markNames = ["bold", "italic", "strike", "underline"] as const;
const idleFormatting: FormattingState = {
  block: "paragraph",
  bold: false,
  italic: false,
  strike: false,
  underline: false,
};

type MarkName = (typeof markNames)[number];
type BlockName =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "bullet"
  | "ordered";

interface FormattingState {
  block: BlockName;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
}

function readBlock(editor: Editor): BlockName {
  if (editor.isActive("heading", { level: 1 })) {
    return "h1";
  }
  if (editor.isActive("heading", { level: 2 })) {
    return "h2";
  }
  if (editor.isActive("heading", { level: 3 })) {
    return "h3";
  }
  if (editor.isActive("blockquote")) {
    return "quote";
  }
  if (editor.isActive("bulletList")) {
    return "bullet";
  }
  if (editor.isActive("orderedList")) {
    return "ordered";
  }
  return "paragraph";
}

function readFormatting(editor: Editor | null): FormattingState {
  if (!editor || editor.isDestroyed) {
    return idleFormatting;
  }
  return {
    block: readBlock(editor),
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    underline: editor.isActive("underline"),
  };
}

function sameFormatting(
  current: FormattingState,
  previous: FormattingState | null
): boolean {
  return (
    previous !== null &&
    current.bold === previous.bold &&
    current.italic === previous.italic &&
    current.strike === previous.strike &&
    current.underline === previous.underline &&
    current.block === previous.block
  );
}

function applyBlock(editor: Editor, block: BlockName) {
  const chain = editor.chain().focus();
  if (block === "paragraph") {
    if (editor.isActive("bulletList")) {
      chain.toggleBulletList().run();
      return;
    }
    if (editor.isActive("orderedList")) {
      chain.toggleOrderedList().run();
      return;
    }
    if (editor.isActive("blockquote")) {
      chain.toggleBlockquote().run();
      return;
    }
    chain.setParagraph().run();
    return;
  }
  if (block === "h1") {
    chain.toggleHeading({ level: 1 }).run();
    return;
  }
  if (block === "h2") {
    chain.toggleHeading({ level: 2 }).run();
    return;
  }
  if (block === "h3") {
    chain.toggleHeading({ level: 3 }).run();
    return;
  }
  if (block === "quote") {
    chain.toggleBlockquote().run();
    return;
  }
  if (block === "bullet") {
    chain.toggleBulletList().run();
    return;
  }
  chain.toggleOrderedList().run();
}

function appendMenuToBody() {
  return document.body;
}

function applyMark(editor: Editor, mark: MarkName) {
  const chain = editor.chain().focus();
  if (mark === "bold") {
    chain.toggleBold().run();
    return;
  }
  if (mark === "italic") {
    chain.toggleItalic().run();
    return;
  }
  if (mark === "strike") {
    chain.toggleStrike().run();
    return;
  }
  chain.toggleUnderline().run();
}

// Same hover as the editor's header buttons. A toggle that is on sits a
// step darker, hovered or not.
function FormatToggle({
  "aria-label": label,
  className,
  shortcut,
  ...props
}: ComponentProps<typeof ToggleGroupItem> & {
  "aria-label": string;
  shortcut: string;
}) {
  return (
    <Hint label={label} shortcut={shortcut}>
      <ToggleGroupItem
        aria-label={label}
        className={cn(
          panelIconHoverClass,
          "aria-pressed:bg-foreground/15 aria-pressed:hover:bg-foreground/15",
          className
        )}
        {...props}
      />
    </Hint>
  );
}

function MarkToggles({ formatting }: { formatting: FormattingState }) {
  const { editor } = useTiptap();
  const value = markNames.filter((mark) => formatting[mark]);

  const handleValueChange = useCallback(
    (next: string[]) => {
      const nextSet = new Set(next);
      for (const mark of markNames) {
        if (nextSet.has(mark) !== formatting[mark]) {
          applyMark(editor, mark);
        }
      }
    },
    [editor, formatting]
  );

  return (
    <ToggleGroup
      multiple
      onValueChange={handleValueChange}
      size="sm"
      value={value}
    >
      <FormatToggle aria-label="Bold" shortcut={shortcuts.bold} value="bold">
        <BoldIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Italic"
        shortcut={shortcuts.italic}
        value="italic"
      >
        <ItalicIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Underline"
        shortcut={shortcuts.underline}
        value="underline"
      >
        <UnderlineIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Strikethrough"
        shortcut={shortcuts.strikethrough}
        value="strike"
      >
        <StrikethroughIcon />
      </FormatToggle>
    </ToggleGroup>
  );
}

function BlockToggles({ formatting }: { formatting: FormattingState }) {
  const { editor } = useTiptap();

  const handleValueChange = useCallback(
    (next: string[]) => {
      const nextBlock = (next[0] as BlockName | undefined) ?? "paragraph";
      applyBlock(editor, nextBlock);
    },
    [editor]
  );

  return (
    <ToggleGroup
      onValueChange={handleValueChange}
      size="sm"
      value={[formatting.block]}
    >
      <FormatToggle
        aria-label="Paragraph"
        shortcut={shortcuts.paragraph}
        value="paragraph"
      >
        <PilcrowIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Heading 1"
        shortcut={shortcuts.heading1}
        value="h1"
      >
        <Heading1Icon className="size-4" />
      </FormatToggle>
      <FormatToggle
        aria-label="Heading 2"
        shortcut={shortcuts.heading2}
        value="h2"
      >
        <Heading2Icon className="size-4" />
      </FormatToggle>
      <FormatToggle
        aria-label="Heading 3"
        shortcut={shortcuts.heading3}
        value="h3"
      >
        <Heading3Icon className="size-4" />
      </FormatToggle>
      <FormatToggle aria-label="Quote" shortcut={shortcuts.quote} value="quote">
        <TextQuoteIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Bullet list"
        shortcut={shortcuts.bulletList}
        value="bullet"
      >
        <ListIcon />
      </FormatToggle>
      <FormatToggle
        aria-label="Numbered list"
        shortcut={shortcuts.orderedList}
        value="ordered"
      >
        <ListOrderedIcon />
      </FormatToggle>
    </ToggleGroup>
  );
}

export function EditorBubbleMenu() {
  const formatting = useTiptapState(
    (state) => readFormatting(state.editor),
    sameFormatting
  );

  return (
    <BubbleMenu
      appendTo={appendMenuToBody}
      className="z-50 flex items-center rounded-lg border bg-popover p-1 shadow-md"
    >
      <MarkToggles formatting={formatting} />
      <Separator className="mx-1 h-6" orientation="vertical" />
      <BlockToggles formatting={formatting} />
    </BubbleMenu>
  );
}
